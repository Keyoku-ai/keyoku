import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  describeTool,
  executeSynthTool,
  loadSpec,
  parseSpec,
  type SynthSpec,
  type SynthTool,
} from "./openapi.js";
import type { Store } from "./store.js";
import type { Connector, ConnectorTransport } from "./types.js";

export interface ConnectorToolInfo {
  name: string;
  description?: string;
}

export interface ConnectorCallResult {
  /** All text content parts of the tool result, joined. */
  text: string;
  isError: boolean;
}

const REDACTED = "•••redacted•••";

/** Connector view safe to echo into agent context — secrets masked. */
export function redactConnector(connector: Connector): Connector {
  let transport: ConnectorTransport;
  switch (connector.transport.type) {
    case "stdio":
      transport = {
        ...connector.transport,
        ...(connector.transport.env
          ? {
              env: Object.fromEntries(
                Object.keys(connector.transport.env).map((k) => [k, REDACTED]),
              ),
            }
          : {}),
      };
      break;
    case "http":
      transport = {
        ...connector.transport,
        ...(connector.transport.headers
          ? {
              headers: Object.fromEntries(
                Object.keys(connector.transport.headers).map((k) => [k, REDACTED]),
              ),
            }
          : {}),
      };
      break;
    case "openapi": {
      const auth = connector.transport.auth;
      transport = {
        ...connector.transport,
        ...(auth && auth.kind !== "none"
          ? {
              auth:
                auth.kind === "bearer"
                  ? { kind: "bearer" as const, token: REDACTED }
                  : { kind: auth.kind, name: auth.name, value: REDACTED },
            }
          : {}),
      };
      break;
    }
  }
  return { ...connector, transport };
}

/**
 * Manages the context layer: MCP client connections (stdio / Streamable HTTP)
 * and OpenAPI-synthesized connectors (M3 — tools generated from a spec and
 * executed as plain HTTP calls). MCP clients connect lazily on first use; the
 * cache holds promises so concurrent probes share one connection instead of
 * racing to spawn several. Parsed OpenAPI specs are cached per connector.
 */
export class ConnectorManager {
  private clients = new Map<string, Promise<Client>>();
  private specs = new Map<string, Promise<SynthSpec>>();

  constructor(private store: Store) {}

  list(): Connector[] {
    return this.store.listConnectors();
  }

  get(name: string): Connector | undefined {
    return this.store.getConnector(name);
  }

  /**
   * Verify the connection FIRST, persist only on success — a failed add must
   * not register a broken connector or destroy a previously working config.
   * For openapi connectors, verification = fetch + parse the spec (sandboxed:
   * no API call is made against the target service).
   */
  async add(connector: Connector): Promise<{ tools: ConnectorToolInfo[]; warnings?: string[] }> {
    if (connector.transport.type === "openapi") {
      const spec = await this.loadSynthSpec(connector.name, connector.transport, true);
      const tools = this.synthTools(connector, spec).map(describeTool);
      if (tools.length === 0) {
        this.specs.delete(connector.name);
        throw new Error(
          `Spec parsed but produced no usable tools${connector.transport.allowMutating ? "" : " (read-only mode: only GET/HEAD operations are exposed; pass allowMutating to include the rest)"}.`,
        );
      }
      this.store.saveConnector(connector);
      return { tools, warnings: spec.warnings.length > 0 ? spec.warnings : undefined };
    }

    const client = await this.connect(connector.name, connector.transport);
    let tools: ConnectorToolInfo[];
    try {
      const result = await client.listTools();
      tools = result.tools.map((t) => ({ name: t.name, description: t.description }));
    } catch (err) {
      // The verification client was never tracked, so closing it can't evict a
      // healthy cached client for the same name.
      await client.close().catch(() => {});
      throw new Error(
        `Connector '${connector.name}' connected but listing tools failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.disconnect(connector.name); // drop any stale client for this name
    this.store.saveConnector(connector);
    this.track(connector.name, Promise.resolve(client));
    return { tools };
  }

  async remove(name: string): Promise<boolean> {
    await this.disconnect(name);
    this.specs.delete(name);
    return this.store.deleteConnector(name);
  }

  // ----- openapi (synthesized) connectors -----

  private loadSynthSpec(
    name: string,
    transport: Extract<ConnectorTransport, { type: "openapi" }>,
    fresh = false,
  ): Promise<SynthSpec> {
    if (!fresh) {
      const cached = this.specs.get(name);
      if (cached) return cached;
    }
    const pending = loadSpec(transport.specUrl)
      .then((raw) => parseSpec(raw))
      .catch((err) => {
        // Identity-checked: a stale rejecting load must not evict a newer
        // spec that a concurrent re-add already cached under this name.
        if (this.specs.get(name) === pending) this.specs.delete(name);
        throw new Error(
          `Failed to load/parse OpenAPI spec for connector '${name}': ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    this.specs.set(name, pending);
    return pending;
  }

  private synthTools(connector: Connector, spec: SynthSpec): SynthTool[] {
    const transport = connector.transport as Extract<ConnectorTransport, { type: "openapi" }>;
    return transport.allowMutating ? spec.tools : spec.tools.filter((t) => !t.mutating);
  }

  private synthBaseUrl(connector: Connector, spec: SynthSpec): string {
    const transport = connector.transport as Extract<ConnectorTransport, { type: "openapi" }>;
    const baseUrl = transport.baseUrl ?? spec.baseUrl;
    if (!baseUrl) {
      throw new Error(
        `Connector '${connector.name}' has no base URL: the spec declares no servers/host — re-add with an explicit baseUrl.`,
      );
    }
    return baseUrl;
  }

  // ----- shared surface -----

  private requireConnector(name: string): Connector {
    const connector = this.store.getConnector(name);
    if (!connector) {
      throw new Error(`Unknown connector '${name}'. Register it first with connector_add.`);
    }
    return connector;
  }

  async listTools(name: string): Promise<ConnectorToolInfo[]> {
    const connector = this.requireConnector(name);
    if (connector.transport.type === "openapi") {
      const spec = await this.loadSynthSpec(name, connector.transport);
      return this.synthTools(connector, spec).map(describeTool);
    }
    const client = await this.ensure(name);
    try {
      const result = await client.listTools();
      return result.tools.map((t) => ({ name: t.name, description: t.description }));
    } catch (err) {
      await this.disconnect(name);
      throw err;
    }
  }

  /**
   * Execute a tool on a connector, WITHOUT autonomy gating — gating belongs
   * to the caller (connector_call gates; approved ApprovalRequests and probes
   * come straight here).
   */
  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ConnectorCallResult> {
    const connector = this.requireConnector(name);

    if (connector.transport.type === "openapi") {
      const transport = connector.transport;
      const spec = await this.loadSynthSpec(name, transport);
      const synthTool = this.synthTools(connector, spec).find((t) => t.name === tool);
      if (!synthTool) {
        const available = this.synthTools(connector, spec).map((t) => t.name);
        throw new Error(
          `Connector '${name}' has no tool '${tool}'. Available: ${available.slice(0, 30).join(", ")}`,
        );
      }
      return executeSynthTool(synthTool, args, this.synthBaseUrl(connector, spec), transport.auth);
    }

    const client = await this.ensure(name);
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      // Drop the cached client so a dead transport reconnects next time.
      await this.disconnect(name);
      throw err;
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: string }).type === "text",
      )
      .map((part) => part.text)
      .join("\n");
    return { text, isError: result.isError === true };
  }

  // ----- MCP client lifecycle -----

  private buildTransport(transport: ConnectorTransport) {
    if (transport.type === "stdio") {
      return new StdioClientTransport({
        command: transport.command,
        args: transport.args ?? [],
        env: { ...getDefaultEnvironment(), ...(transport.env ?? {}) },
        stderr: "ignore",
      });
    }
    if (transport.type === "http") {
      return new StreamableHTTPClientTransport(new URL(transport.url), {
        requestInit: transport.headers ? { headers: transport.headers } : undefined,
      });
    }
    throw new Error("openapi connectors do not use an MCP transport");
  }

  private async connect(name: string, transport: ConnectorTransport): Promise<Client> {
    const client = new Client({ name: "keyoku-harness", version: "0.1.0" });
    try {
      await client.connect(this.buildTransport(transport));
    } catch (err) {
      throw new Error(
        `Failed to connect to connector '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return client;
  }

  /**
   * Cache a client promise under `name` with identity-checked self-eviction:
   * a dead transport (or a failed connect) only clears the cache slot if that
   * slot still holds THIS promise — a newer client registered for the same
   * name (concurrent re-add) is never evicted or orphaned by an old one.
   */
  private track(name: string, pending: Promise<Client>): Promise<Client> {
    this.clients.set(name, pending);
    pending.then(
      (client) => {
        client.onclose = () => {
          if (this.clients.get(name) === pending) this.clients.delete(name);
        };
      },
      () => {
        if (this.clients.get(name) === pending) this.clients.delete(name);
      },
    );
    return pending;
  }

  private ensure(name: string): Promise<Client> {
    const cached = this.clients.get(name);
    if (cached) return cached;
    const connector = this.requireConnector(name);
    return this.track(name, this.connect(name, connector.transport));
  }

  private async disconnect(name: string): Promise<void> {
    const pending = this.clients.get(name);
    if (!pending) return;
    this.clients.delete(name);
    try {
      const client = await pending;
      client.onclose = undefined;
      await client.close();
    } catch {
      // Already dead; nothing to clean up.
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((name) => this.disconnect(name)));
  }
}
