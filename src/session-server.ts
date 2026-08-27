import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { findProjectRoot, listFactfileHistory, loadContribution, readVerifiedFactfile, renderFactfileHtml, runGate } from "./contribution.js";
import { queueInstruction, readProofSession, resolveDecision } from "./proof-session.js";

export interface ProofSessionServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64_000) throw new Error("Request body exceeds 64 KB.");
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function startProofSessionServer(input: { root?: string; contributionId: string; port?: number }): Promise<ProofSessionServer> {
  const root = findProjectRoot(input.root);
  const contribution = loadContribution(root, input.contributionId);
  const dir = join(root, ".keyoku", "contributions", contribution.id);
  const factfilePath = join(dir, "factfile.json");
  if (!existsSync(factfilePath)) await runGate(root, contribution.id);
  const token = randomBytes(24).toString("base64url");
  const clients = new Set<ServerResponse>();
  let lastEventMtime = 0;

  const authorize = (request: IncomingMessage, url: URL): boolean => {
    const supplied = request.headers["x-keyoku-session"] ?? url.searchParams.get("token");
    return supplied === token;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (!authorize(request, url)) return json(response, 401, { error: "This Keyoku briefing link is missing or has an expired session token." });
    if (request.method === "GET" && url.pathname === "/") {
      const snapshot = readVerifiedFactfile(factfilePath, { contributionId: contribution.id });
      snapshot.session = readProofSession(root, contribution.id);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderFactfileHtml(snapshot, { live: true, sessionToken: token, history: listFactfileHistory(root, contribution.id) }));
      return;
    }
    const historicalMatch = request.method === "GET" ? url.pathname.match(/^\/snapshots\/([a-z0-9._-]+)\.html$/) : null;
    if (historicalMatch) {
      const path = join(dir, "snapshots", `${historicalMatch[1]}.json`);
      if (!existsSync(path)) return json(response, 404, { error: "Unknown Factfile snapshot." });
      const snapshot = readVerifiedFactfile(path, { contributionId: contribution.id, snapshotId: historicalMatch[1] });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderFactfileHtml(snapshot, { historical: true, sessionToken: token, history: listFactfileHistory(root, contribution.id) }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session") return json(response, 200, readProofSession(root, contribution.id));
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write(`event: ready\ndata: ${JSON.stringify({ contributionId: contribution.id })}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST") {
      if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") return json(response, 415, { error: "Use application/json." });
      const origin = request.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(response, 403, { error: "Cross-origin session writes are not allowed." });
      try {
        const data = await body(request);
        if (url.pathname === "/api/instructions") {
          const text = String(data.text ?? "").trim();
          if (!text) throw new Error("Instruction text is required.");
          const instruction = queueInstruction(root, contribution.id, { text, createdBy: String(data.createdBy ?? "local-human"), ...(data.targetActorId ? { targetActorId: String(data.targetActorId) } : {}) });
          return json(response, 201, { instruction });
        }
        const match = url.pathname.match(/^\/api\/decisions\/([a-z0-9._-]+)$/);
        if (match) {
          const result = resolveDecision(root, contribution.id, {
            decisionId: match[1]!,
            ...(data.selectedOptionId ? { selectedOptionId: String(data.selectedOptionId) } : {}),
            ...(data.note ? { note: String(data.note) } : {}),
            resolvedBy: String(data.resolvedBy ?? "local-human"),
          });
          return json(response, 200, result);
        }
        if (url.pathname === "/api/gate") {
          const snapshot = await runGate(root, contribution.id);
          return json(response, 200, { snapshotId: snapshot.id, state: snapshot.state });
        }
        return json(response, 404, { error: "Unknown endpoint." });
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    return json(response, 404, { error: "Not found." });
  });

  const interval = setInterval(() => {
    try {
      const path = join(dir, "events.jsonl");
      const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
      if (mtime !== lastEventMtime) {
        lastEventMtime = mtime;
        for (const client of clients) client.write(`event: update\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      }
    } catch { /* a transient read failure should not terminate the local session */ }
  }, 800);
  interval.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine the local proof-session address.");
  const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
  return {
    url,
    port: address.port,
    token,
    close: async () => {
      clearInterval(interval);
      for (const client of clients) client.end();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
