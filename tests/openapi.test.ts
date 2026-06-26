import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectorManager } from "../src/connectors.js";
import {
  buildRequest,
  describeTool,
  executeSynthTool,
  loadSpec,
  parseSpec,
  type SynthTool,
} from "../src/openapi.js";
import { Store } from "../src/store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openapi3 = {
  openapi: "3.0.3",
  info: { title: "Petstore", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    parameters: {
      PageParam: { name: "page", in: "query", required: false, description: "Page number" },
    },
  },
  paths: {
    "x-internal": { get: { operationId: "shouldBeSkipped" } },
    "/pets": {
      description: "a non-method path key that must be skipped",
      parameters: [{ name: "X-Tenant", in: "header", required: true }],
      get: {
        operationId: "list pets!",
        summary: "List pets",
        parameters: [
          { $ref: "#/components/parameters/PageParam" },
          { name: "limit", in: "query", required: true },
          { name: "session", in: "cookie" },
          { $ref: "#/components/parameters/DoesNotExist" },
        ],
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
      },
    },
    "/pets/{petId}": {
      get: {
        parameters: [{ name: "petId", in: "path" }],
      },
      delete: {
        operationId: "createPet",
        parameters: [{ name: "petId", in: "path", required: true }],
      },
    },
  },
};

const swagger2Yaml = `
swagger: "2.0"
info:
  title: Legacy API
  version: "1.0"
host: legacy.example.com
basePath: /api
schemes:
  - https
  - http
parameters:
  ApiVersion:
    name: api-version
    in: query
    required: true
paths:
  /things:
    get:
      operationId: listThings
      summary: List things
    post:
      operationId: addThing
      summary: Add a thing
      parameters:
        - name: thing
          in: body
          required: true
          schema:
            type: object
        - $ref: '#/parameters/ApiVersion'
`;

const byName = (spec: { tools: SynthTool[] }, name: string): SynthTool => {
  const tool = spec.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}; got ${spec.tools.map((t) => t.name).join(", ")}`);
  return tool;
};

// ---------------------------------------------------------------------------
// parseSpec — OpenAPI 3.x
// ---------------------------------------------------------------------------

describe("parseSpec (OpenAPI 3.x JSON)", () => {
  const spec = parseSpec(JSON.stringify(openapi3));

  it("extracts title and baseUrl from servers[0]", () => {
    expect(spec.title).toBe("Petstore");
    expect(spec.baseUrl).toBe("https://api.example.com/v1");
  });

  it("names tools from sanitized operationIds, falls back, and dedupes", () => {
    expect(spec.tools.map((t) => t.name)).toEqual([
      "list_pets_", // "list pets!" sanitized
      "createPet",
      "get_pets_petId", // missing operationId fallback
      "createPet_2", // duplicate operationId deduped
    ]);
    expect(spec.tools.map((t) => t.name).includes("shouldBeSkipped")).toBe(false);
  });

  it("always includes METHOD + path in descriptions", () => {
    expect(byName(spec, "list_pets_").description).toBe("List pets (GET /pets)");
    expect(byName(spec, "get_pets_petId").description).toBe("GET /pets/{petId}");
  });

  it("merges operation + path-item params, resolves local $refs, keeps path|query|header", () => {
    const params = byName(spec, "list_pets_").params;
    expect(params).toEqual([
      { name: "page", in: "query", required: false, description: "Page number" },
      { name: "limit", in: "query", required: true },
      { name: "X-Tenant", in: "header", required: true },
    ]);
    // Path-item params flow into siblings too.
    expect(byName(spec, "createPet").params).toEqual([
      { name: "X-Tenant", in: "header", required: true },
    ]);
    // Path params are required even when the spec omits the flag.
    expect(byName(spec, "get_pets_petId").params).toEqual([
      { name: "petId", in: "path", required: true },
    ]);
  });

  it("warns on cookie params and unresolvable $refs instead of failing", () => {
    expect(spec.warnings.some((w) => w.includes("cookie") && w.includes("session"))).toBe(true);
    expect(
      spec.warnings.some((w) => w.includes("#/components/parameters/DoesNotExist")),
    ).toBe(true);
  });

  it("sets hasBody from requestBody and mutating from the method", () => {
    expect(byName(spec, "createPet").hasBody).toBe(true);
    expect(byName(spec, "createPet").mutating).toBe(true);
    expect(byName(spec, "list_pets_").hasBody).toBe(false);
    expect(byName(spec, "list_pets_").mutating).toBe(false);
    expect(byName(spec, "createPet_2").mutating).toBe(true);
  });

  it("leaves baseUrl undefined with a warning when servers are missing", () => {
    const noServers = parseSpec(
      JSON.stringify({ ...openapi3, servers: undefined }),
    );
    expect(noServers.baseUrl).toBeUndefined();
    expect(noServers.warnings.some((w) => w.includes("no servers"))).toBe(true);
  });

  it("caps long operationIds at 128 chars", () => {
    const longId = "a".repeat(200);
    const doc = {
      openapi: "3.0.0",
      info: { title: "T" },
      servers: [{ url: "https://x" }],
      paths: { "/a": { get: { operationId: longId } } },
    };
    expect(parseSpec(JSON.stringify(doc)).tools[0].name).toBe("a".repeat(128));
  });

  it("throws helpfully on empty, unparseable, and unrecognized specs", () => {
    expect(() => parseSpec("")).toThrow(/did not parse to an object/);
    expect(() => parseSpec("{not json or yaml")).toThrow(/neither valid JSON nor valid YAML/);
    expect(() => parseSpec(JSON.stringify({ info: { title: "X" } }))).toThrow(/openapi.*swagger/i);
    expect(() =>
      parseSpec(JSON.stringify({ openapi: "3.0.0", info: { title: "Bare" }, servers: [{ url: "https://x" }], paths: {} })),
    ).toThrow(/no usable operations/);
  });
});

// ---------------------------------------------------------------------------
// parseSpec — Swagger 2
// ---------------------------------------------------------------------------

describe("parseSpec (Swagger 2 YAML)", () => {
  const spec = parseSpec(swagger2Yaml);

  it("builds baseUrl from schemes[0] + host + basePath", () => {
    expect(spec.title).toBe("Legacy API");
    expect(spec.baseUrl).toBe("https://legacy.example.com/api");
  });

  it("treats in:body params as hasBody and resolves #/parameters refs", () => {
    const add = byName(spec, "addThing");
    expect(add.hasBody).toBe(true);
    expect(add.mutating).toBe(true);
    expect(add.params).toEqual([{ name: "api-version", in: "query", required: true }]);
    const list = byName(spec, "listThings");
    expect(list.hasBody).toBe(false);
    expect(list.params).toEqual([]);
  });

  it("leaves baseUrl undefined with a warning when host is missing", () => {
    const noHost = parseSpec(swagger2Yaml.replace("host: legacy.example.com\n", ""));
    expect(noHost.baseUrl).toBeUndefined();
    expect(noHost.warnings.some((w) => w.includes("no host"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

const getPet: SynthTool = {
  name: "getPet",
  description: "GET /pets/{petId}",
  method: "get",
  pathTemplate: "/pets/{petId}",
  params: [
    { name: "petId", in: "path", required: true },
    { name: "verbose", in: "query", required: false },
    { name: "X-Tenant", in: "header", required: false },
  ],
  hasBody: false,
  mutating: false,
};

const createPet: SynthTool = {
  name: "createPet",
  description: "POST /pets",
  method: "post",
  pathTemplate: "/pets",
  params: [],
  hasBody: true,
  mutating: true,
};

describe("buildRequest", () => {
  it("substitutes and URI-encodes path params", () => {
    const req = buildRequest(getPet, { petId: "a b/c" }, "https://api.example.com");
    expect(req.url).toBe("https://api.example.com/pets/a%20b%2Fc");
    expect(req.method).toBe("GET");
  });

  it("joins trailing-slash baseUrl and leading-slash path cleanly", () => {
    const req = buildRequest(getPet, { petId: "1" }, "https://api.example.com/v1/");
    expect(req.url).toBe("https://api.example.com/v1/pets/1");
  });

  it("throws naming missing required args", () => {
    expect(() => buildRequest(getPet, {}, "https://x")).toThrow(/required path parameter 'petId'/);
    const strictQuery: SynthTool = {
      ...getPet,
      params: [
        { name: "petId", in: "path", required: true },
        { name: "limit", in: "query", required: true },
        { name: "X-Auth", in: "header", required: true },
      ],
    };
    expect(() => buildRequest(strictQuery, { petId: "1", "X-Auth": "t" }, "https://x")).toThrow(
      /required query parameter 'limit'/,
    );
    expect(() => buildRequest(strictQuery, { petId: "1", limit: 5 }, "https://x")).toThrow(
      /required header parameter 'X-Auth'/,
    );
  });

  it("appends provided query params, skips undefined optionals, sets headers", () => {
    const req = buildRequest(
      getPet,
      { petId: "9", verbose: true, "X-Tenant": "acme" },
      "https://api.example.com",
    );
    expect(req.url).toBe("https://api.example.com/pets/9?verbose=true");
    expect(req.headers["X-Tenant"]).toBe("acme");
    const minimal = buildRequest(getPet, { petId: "9" }, "https://api.example.com");
    expect(minimal.url).toBe("https://api.example.com/pets/9");
    expect("X-Tenant" in minimal.headers).toBe(false);
  });

  it("serializes object bodies as JSON and passes string bodies through", () => {
    const objReq = buildRequest(createPet, { body: { name: "Rex" } }, "https://x");
    expect(objReq.body).toBe('{"name":"Rex"}');
    expect(objReq.headers["content-type"]).toBe("application/json");
    expect(objReq.method).toBe("POST");
    const strReq = buildRequest(createPet, { body: "raw-payload" }, "https://x");
    expect(strReq.body).toBe("raw-payload");
    expect(strReq.headers["content-type"]).toBeUndefined();
    const noBody = buildRequest(createPet, {}, "https://x");
    expect(noBody.body).toBeUndefined();
  });

  it("honors explicit bodies on mutating operations even when a sloppy spec omits requestBody", () => {
    const sloppyPost: SynthTool = { ...createPet, hasBody: false };
    const req = buildRequest(sloppyPost, { body: { title: "keyoku" } }, "https://x");
    expect(req.body).toBe('{"title":"keyoku"}');
    expect(req.headers["content-type"]).toBe("application/json");

    const readOnly = buildRequest(getPet, { petId: "9", body: { ignored: true } }, "https://x");
    expect(readOnly.body).toBeUndefined();
  });

  it("applies all four auth kinds", () => {
    const args = { petId: "1" };
    const bearer = buildRequest(getPet, args, "https://x", { kind: "bearer", token: "tok123" });
    expect(bearer.headers["Authorization"]).toBe("Bearer tok123");
    const header = buildRequest(getPet, args, "https://x", {
      kind: "header",
      name: "X-Api-Key",
      value: "k1",
    });
    expect(header.headers["X-Api-Key"]).toBe("k1");
    const query = buildRequest(getPet, args, "https://x", {
      kind: "query",
      name: "api_key",
      value: "k2",
    });
    expect(query.url).toBe("https://x/pets/1?api_key=k2");
    const none = buildRequest(getPet, args, "https://x", { kind: "none" });
    expect(none.headers).toEqual({});
    const unset = buildRequest(getPet, args, "https://x");
    expect(unset.headers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// executeSynthTool — against a local node:http server
// ---------------------------------------------------------------------------

describe("executeSynthTool", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/echo")) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              method: req.method,
              path: url.pathname,
              query: Object.fromEntries(url.searchParams),
              authorization: req.headers.authorization ?? null,
              tenant: req.headers["x-tenant"] ?? null,
              contentType: req.headers["content-type"] ?? null,
              body,
            }),
          );
        });
        return;
      }
      if (url.pathname === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
        return;
      }
      res.statusCode = 404;
      res.end("no such route here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const echoTool: SynthTool = {
    name: "echo",
    description: "POST /echo/{id}",
    method: "post",
    pathTemplate: "/echo/{id}",
    params: [
      { name: "id", in: "path", required: true },
      { name: "q", in: "query", required: false },
      { name: "X-Tenant", in: "header", required: false },
    ],
    hasBody: true,
    mutating: true,
  };

  it("sends method, path, query, headers, auth, and JSON body", async () => {
    const result = await executeSynthTool(
      echoTool,
      { id: "42", q: "hi", "X-Tenant": "acme", body: { a: 1 } },
      baseUrl,
      { kind: "bearer", token: "sekret" },
    );
    expect(result.isError).toBe(false);
    const echoed = JSON.parse(result.text);
    expect(echoed.method).toBe("POST");
    expect(echoed.path).toBe("/echo/42");
    expect(echoed.query).toEqual({ q: "hi" });
    expect(echoed.authorization).toBe("Bearer sekret");
    expect(echoed.tenant).toBe("acme");
    expect(echoed.contentType).toBe("application/json");
    expect(echoed.body).toBe('{"a":1}');
  });

  it("pretty-prints JSON-parseable 2xx bodies", async () => {
    const tool: SynthTool = {
      name: "getJson",
      description: "GET /json",
      method: "get",
      pathTemplate: "/json",
      params: [],
      hasBody: false,
      mutating: false,
    };
    const result = await executeSynthTool(tool, {}, baseUrl);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"ok": true');
    expect(result.text).toContain("\n");
    expect(JSON.parse(result.text)).toEqual({ ok: true, items: [1, 2, 3] });
  });

  it("flags non-2xx responses with status and capped body", async () => {
    const tool: SynthTool = {
      name: "missing",
      description: "GET /missing",
      method: "get",
      pathTemplate: "/missing",
      params: [],
      hasBody: false,
      mutating: false,
    };
    const result = await executeSynthTool(tool, {}, baseUrl);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^HTTP 404: /);
    expect(result.text).toContain("no such route here");
  });

  it("reports connection-refused network errors as isError", async () => {
    // Grab a free port, then close the listener so the connect is refused.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const tool: SynthTool = {
      name: "dead",
      description: "GET /",
      method: "get",
      pathTemplate: "/",
      params: [],
      hasBody: false,
      mutating: false,
    };
    const result = await executeSynthTool(tool, {}, `http://127.0.0.1:${deadPort}`);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/fetch failed|ECONNREFUSED|refused/i);
  });

  it("propagates buildRequest errors to the caller", async () => {
    await expect(executeSynthTool(echoTool, {}, baseUrl)).rejects.toThrow(/'id'/);
  });

  // ---------------------------------------------------------------------------
  // loadSpec — reuses the local server's routes
  // ---------------------------------------------------------------------------

  describe("loadSpec", () => {
    it("reads local file paths", async () => {
      const dir = mkdtempSync(join(tmpdir(), "keyoku-openapi-"));
      const file = join(dir, "spec.yaml");
      writeFileSync(file, swagger2Yaml, "utf8");
      const raw = await loadSpec(file);
      expect(raw).toBe(swagger2Yaml);
      expect(parseSpec(raw).title).toBe("Legacy API");
    });

    it("throws on missing local files", async () => {
      await expect(loadSpec("/nonexistent/keyoku/spec.json")).rejects.toThrow();
    });

    it("fetches http URLs and throws on non-2xx", async () => {
      const raw = await loadSpec(`${baseUrl}/json`);
      expect(JSON.parse(raw)).toEqual({ ok: true, items: [1, 2, 3] });
      await expect(loadSpec(`${baseUrl}/missing`)).rejects.toThrow(/HTTP 404/);
    });
  });
});

// ---------------------------------------------------------------------------
// ConnectorManager + OpenAPI synth
// ---------------------------------------------------------------------------

describe("ConnectorManager OpenAPI synth", () => {
  it("forwards JSON body args for mutating operations even when the spec omits requestBody", async () => {
    let server: Server | undefined;
    let baseUrl = "";
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/openapi.json") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Sloppy Sessions", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
              "/v1/sessions": {
                post: { operationId: "create_session_v1_sessions_post" },
              },
            },
          }),
        );
        return;
      }

      if (url.pathname === "/v1/sessions" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              contentType: req.headers["content-type"] ?? null,
              body,
              conversation_id: "session_1",
            }),
          );
        });
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dir = mkdtempSync(join(tmpdir(), "keyoku-openapi-connector-"));
    const store = new Store(dir);
    const connectors = new ConnectorManager(store);
    try {
      await connectors.add({
        name: "sloppy",
        transport: {
          type: "openapi",
          specUrl: `${baseUrl}/openapi.json`,
          baseUrl,
          allowMutating: true,
          auth: { kind: "none" },
        },
        autonomy: "autonomous",
        addedAt: "2026-06-26T00:00:00.000Z",
      });

      const result = await connectors.callTool("sloppy", "create_session_v1_sessions_post", {
        body: { agent_name: "codex-test", title: "keyoku:ship-it" },
      });

      expect(result.isError).toBe(false);
      const echoed = JSON.parse(result.text);
      expect(echoed.contentType).toBe("application/json");
      expect(echoed.body).toBe('{"agent_name":"codex-test","title":"keyoku:ship-it"}');
      expect(echoed.conversation_id).toBe("session_1");
    } finally {
      await connectors.closeAll().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// describeTool
// ---------------------------------------------------------------------------

describe("describeTool", () => {
  it("includes method+path, param names, and a mutating marker", () => {
    const described = describeTool({
      name: "createPet",
      description: "Create a pet (POST /pets)",
      method: "post",
      pathTemplate: "/pets",
      params: [
        { name: "X-Tenant", in: "header", required: true },
        { name: "dryRun", in: "query", required: false },
      ],
      hasBody: true,
      mutating: true,
    });
    expect(described.name).toBe("createPet");
    expect(described.description).toContain("POST /pets");
    expect(described.description).toContain("X-Tenant");
    expect(described.description).toContain("dryRun?");
    expect(described.description).toContain("(mutating)");
    expect(described.description).toContain("body");
  });

  it("advertises explicit body args for mutating operations whose spec omits requestBody", () => {
    const described = describeTool({
      name: "createSession",
      description: "Create session",
      method: "post",
      pathTemplate: "/v1/sessions",
      params: [],
      hasBody: false,
      mutating: true,
    });
    expect(described.description).toContain("body");
  });

  it("omits markers that do not apply and prepends a missing route", () => {
    const described = describeTool({
      name: "listPets",
      description: "List pets",
      method: "get",
      pathTemplate: "/pets",
      params: [],
      hasBody: false,
      mutating: false,
    });
    expect(described.description).toContain("GET /pets");
    expect(described.description).toContain("List pets");
    expect(described.description).not.toContain("(mutating)");
    expect(described.description).not.toContain("params:");
  });
});
