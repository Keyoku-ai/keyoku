#!/usr/bin/env node

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const docsRoot = join(projectRoot, "docs");
const runtimeRoot = join(projectRoot, ".keyoku", "runtime");
const pagePath = join(docsRoot, "KEYOKU-PROJECT-STATE.html");
const steeringPath = join(runtimeRoot, "human-steering.jsonl");
const decisionsPath = join(runtimeRoot, "human-decisions.jsonl");
const protocolPath = join(runtimeRoot, "thread-events.jsonl");
const sessionsPath = join(runtimeRoot, "agent-sessions.jsonl");
const architecturePath = join(projectRoot, ".keyoku", "architecture.yaml");
const outcomesRoot = join(projectRoot, ".keyoku", "outcomes");
const goalFocusPath = join(runtimeRoot, "goal-focus.jsonl");
const contributionsRoot = join(projectRoot, ".keyoku", "contributions");
const viewPath = join(projectRoot, ".keyoku", "view.yaml");
const viewEventsPath = join(runtimeRoot, "view-events.jsonl");
const briefTokenPath = join(runtimeRoot, "brief-token");
const roadmapPath = join(projectRoot, ".keyoku", "roadmap.yaml");
const harnessesPath = join(projectRoot, ".keyoku", "harnesses.yaml");
const dispatchesPath = join(runtimeRoot, "dispatches.jsonl");
const currentSnapshotsPath = join(runtimeRoot, "current-snapshots.jsonl");
const activeDispatches = new Map();

const args = process.argv.slice(2);
const lan = args.includes("--lan");
const host = lan ? "0.0.0.0" : "127.0.0.1";
const portFlag = args.indexOf("--port");
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 4178;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

mkdirSync(runtimeRoot, { recursive: true });
const token = process.env.KEYOKU_BRIEF_TOKEN || (existsSync(briefTokenPath) ? readFileSync(briefTokenPath, "utf8").trim() : randomBytes(24).toString("base64url"));
if (!process.env.KEYOKU_BRIEF_TOKEN && !existsSync(briefTokenPath)) writeFileSync(briefTokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
const sessionCookie = `keyoku_brief=${token}`;
const clients = new Set();

function mime(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  }[extname(path).toLowerCase()] || "application/octet-stream";
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function authenticated(req, url) {
  if (url.searchParams.get("token") === token) return true;
  const cookies = req.headers.cookie?.split(";").map((value) => value.trim()) ?? [];
  return cookies.includes(sessionCookie);
}

function assertLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch {
    return false;
  }
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_768) throw new Error("Request is too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function safeText(value, max = 4_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function appendEvent(path, event) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function recentEvents(path, limit = 20) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function foldedSteering(limit = 20) {
  const requests = new Map();
  const acknowledgements = [];
  for (const event of recentEvents(steeringPath, 200)) {
    if (event.eventType === "acknowledgement") acknowledgements.push(event);
    else if (event.id && event.message) requests.set(event.id, { ...event });
  }
  for (const acknowledgement of acknowledgements) {
    const request = requests.get(acknowledgement.steeringId);
    if (!request) continue;
    request.status = acknowledgement.status;
    request.acknowledgement = {
      summary: acknowledgement.summary,
      actor: acknowledgement.actor,
      createdAt: acknowledgement.createdAt,
    };
  }
  return [...requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

function foldedInterventions(limit = 30) {
  const interventions = new Map();
  const receipts = [];
  for (const event of recentEvents(protocolPath, 500)) {
    if (event.eventType === "intervention.created" && event.id) interventions.set(event.id, { ...event, phase: "committed", receipts: [] });
    if (event.eventType === "intervention.receipt" && event.interventionId) receipts.push(event);
  }
  for (const receipt of receipts) {
    const intervention = interventions.get(receipt.interventionId);
    if (!intervention) continue;
    intervention.receipts.push(receipt);
    intervention.phase = receipt.phase;
  }
  return [...interventions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

function foldedSessions(limit = 30) {
  const sessions = new Map();
  for (const event of recentEvents(sessionsPath, 500)) {
    if (event.eventType === "agent.heartbeat" && event.sessionId) sessions.set(event.sessionId, { ...event });
  }
  const now = Date.now();
  return [...sessions.values()].map((session) => ({
    ...session,
    active: session.status !== "disconnected" && Date.parse(session.leaseUntil) > now,
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

function coordinationConflicts(sessions) {
  const active = sessions.filter((session) => session.active && session.currentWork);
  const conflicts = [];
  const overlaps = (left, right) => {
    const a = String(left).replace(/^\.\//, "").replace(/\/$/, "");
    const b = String(right).replace(/^\.\//, "").replace(/\/$/, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  for (let left = 0; left < active.length; left += 1) for (let right = left + 1; right < active.length; right += 1) {
    const a = active[left]; const b = active[right];
    if (a.currentWork.contributionId && a.currentWork.contributionId === b.currentWork.contributionId) conflicts.push({ sessions: [a.sessionId, b.sessionId], reason: "same_contribution", scope: a.currentWork.contributionId });
    for (const aPath of a.currentWork.paths || []) for (const bPath of b.currentWork.paths || []) if (overlaps(aPath, bPath)) conflicts.push({ sessions: [a.sessionId, b.sessionId], reason: "overlapping_path", scope: aPath.length <= bPath.length ? aPath : bPath });
  }
  return conflicts;
}

function protocolId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) client.write(payload);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function repositoryDigest(baseSha, headSha, files) {
  const digest = createHash("sha256");
  digest.update(`base\0${baseSha}\0head\0${headSha}\0`);
  digest.update(git(["diff", "--binary", "HEAD"]));
  digest.update(git(["diff", "--binary", "--cached", "HEAD"]));
  for (const item of files) {
    digest.update(`\0${item.path}\0`);
    const absolute = join(projectRoot, item.path);
    if (item.status === "??" && existsSync(absolute) && statSync(absolute).isFile()) digest.update(readFileSync(absolute));
  }
  return digest.digest("hex");
}

function repositoryState() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedFiles = status ? status.split("\n").filter(Boolean) : [];
  const upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const [behind = 0, ahead = 0] = upstream ? git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]).split(/\s+/).map((value) => Number(value) || 0) : [0, 0];
  const headSha = git(["rev-parse", "HEAD"]) || "unknown";
  const files = changedFiles
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/^.* -> /, "") }))
    .filter((item) => !item.path.startsWith(".keyoku/contributions/") && !item.path.startsWith(".keyoku/runtime/"))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    head: headSha.slice(0, 12),
    headSha,
    branch: git(["branch", "--show-current"]) || "detached",
    upstream: upstream || null,
    ahead,
    behind,
    remote: git(["config", "--get", "remote.origin.url"]) || null,
    lastCommit: git(["log", "-1", "--pretty=%s"]) || "unknown",
    changedFiles: files.length,
    files,
    dirty: files.length > 0,
    worktreeDigest: repositoryDigest(headSha, headSha, files),
  };
}

function architectureFiles(entry) {
  const absolute = join(projectRoot, entry);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [entry];
  const files = [];
  const visit = (directory) => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(child.name)) continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) visit(path); else files.push(relative(projectRoot, path));
    }
  };
  visit(absolute);
  return files;
}

function architectureState() {
  if (!existsSync(architecturePath)) return null;
  const document = parseYaml(readFileSync(architecturePath, "utf8"));
  const status = git(["status", "--porcelain=v1"]);
  const changed = status ? status.split("\n").filter(Boolean).map((line) => line.slice(3)) : [];
  const owned = new Set();
  const components = (document.components || []).map((component) => {
    const files = (component.owns || []).flatMap(architectureFiles);
    files.forEach((file) => owned.add(file));
    const changedFiles = changed.filter((file) => files.includes(file) || (component.owns || []).some((entry) => file === entry || file.startsWith(`${entry}/`)));
    return { ...component, observedFiles: files.length, changedFiles, state: component.external ? "external" : files.length === 0 ? "missing" : changedFiles.length ? "changing" : "stable" };
  });
  const snapshotRef = createHash("sha256").update(JSON.stringify({ head: git(["rev-parse", "HEAD"]), status, document })).digest("hex").slice(0, 16);
  return {
    schemaVersion: "keyoku.dev/architecture-projection/v1alpha1",
    projectId: document.projectId,
    title: document.title,
    generatedAt: new Date().toISOString(),
    snapshotRef,
    source: { kind: "declared+observed", path: ".keyoku/architecture.yaml" },
    components,
    relations: document.relations || [],
    unownedChanges: changed.filter((file) => !owned.has(file)),
  };
}

function architectureSvg(projection) {
  const nodeWidth = 190; const nodeHeight = 112;
  const nodes = new Map(projection.components.map((component) => [component.id, component]));
  const edges = projection.relations.map((relation, index) => {
    const from = nodes.get(relation.from); const to = nodes.get(relation.to); if (!from?.view || !to?.view) return "";
    const x1 = from.view.x + nodeWidth; const y1 = from.view.y + nodeHeight / 2; const x2 = to.view.x; const y2 = to.view.y + nodeHeight / 2;
    const direction = x2 >= x1 ? 1 : -1; const lift = 18 + (index % 4) * 9;
    const c1 = x1 + direction * Math.max(45, Math.abs(x2 - x1) * .38); const c2 = x2 - direction * Math.max(45, Math.abs(x2 - x1) * .38);
    return `<path d="M ${x1} ${y1} C ${c1} ${y1 - lift}, ${c2} ${y2 + lift}, ${x2} ${y2}" fill="none" stroke="#7f75b8" stroke-opacity=".32" stroke-width="1.4" marker-end="url(#arrow)"/>`;
  }).join("");
  const componentNodes = projection.components.map((component) => {
    if (!component.view) return "";
    const state = component.state === "changing" ? "#9a7cff" : component.state === "missing" ? "#ef9a9a" : component.state === "external" ? "#86d7b0" : "#5d567b";
    const mark = component.icon === "database" ? "DB" : component.icon === "keyoku" ? "K" : component.icon === "git" ? "GIT" : component.icon === "mcp" ? "MCP" : component.icon === "agent" ? "AI" : component.icon.slice(0, 2).toUpperCase();
    const detail = component.external ? "external boundary" : `${component.observedFiles} files${component.changedFiles.length ? ` · ${component.changedFiles.length} changing` : ""}`;
    return `<g data-component="${htmlEscape(component.id)}"><rect x="${component.view.x}" y="${component.view.y}" width="${nodeWidth}" height="${nodeHeight}" rx="16" fill="#161226" stroke="${state}" stroke-opacity=".72"/><rect x="${component.view.x + 14}" y="${component.view.y + 15}" width="38" height="30" rx="9" fill="${state}" fill-opacity=".18"/><text x="${component.view.x + 33}" y="${component.view.y + 35}" text-anchor="middle" fill="#d8d2f3" font-size="10" font-weight="600">${htmlEscape(mark)}</text><text x="${component.view.x + 14}" y="${component.view.y + 65}" fill="#f4f1ff" font-size="14" font-weight="600">${htmlEscape(component.label)}</text><text x="${component.view.x + 14}" y="${component.view.y + 86}" fill="#9891ae" font-size="10">${htmlEscape(detail)}</text><text x="${component.view.x + 14}" y="${component.view.y + 101}" fill="#716a89" font-size="9">${htmlEscape(component.layer)}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680" role="img" aria-labelledby="title desc"><title id="title">${htmlEscape(projection.title)}</title><desc id="desc">Live architecture projection for ${htmlEscape(projection.projectId)} at snapshot ${htmlEscape(projection.snapshotRef)}.</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7f75b8" fill-opacity=".55"/></marker></defs><rect width="1200" height="680" fill="#0b0815"/><text x="42" y="42" fill="#f4f1ff" font-family="system-ui,sans-serif" font-size="22">${htmlEscape(projection.title)}</text><text x="42" y="62" fill="#777089" font-family="ui-monospace,monospace" font-size="10">snapshot ${htmlEscape(projection.snapshotRef)} · ${htmlEscape(projection.source.kind)}</text><g font-family="system-ui,sans-serif">${edges}${componentNodes}</g><text x="42" y="650" fill="#625b75" font-family="ui-monospace,monospace" font-size="9">Observed files + declared semantic structure · generated ${htmlEscape(projection.generatedAt)}</text></svg>`;
}

function projectState() {
  const decisions = recentEvents(decisionsPath);
  const latestDecision = new Map(decisions.map((event) => [event.decisionId, event]));
  const steering = foldedSteering();
  const interventions = foldedInterventions();
  const agentSessions = foldedSessions();
  const activeAgents = agentSessions.filter((session) => session.active);
  const architecture = architectureState();
  const goals = projectGoals();
  const proof = projectProof();
  return {
    connected: true,
    mode: lan ? "local-network" : "local-device",
    updatedAt: new Date().toISOString(),
    repository: repositoryState(),
    bridge: {
      protocol: "keyoku.dev/thread-exchange/v1alpha1",
      mode: activeAgents.length ? "agent-connected" : "durable-inbox",
      liveAdapter: activeAgents.find((session) => session.capabilities?.includes("push-intervention"))?.transport || null,
      supports: ["presence", "query", "direction", "control", "proof_challenge", "receipts", "checkpoint", "evidence"],
      truth: activeAgents.length
        ? `${activeAgents.length} agent session${activeAgents.length === 1 ? " holds" : "s hold"} a valid heartbeat lease.`
        : "The UI and durable inbox are live, but no agent session currently holds a heartbeat lease.",
    },
    attention: [],
    steering,
    interventions,
    agents: { active: activeAgents, recent: agentSessions, coordinationConflicts: coordinationConflicts(agentSessions) },
    architecture: architecture ? {
      snapshotRef: architecture.snapshotRef,
      components: architecture.components.length,
      changing: architecture.components.filter((component) => component.state === "changing").length,
      unownedChanges: architecture.unownedChanges.length,
    } : null,
    goals,
    proof,
    roadmap: projectRoadmap(),
    history: projectHistory(),
    harnesses: projectHarnesses(),
    dispatches: projectDispatches(),
    view: projectView(),
    decisions: [...latestDecision.values()],
  };
}

function projectHarnesses() {
  if (!existsSync(harnessesPath)) return [];
  try {
    const manifest = parseYaml(readFileSync(harnessesPath, "utf8"));
    return (manifest?.adapters || []).filter((item) => item?.enabled && item.kind === "codex-exec").map((item) => ({ id: item.id, label: item.label, kind: item.kind, model: item.model || null, sandbox: item.sandbox === "read-only" ? "read-only" : "workspace-write", description: item.description || "Headless coding worker" }));
  } catch { return []; }
}

function projectDispatches() {
  const events = recentEvents(dispatchesPath, 500);
  const byId = new Map();
  for (const event of events) if (event.dispatchId) byId.set(event.dispatchId, { ...(byId.get(event.dispatchId) || {}), ...event });
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function startHeadlessDispatch({ adapter, goal }) {
  const existing = [...activeDispatches.values()].find((item) => item.goalId === goal.id && item.adapterId === adapter.id);
  if (existing) throw new Error("This harness is already running for the focused goal");
  const dispatchId = protocolId("run");
  const sessionId = `headless:${dispatchId}`;
  const outputPath = join(runtimeRoot, `${dispatchId}.last-message.md`);
  const logPath = join(runtimeRoot, `${dispatchId}.jsonl`);
  const prompt = `You are a headless worker dispatched by Keyoku for goal '${goal.id}'.\n\nGoal: ${goal.title}\nObjective: ${goal.objective}\n\nWork toward the smallest safe, testable next task for this goal. Begin by reading .keyoku/outcomes/${goal.id}.yaml, .keyoku/roadmap.yaml when relevant, and the repository status. Preserve unrelated changes. Run proportionate tests. Use the Keyoku MCP tools when connected: project_orient, intervention_list, intervention_receipt, contribution_start, contribution_gate, and agent_session_heartbeat. Do not claim human acceptance. Finish with a concise checkpoint: what changed, evidence, blockers, and next action.`;
  const args = ["exec", "--full-auto", "--sandbox", adapter.sandbox, "-C", projectRoot, "--output-last-message", outputPath, "-"];
  if (adapter.model) args.splice(1, 0, "--model", adapter.model);
  writeFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
  const child = spawn("codex", args, { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  child.stdout.on("data", (chunk) => appendFileSync(logPath, chunk));
  child.stderr.on("data", (chunk) => appendFileSync(logPath, chunk));
  child.stdin.end(prompt);
  const startedAt = new Date().toISOString();
  const event = { eventType: "dispatch.started", dispatchId, sessionId, goalId: goal.id, adapterId: adapter.id, label: adapter.label, pid: child.pid, status: "running", createdAt: startedAt, updatedAt: startedAt, outputPath: relative(projectRoot, outputPath), logPath: relative(projectRoot, logPath) };
  appendEvent(dispatchesPath, event);
  const heartbeat = () => {
    const now = new Date();
    appendEvent(sessionsPath, { schemaVersion: "keyoku.dev/agent-session/v1alpha1", eventType: "agent.heartbeat", eventId: protocolId("evt"), sessionId, actor: { kind: "agent", id: sessionId, name: adapter.label, harness: "Codex exec", ...(adapter.model ? { model: adapter.model } : {}) }, status: "working", currentWork: { summary: `Headless execution for ${goal.title}`, outcomeId: goal.id, baseSnapshot: repositoryState().head, paths: [] }, capabilities: ["checkpoint", "evidence", "headless-process"], transport: "keyoku-process-adapter", createdAt: now.toISOString(), leaseUntil: new Date(now.getTime() + 45_000).toISOString(), active: true });
    broadcast("state", { kind: "agent.heartbeat", sessionId });
  };
  heartbeat();
  const timer = setInterval(heartbeat, 20_000);
  activeDispatches.set(dispatchId, { dispatchId, goalId: goal.id, adapterId: adapter.id, child, timer });
  child.on("exit", (code, signal) => {
    clearInterval(timer); activeDispatches.delete(dispatchId);
    const completedAt = new Date().toISOString();
    const summary = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim().slice(0, 4_000) : `Worker exited ${signal ? `after ${signal}` : `with code ${code}`}.`;
    appendEvent(dispatchesPath, { eventType: "dispatch.completed", dispatchId, goalId: goal.id, adapterId: adapter.id, status: code === 0 ? "completed" : "failed", exitCode: code, signal, summary, updatedAt: completedAt });
    appendEvent(sessionsPath, { schemaVersion: "keyoku.dev/agent-session/v1alpha1", eventType: "agent.heartbeat", eventId: protocolId("evt"), sessionId, actor: { kind: "agent", id: sessionId, name: adapter.label, harness: "Codex exec", ...(adapter.model ? { model: adapter.model } : {}) }, status: "disconnected", capabilities: ["checkpoint", "evidence", "headless-process"], transport: "keyoku-process-adapter", createdAt: completedAt, leaseUntil: completedAt, active: false });
    broadcast("state", { kind: "dispatch.completed", dispatchId, code, signal });
  });
  return event;
}

function projectRoadmap() {
  if (!existsSync(roadmapPath)) return null;
  try { return parseYaml(readFileSync(roadmapPath, "utf8")); } catch { return null; }
}

function projectHistory() {
  const events = [];
  const interventionGoals = new Map();
  for (const event of recentEvents(protocolPath, 500)) if (event.eventType === "intervention.created") interventionGoals.set(event.id, event.scope?.outcomeId);
  for (const event of recentEvents(protocolPath, 500)) {
    if (event.eventType === "intervention.created") events.push({ id: event.eventId, type: "intervention", title: `${event.actor?.name || "Someone"}: ${event.message}`, detail: `${event.kind} · ${event.delivery?.policy || "queued"}`, actor: event.actor, createdAt: event.createdAt, goalId: event.scope?.outcomeId, state: event.phase || "committed" });
    if (event.eventType === "intervention.receipt") events.push({ id: event.eventId, type: "receipt", title: event.summary, detail: `${event.phase} receipt`, actor: event.actor, createdAt: event.createdAt, goalId: interventionGoals.get(event.interventionId), state: event.phase });
  }
  for (const event of recentEvents(decisionsPath, 200)) events.push({ id: event.id || event.eventId, type: "decision", title: `${event.decisionId}: ${event.choice}`, detail: "human decision", actor: event.actor, createdAt: event.createdAt, state: event.choice });
  for (const event of recentEvents(goalFocusPath, 200)) events.push({ id: event.eventId || `${event.goalId}-${event.createdAt}`, type: "goal", title: `Focused ${event.goalId}`, detail: event.reason || "goal focus changed", actor: event.actor, createdAt: event.createdAt, goalId: event.goalId, state: "focused" });
  for (const event of recentEvents(currentSnapshotsPath, 200)) events.push({ id: event.eventId, type: "baseline", title: `Current baseline set to ${event.snapshotId}`, detail: event.reason || "review baseline changed; Git unchanged", actor: event.actor, createdAt: event.createdAt, goalId: event.goalId, state: "current" });
  for (const event of projectDispatches()) events.push({ id: event.dispatchId, type: "dispatch", title: `${event.label || event.adapterId} ${event.status}`, detail: event.summary || `process ${event.pid || ""}`.trim(), createdAt: event.updatedAt || event.createdAt, goalId: event.goalId, state: event.status });
  for (const artifact of projectProof().artifacts) events.push({ id: `factfile-${artifact.contributionId}-${artifact.generatedAt}`, type: "factfile", title: artifact.title, detail: `${artifact.automated.passed}/${artifact.automated.total} automated · ${artifact.human.pending} human pending`, actor: artifact.actors?.at(-1), createdAt: artifact.generatedAt, goalId: artifact.goalId, state: artifact.state, href: artifact.href });
  return events.filter((event) => event.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

function projectView() {
  if (!existsSync(viewPath)) return { schemaVersion: "keyoku.dev/project-view/v1alpha1", template: "convergence-thread", fields: {} };
  const manifest = parseYaml(readFileSync(viewPath, "utf8"));
  const fields = Object.fromEntries(Object.entries(manifest?.fields || {}).flatMap(([name, field]) => typeof field?.value === "string" ? [[name, { value: field.value, description: field.description || "Agent-editable presentation field.", source: "manifest" }]] : []));
  for (const event of recentEvents(viewEventsPath, 500)) {
    if (event.eventType !== "view.fields.published") continue;
    for (const [name, value] of Object.entries(event.fields || {})) {
      if (!fields[name] || typeof value !== "string") continue;
      fields[name] = { ...fields[name], value, source: "agent", updatedAt: event.createdAt, actor: event.actor, confidence: event.confidence };
    }
  }
  return { schemaVersion: "keyoku.dev/project-view/v1alpha1", template: manifest.template || "convergence-thread", fields };
}

function projectGoals() {
  const goals = existsSync(outcomesRoot)
    ? readdirSync(outcomesRoot).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).flatMap((name) => {
      try {
        const value = parseYaml(readFileSync(join(outcomesRoot, name), "utf8"));
        return value?.id && value?.title ? [{ id: value.id, title: value.title, objective: value.objective || "", owner: value.owner || null, updatedAt: value.updatedAt || value.createdAt || "", criteria: value.criteria?.length || 0, humanCriteria: value.humanCriteria?.length || 0 }] : [];
      } catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];
  const focusEvents = recentEvents(goalFocusPath, 100);
  const focusedId = [...focusEvents].reverse().find((event) => event.eventType === "goal.focused" && goals.some((goal) => goal.id === event.goalId))?.goalId || goals[0]?.id || null;
  return { focusedId, focused: goals.find((goal) => goal.id === focusedId) || null, active: goals, count: goals.length };
}

function projectProof() {
  const byGoal = {};
  if (!existsSync(contributionsRoot)) return { byGoal, latest: null, artifacts: [] };
  const records = readdirSync(contributionsRoot).flatMap((name) => {
    const path = join(contributionsRoot, name, "factfile.json");
    if (!existsSync(path)) return [];
    try { const factfile = JSON.parse(readFileSync(path, "utf8")); return [{ path: relative(projectRoot, path), mtime: statSync(path).mtimeMs, factfile }]; } catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime);
  for (const record of records) if (record.factfile.outcome?.id && !byGoal[record.factfile.outcome.id]) byGoal[record.factfile.outcome.id] = {
    contributionId: record.factfile.contribution?.id || record.factfile.id,
    gate: record.factfile.state,
    summary: record.factfile.summary,
    automated: record.factfile.summary,
    humanReview: record.factfile.humanReview,
    snapshot: record.factfile.repository,
    generatedAt: record.factfile.generatedAt,
    path: record.path,
  };
  const artifacts = records.map(({ factfile }) => ({
    contributionId: factfile.contribution?.id || factfile.id,
    goalId: factfile.outcome?.id || factfile.contribution?.outcomeId,
    title: factfile.outcome?.title || factfile.contribution?.title || "Contribution Factfile",
    state: factfile.state,
    generatedAt: factfile.generatedAt,
    automated: factfile.summary || { passed: 0, failed: 0, total: 0 },
    human: factfile.humanReview || { passed: 0, failed: 0, pending: 0, total: 0 },
    snapshot: factfile.repository,
    actors: factfile.contribution?.actors || [],
    href: `/artifacts/factfiles/${encodeURIComponent(factfile.contribution?.id || factfile.id)}`,
  }));
  return { byGoal, latest: records[0]?.factfile || null, artifacts };
}

function factfileSnapshots(goalId) {
  if (!existsSync(contributionsRoot)) return [];
  return readdirSync(contributionsRoot).flatMap((contributionId) => {
    const snapshotsRoot = join(contributionsRoot, contributionId, "snapshots");
    if (!existsSync(snapshotsRoot)) return [];
    return readdirSync(snapshotsRoot).filter((name) => name.endsWith(".json")).flatMap((name) => {
      try {
        const snapshot = JSON.parse(readFileSync(join(snapshotsRoot, name), "utf8"));
        if (goalId && snapshot.outcome?.id !== goalId) return [];
        return [{ contributionId, snapshot }];
      } catch { return []; }
    });
  }).sort((a, b) => b.snapshot.generatedAt.localeCompare(a.snapshot.generatedAt));
}

function currentSnapshotFor(goalId, validIds) {
  const event = [...recentEvents(currentSnapshotsPath, 500)].reverse().find((item) => item.eventType === "snapshot.current" && item.goalId === goalId && validIds.has(item.snapshotId));
  return event?.snapshotId || "live";
}

function projectRecord(goalIdInput, selectedIdInput) {
  const goals = projectGoals();
  const goalId = goalIdInput && goals.active.some((goal) => goal.id === goalIdInput) ? goalIdInput : goals.focusedId;
  const goal = goals.active.find((item) => item.id === goalId) || null;
  const records = factfileSnapshots(goalId);
  const validIds = new Set(["live", ...records.map((item) => item.snapshot.id)]);
  const currentId = currentSnapshotFor(goalId, validIds);
  const selectedId = validIds.has(selectedIdInput) ? selectedIdInput : currentId;
  const liveRepository = repositoryState();
  const history = projectHistory().filter((item) => !goalId || !item.goalId || item.goalId === goalId);
  const roadmap = projectRoadmap();
  const summaries = [{
    id: "live",
    kind: "working",
    title: "Live working state",
    generatedAt: new Date().toISOString(),
    state: liveRepository.dirty ? "in_progress" : "clean",
    branch: liveRepository.branch,
    headSha: liveRepository.headSha,
    changedFiles: liveRepository.changedFiles,
    automated: null,
    human: null,
    current: currentId === "live",
  }, ...records.map(({ contributionId, snapshot }) => ({
    id: snapshot.id,
    kind: "factfile",
    contributionId,
    title: snapshot.contribution?.title || snapshot.outcome?.title || "Factfile revision",
    generatedAt: snapshot.generatedAt,
    state: snapshot.state,
    branch: snapshot.repository?.branch || "unknown",
    headSha: snapshot.repository?.headSha,
    changedFiles: snapshot.repository?.changedFiles?.length || 0,
    automated: snapshot.summary,
    human: snapshot.humanReview,
    current: currentId === snapshot.id,
    href: `/artifacts/snapshots/${encodeURIComponent(contributionId)}/${encodeURIComponent(snapshot.id)}`,
  }))];

  if (selectedId === "live") {
    const architecture = architectureState();
    return {
      schemaVersion: "keyoku.dev/canonical-record/v1alpha1",
      goal,
      roadmap: roadmap?.goalId === goalId ? roadmap : null,
      currentId,
      selectedId,
      snapshots: summaries,
      selected: {
        id: "live",
        kind: "working",
        title: "Live working state",
        generatedAt: new Date().toISOString(),
        state: liveRepository.dirty ? "in_progress" : "clean",
        isCurrent: currentId === "live",
        isExact: true,
        repository: liveRepository,
        outcome: goal,
        architecture,
        architectureSvg: architecture ? architectureSvg(architecture) : null,
        evidence: [],
        summary: null,
        humanReview: null,
        actors: foldedSessions().filter((session) => session.active && session.currentWork?.outcomeId === goalId).map((session) => session.actor),
        reviews: [],
        decisions: recentEvents(decisionsPath, 200),
        contextHistory: history.slice(0, 30),
        changedFiles: liveRepository.files,
        shareHref: `/export/project-update.html`,
      },
    };
  }

  const record = records.find((item) => item.snapshot.id === selectedId);
  if (!record) throw new Error("Snapshot not found");
  const snapshot = record.snapshot;
  const currentDigest = repositoryDigest(snapshot.repository.baseSha, liveRepository.headSha, liveRepository.files);
  const decisions = recentEvents(decisionsPath, 200).filter((item) => item.createdAt <= snapshot.generatedAt);
  return {
    schemaVersion: "keyoku.dev/canonical-record/v1alpha1",
    goal,
    roadmap: roadmap?.goalId === goalId ? roadmap : null,
    currentId,
    selectedId,
    snapshots: summaries,
    selected: {
      id: snapshot.id,
      kind: "factfile",
      contributionId: record.contributionId,
      title: snapshot.contribution?.title || snapshot.outcome?.title,
      generatedAt: snapshot.generatedAt,
      state: snapshot.state,
      isCurrent: currentId === snapshot.id,
      isExact: snapshot.repository.headSha === liveRepository.headSha && snapshot.repository.worktreeDigest === currentDigest,
      digest: snapshot.digest,
      repository: snapshot.repository,
      outcome: snapshot.outcome || goal,
      architecture: snapshot.architecture || null,
      architectureSvg: snapshot.architecture ? architectureSvg(snapshot.architecture) : null,
      evidence: snapshot.evidence || [],
      summary: snapshot.summary,
      humanReview: snapshot.humanReview,
      actors: snapshot.contribution?.actors || [],
      reviews: snapshot.reviews || [],
      decisions,
      contextHistory: history.filter((item) => item.createdAt <= snapshot.generatedAt).slice(0, 30),
      changedFiles: (snapshot.repository.changedFiles || []).map((path) => ({ path })),
      shareHref: `/artifacts/snapshots/${encodeURIComponent(record.contributionId)}/${encodeURIComponent(snapshot.id)}`,
    },
  };
}

function contextPacket(question = "") {
  const state = projectState();
  const accepted = state.decisions.filter((event) => event.choice === "accepted");
  const pending = state.steering.filter((event) => event.status === "queued");
  const pendingInterventions = state.interventions.filter((event) => !["applied", "verified", "declined", "expired", "superseded", "could_not_apply", "cancelled"].includes(event.phase));
  return {
    schemaVersion: "keyoku.dev/agent-context/v1alpha1",
    role: "Current contributing agent",
    project: { id: "keyoku", name: "Keyoku", root: projectRoot },
    snapshot: state.repository,
    goal: state.goals.focused ? { id: state.goals.focused.id, title: state.goals.focused.title, objective: state.goals.focused.objective } : null,
    activeGoals: state.goals.active.map((goal) => ({ id: goal.id, title: goal.title })),
    currentState: [
      "The human-facing project brief and authenticated local relay are implemented as a prototype.",
      "Keyoku is provider-neutral: MCP is the default connection; harness adapters are optional accelerators.",
      "The repository scanner and a truly live bidirectional harness adapter remain unproven.",
    ],
    humanDecisions: accepted.map((event) => ({ id: event.decisionId, choice: event.choice })),
    pendingSteering: pending.map((event) => ({ id: event.id, kind: event.kind, message: event.message })),
    pendingInterventions: pendingInterventions.map((event) => ({ id: event.id, kind: event.kind, message: event.message, phase: event.phase, delivery: event.delivery })),
    question: safeText(question, 2_000),
    responseContract: [
      "Answer the question directly in plain language.",
      "State your recommendation and its consequence.",
      "Name affected goals or components and link evidence instead of pasting raw logs.",
      "Say whether human action is required; do not manufacture a decision when safe policy covers it.",
      "Publish an understood receipt after interpreting an intervention, an applied receipt only after it changes the work, and a verified receipt only with evidence.",
    ],
  };
}

function promptForAgent(packet) {
  return `You are the current coding agent for this project. Use the following compact Keyoku context packet. Do not assume a specific agent harness.\n\n${JSON.stringify(packet, null, 2)}\n\nRespond using the responseContract. If Keyoku MCP is connected, call project_orient first, publish a session heartbeat, read interventions, and record semantic receipts after you understand or change the work.`;
}

function exportJson() {
  const state = projectState();
  return {
    schemaVersion: "keyoku.dev/project-status/v1alpha1",
    generatedAt: new Date().toISOString(),
    project: { id: "keyoku", name: "Keyoku", repository: "https://github.com/Keyoku-ai/keyoku" },
    snapshot: state.repository,
    goals: state.goals,
    roadmap: state.roadmap,
    architecture: architectureState(),
    proof: state.proof,
    steering: state.steering,
    interventions: state.interventions,
    agents: state.agents,
    decisions: state.decisions,
    history: state.history,
  };
}

function exportMarkdown() {
  const state = exportJson();
  const roadmap = state.roadmap?.milestones || [];
  const artifacts = state.proof?.artifacts || [];
  return `# Keyoku project status\n\nGenerated ${state.generatedAt}\n\n## Focused goal\n\n**${state.goals.focused?.title || "No focused goal"}**\n\n${state.goals.focused?.objective || ""}\n\n## Snapshot\n\n- Branch: ${state.snapshot.branch}\n- Head: ${state.snapshot.head}\n- Working files: ${state.snapshot.changedFiles}\n- Active agents: ${state.agents.active.length}\n- Active goals: ${state.goals.count}\n\n## Roadmap\n\nIteration ${state.roadmap?.iteration?.current || "?"} of ${state.roadmap?.iteration?.target || "?"}\n\n${roadmap.map((item) => `- **${item.status}** — ${item.title} (target iteration ${item.targetIteration})`).join("\n")}\n\n## Factfiles\n\n${artifacts.map((item) => `- **${item.title}** — ${item.automated.passed}/${item.automated.total} automated; ${item.human.pending} human pending; ${item.state}`).join("\n") || "- No Factfiles yet"}\n\n## Decisions\n\n${state.decisions.map((item) => `- ${item.decisionId}: ${item.choice}`).join("\n") || "- No decisions recorded"}\n`;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function exportHtml() {
  const state = exportJson();
  const focused = state.goals.focused;
  const roadmap = state.roadmap?.milestones || [];
  const artifacts = state.proof?.artifacts || [];
  const architecture = state.architecture ? architectureSvg(state.architecture).replace(/^<svg/, '<svg class="diagram"') : "<p>No architecture projection.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keyoku project status</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;color:#f4f1ff;background:#090711;font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{width:min(1180px,92vw);margin:34px auto 70px}.top{padding:34px;border:1px solid #302849;border-radius:24px;background:linear-gradient(135deg,#171129,#0f0c1b)}.label{color:#a895ff;font:700 11px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}h1{max-width:850px;margin:12px 0 10px;font-size:clamp(34px,5vw,64px);line-height:1;letter-spacing:-.045em}.objective{max-width:820px;color:#aaa3bb;font-size:17px}.metrics,.grid{display:grid;gap:12px}.metrics{grid-template-columns:repeat(4,1fr);margin-top:24px}.metric,.card{border:1px solid #2d2740;background:#12101d;border-radius:16px;padding:18px}.metric span,.card>small{display:block;color:#777086;font:700 10px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.metric b{display:block;margin-top:8px;font-size:21px}.grid{grid-template-columns:1fr 1fr;margin-top:14px}.card h2{margin:7px 0 14px;font-size:20px}.road{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:start;padding:12px 0;border-top:1px solid #282238}.road:first-of-type{border:0}.road i{width:12px;height:12px;margin-top:5px;border-radius:50%;background:#4e4761}.road.in_progress i{background:#a588ff;box-shadow:0 0 0 5px #a588ff1c}.road b{display:block}.road p{margin:3px 0 0;color:#8d869c}.road em{color:#8d869c;font-style:normal;font:11px ui-monospace,monospace}.fact{padding:12px 0;border-top:1px solid #282238}.fact:first-of-type{border:0}.fact b{display:block}.fact span{color:#8f88a0;font-size:13px}.diagram-card{grid-column:1/-1;overflow:hidden}.diagram{width:100%;height:auto;border-radius:12px}.decision{padding:10px 0;border-top:1px solid #282238}.decision:first-of-type{border:0}.decision span{color:#9a92aa}.foot{margin-top:18px;color:#635d70;font:10px/1.5 ui-monospace,monospace}@media(max-width:750px){.metrics,.grid{grid-template-columns:1fr 1fr}.diagram-card{grid-column:1/-1}}@media(max-width:520px){.metrics,.grid{grid-template-columns:1fr}}</style></head><body><main class="page"><section class="top"><div class="label">Keyoku · shareable project status</div><h1>${htmlEscape(focused?.title || "No focused goal")}</h1><p class="objective">${htmlEscape(focused?.objective || "")}</p><div class="metrics"><div class="metric"><span>Iteration</span><b>${htmlEscape(state.roadmap?.iteration?.current || "?")} / ${htmlEscape(state.roadmap?.iteration?.target || "?")}</b></div><div class="metric"><span>Goals</span><b>${state.goals.count}</b></div><div class="metric"><span>Agents</span><b>${state.agents.active.length} active</b></div><div class="metric"><span>Snapshot</span><b>${htmlEscape(state.snapshot.head)}</b></div></div></section><div class="grid"><section class="card"><small>Roadmap</small><h2>How this converges</h2>${roadmap.map((item) => `<div class="road ${htmlEscape(item.status)}"><i></i><div><b>${htmlEscape(item.title)}</b><p>${htmlEscape(item.proof)}</p></div><em>iteration ${htmlEscape(item.targetIteration)}</em></div>`).join("")}</section><section class="card"><small>Proof</small><h2>Contribution Factfiles</h2>${artifacts.slice(0,8).map((item) => `<div class="fact"><b>${htmlEscape(item.title)}</b><span>${item.automated.passed}/${item.automated.total} automated · ${item.human.pending} human pending · ${htmlEscape(item.state)}</span></div>`).join("") || "<p>No Factfiles yet.</p>"}</section><section class="card diagram-card"><small>Architecture</small><h2>Current system projection</h2>${architecture}</section><section class="card"><small>Decisions</small><h2>Human-owned direction</h2>${state.decisions.map((item) => `<div class="decision"><b>${htmlEscape(item.decisionId)}</b><br><span>${htmlEscape(item.choice)}</span></div>`).join("") || "<p>No decisions recorded.</p>"}</section><section class="card"><small>Status</small><h2>Current execution</h2><p>${state.agents.active.length ? htmlEscape(state.agents.active.map((item) => `${item.actor.name}: ${item.currentWork?.summary || item.status}`).join(" · ")) : "No agent has a current heartbeat lease."}</p><p>${state.snapshot.changedFiles} working-tree files · ${htmlEscape(state.snapshot.branch)} at ${htmlEscape(state.snapshot.head)}</p><p>Estimate confidence: ${htmlEscape(state.roadmap?.iteration?.confidence || "unrated")} · ${htmlEscape(state.roadmap?.iteration?.basis || "")}</p></section></div><p class="foot">Generated ${htmlEscape(state.generatedAt)} · Portable status snapshot, not an accepted Factfile unless human review says so.</p></main></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.searchParams.get("token") === token) {
      res.writeHead(302, {
        Location: url.pathname,
        "Set-Cookie": `${sessionCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (!authenticated(req, url)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("This Keyoku briefing link is missing or has an expired session token.");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, projectState());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/context") {
      json(res, 200, contextPacket(url.searchParams.get("question") || ""));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/architecture") {
      const architecture = architectureState();
      if (!architecture) return json(res, 404, { error: "No architecture contract exists" });
      json(res, 200, architecture);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/view") {
      json(res, 200, projectView());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/record") {
      json(res, 200, projectRecord(safeText(url.searchParams.get("goalId"), 200), safeText(url.searchParams.get("snapshotId"), 200)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/snapshots/current") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const goalId = safeText(input.goalId, 200);
      const snapshotId = safeText(input.snapshotId, 200);
      const record = projectRecord(goalId, snapshotId);
      if (!goalId || record.goal?.id !== goalId || record.selectedId !== snapshotId) return json(res, 404, { error: "Goal snapshot not found" });
      const event = { eventType: "snapshot.current", eventId: protocolId("evt"), goalId, snapshotId, previousSnapshotId: record.currentId, actor: { kind: "human", id: "owner", name: "Tye" }, reason: safeText(input.reason, 1_000) || "Selected as the current Keyoku review baseline. Git was not changed.", createdAt: new Date().toISOString() };
      appendEvent(currentSnapshotsPath, event);
      broadcast("state", { kind: "snapshot.current", event });
      json(res, 201, { event, record: projectRecord(goalId, snapshotId) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/goals/focus") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const goalId = safeText(input.goalId, 200);
      const goals = projectGoals();
      if (!goals.active.some((goal) => goal.id === goalId)) return json(res, 404, { error: "Project goal not found" });
      const event = {
        eventType: "goal.focused",
        eventId: protocolId("evt"),
        goalId,
        actor: { kind: "human", id: "owner", name: "Tye" },
        reason: safeText(input.reason, 1_000) || "Focused from the Keyoku project interface.",
        createdAt: new Date().toISOString(),
      };
      appendEvent(goalFocusPath, event);
      broadcast("state", { kind: "goal.focused", event });
      json(res, 201, { event, goals: projectGoals() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const goals = projectGoals();
      const goalId = safeText(input.goalId, 200) || goals.focusedId;
      const adapterId = safeText(input.adapterId, 200);
      const goal = goals.active.find((item) => item.id === goalId);
      const adapter = projectHarnesses().find((item) => item.id === adapterId);
      if (!goal) return json(res, 404, { error: "Project goal not found" });
      if (!adapter) return json(res, 404, { error: "Enabled harness adapter not found" });
      const dispatch = startHeadlessDispatch({ adapter, goal });
      broadcast("state", { kind: "dispatch.started", dispatch });
      json(res, 201, { dispatch, message: `${adapter.label} started for ${goal.title}` });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: connected\ndata: ${JSON.stringify(projectState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/steer") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const message = safeText(input.message, 2_000);
      const kind = safeText(input.kind, 40) || "direction";
      if (!message) return json(res, 400, { error: "A steering message is required" });
      const event = { id: `steer_${Date.now().toString(36)}`, kind, message, actor: { kind: "human", name: "Tye" }, createdAt: new Date().toISOString(), status: "queued" };
      appendEvent(steeringPath, event);
      broadcast("state", { kind: "steering", event });
      json(res, 201, event);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const question = safeText(input.question, 2_000);
      if (!question) return json(res, 400, { error: "A question is required" });
      const packet = contextPacket(question);
      const event = {
        id: `ask_${Date.now().toString(36)}`,
        kind: "question",
        message: question,
        actor: { kind: "human", name: "Tye" },
        createdAt: new Date().toISOString(),
        status: "queued",
      };
      appendEvent(steeringPath, event);
      broadcast("state", { kind: "question", event });
      json(res, 201, {
        mode: "copy",
        delivery: "queued_for_connected_agents",
        event,
        prompt: promptForAgent(packet),
        note: "Keyoku recorded this in the project inbox. Copy the prompt into an active agent session unless a live harness adapter is connected.",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/interventions") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const message = safeText(input.message, 4_000);
      const allowedKinds = new Set(["query", "direction", "decision_response", "control", "proof_challenge"]);
      const allowedPolicies = new Set(["when_available", "next_checkpoint", "interrupt_now"]);
      const kind = allowedKinds.has(input.kind) ? input.kind : "query";
      const policy = allowedPolicies.has(input.deliveryPolicy) ? input.deliveryPolicy : "next_checkpoint";
      const targetMode = ["current", "session", "all"].includes(input.targetMode) ? input.targetMode : "current";
      const targetSessionId = safeText(input.targetSessionId, 200);
      if (!message) return json(res, 400, { error: "An intervention message is required" });
      if (targetMode === "session" && !targetSessionId) return json(res, 400, { error: "targetSessionId is required for a session target" });
      const id = protocolId("int");
      const repository = repositoryState();
      const focusedGoalId = projectGoals().focusedId;
      const event = {
        schemaVersion: "keyoku.dev/intervention/v1alpha1",
        eventType: "intervention.created",
        eventId: protocolId("evt"),
        id,
        projectId: "keyoku",
        threadId: "project",
        correlationId: id,
        kind,
        message,
        actor: { kind: "human", id: "owner", name: "Tye" },
        target: { mode: targetMode, ...(targetSessionId ? { sessionId: targetSessionId } : {}) },
        scope: { ...(focusedGoalId ? { outcomeId: focusedGoalId } : {}), snapshotRef: repository.head },
        delivery: {
          policy,
          require: Array.isArray(input.require) && input.require.length ? input.require.filter((value) => ["understood", "applied", "verified"].includes(value)) : ["understood", "applied"],
        },
        createdAt: new Date().toISOString(),
        idempotencyKey: safeText(input.idempotencyKey, 300) || protocolId("idem"),
        phase: "committed",
        receipts: [],
      };
      appendEvent(protocolPath, event);
      broadcast("state", { kind: "intervention", event });
      const activeAgents = foldedSessions().filter((session) => session.active && (!focusedGoalId || session.currentWork?.outcomeId === focusedGoalId));
      const packet = contextPacket(message);
      json(res, 201, {
        event,
        delivery: {
          state: "committed",
          activeTargets: activeAgents.length,
          mode: activeAgents.length ? "adapter_or_poll" : "durable_inbox",
          note: activeAgents.length
            ? "Committed to the project thread. Target agents must publish semantic receipts as they understand and apply it."
            : "Committed to the durable inbox. No agent heartbeat is active, so this has not been delivered yet.",
        },
        fallbackPrompt: promptForAgent(packet),
      });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/interventions\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const interventionId = decodeURIComponent(cancelMatch[1]);
      const intervention = foldedInterventions(500).find((item) => item.id === interventionId);
      if (!intervention) return json(res, 404, { error: "Intervention not found" });
      if (["applied", "verified", "declined", "expired", "superseded", "could_not_apply", "cancelled"].includes(intervention.phase)) {
        return json(res, 409, { error: `A ${intervention.phase} intervention cannot be cancelled` });
      }
      const receipt = {
        eventType: "intervention.receipt",
        eventId: protocolId("evt"),
        interventionId,
        phase: "cancelled",
        summary: "Cancelled by the accountable human before application.",
        actor: { kind: "human", id: "owner", name: "Tye" },
        createdAt: new Date().toISOString(),
      };
      appendEvent(protocolPath, receipt);
      broadcast("state", { kind: "intervention.receipt", event: receipt });
      json(res, 201, { intervention: foldedInterventions(500).find((item) => item.id === interventionId), receipt });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent-heartbeat") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const sessionId = safeText(input.sessionId, 200);
      const harness = safeText(input.harness, 200);
      const actorName = safeText(input.actorName, 200) || "Coding agent";
      const transport = safeText(input.transport, 100);
      const allowedStatuses = new Set(["idle", "working", "waiting", "blocked", "disconnected"]);
      const status = allowedStatuses.has(input.status) ? input.status : "working";
      if (!sessionId || !harness || !transport) return json(res, 400, { error: "sessionId, harness, and transport are required" });
      const leaseSeconds = Math.max(15, Math.min(Number(input.leaseSeconds) || 45, 300));
      const now = new Date();
      const event = {
        schemaVersion: "keyoku.dev/agent-session/v1alpha1",
        eventType: "agent.heartbeat",
        eventId: protocolId("evt"),
        sessionId,
        actor: { kind: "agent", id: safeText(input.actorId, 200) || sessionId, name: actorName, harness, ...(safeText(input.model, 200) ? { model: safeText(input.model, 200) } : {}) },
        status,
        ...(safeText(input.workSummary, 1_000) ? { currentWork: {
          summary: safeText(input.workSummary, 1_000),
          ...(safeText(input.outcomeId, 200) ? { outcomeId: safeText(input.outcomeId, 200) } : {}),
          ...(safeText(input.contributionId, 200) ? { contributionId: safeText(input.contributionId, 200) } : {}),
          ...(Array.isArray(input.capabilityIds) ? { capabilityIds: input.capabilityIds.map((value) => safeText(value, 200)).filter(Boolean).slice(0, 30) } : {}),
          ...(Array.isArray(input.paths) ? { paths: input.paths.map((value) => safeText(value, 500)).filter(Boolean).slice(0, 100) } : {}),
          baseSnapshot: repositoryState().head,
        } } : {}),
        capabilities: Array.isArray(input.capabilities) ? input.capabilities.map((value) => safeText(value, 100)).filter(Boolean).slice(0, 30) : [],
        transport,
        createdAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
        active: status !== "disconnected",
      };
      appendEvent(sessionsPath, event);
      broadcast("state", { kind: "agent.heartbeat", event });
      json(res, 201, event);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/decision") {
      if (!assertLocalOrigin(req)) return json(res, 403, { error: "Origin does not match this Keyoku session" });
      const input = await body(req);
      const decisionId = safeText(input.decisionId, 100);
      const choice = safeText(input.choice, 100);
      if (!decisionId || !choice) return json(res, 400, { error: "decisionId and choice are required" });
      const event = { id: `decision_${Date.now().toString(36)}`, decisionId, choice, actor: { kind: "human", name: "Tye" }, createdAt: new Date().toISOString() };
      appendEvent(decisionsPath, event);
      broadcast("state", { kind: "decision", event });
      json(res, 201, event);
      return;
    }

    if (req.method === "GET" && url.pathname === "/export/project-brief.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=keyoku-project-brief.json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(exportJson(), null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/export/project-update.md") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=keyoku-project-update.md", "Cache-Control": "no-store" });
      res.end(exportMarkdown());
      return;
    }

    if (req.method === "GET" && url.pathname === "/export/project-update.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": "attachment; filename=keyoku-project-update.html", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(exportHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/export/architecture.svg") {
      const architecture = architectureState();
      if (!architecture) return json(res, 404, { error: "No architecture contract exists" });
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": "attachment; filename=keyoku-architecture.svg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(architectureSvg(architecture));
      return;
    }

    const factfileMatch = url.pathname.match(/^\/artifacts\/factfiles\/([^/]+)$/);
    if (req.method === "GET" && factfileMatch) {
      const contributionId = decodeURIComponent(factfileMatch[1]);
      if (!/^[a-zA-Z0-9._-]+$/.test(contributionId)) return json(res, 400, { error: "Invalid contribution id" });
      const artifact = resolve(contributionsRoot, contributionId, "factfile.html");
      if (!artifact.startsWith(`${resolve(contributionsRoot)}/`) || !existsSync(artifact)) return json(res, 404, { error: "Factfile not found" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
      createReadStream(artifact).pipe(res);
      return;
    }

    const snapshotMatch = url.pathname.match(/^\/artifacts\/snapshots\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && snapshotMatch) {
      const contributionId = decodeURIComponent(snapshotMatch[1]);
      const snapshotId = decodeURIComponent(snapshotMatch[2]);
      if (!/^[a-zA-Z0-9._-]+$/.test(contributionId) || !/^[a-zA-Z0-9._-]+$/.test(snapshotId)) return json(res, 400, { error: "Invalid snapshot reference" });
      const artifact = resolve(contributionsRoot, contributionId, "snapshots", `${snapshotId}.html`);
      if (!artifact.startsWith(`${resolve(contributionsRoot)}/`) || !existsSync(artifact)) return json(res, 404, { error: "Snapshot artifact not found" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
      createReadStream(artifact).pipe(res);
      return;
    }

    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

    const requested = url.pathname === "/" ? pagePath : join(docsRoot, normalize(url.pathname).replace(/^[/\\]+/, ""));
    const absolute = resolve(requested);
    if (!absolute.startsWith(`${docsRoot}/`) && absolute !== pagePath) return json(res, 404, { error: "Not found" });
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return json(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": mime(absolute),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    createReadStream(absolute).pipe(res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const watched = [pagePath, join(projectRoot, ".keyoku")];
for (const target of watched) {
  if (!existsSync(target)) continue;
  watch(target, { recursive: statSync(target).isDirectory() }, (_event, filename) => {
    broadcast(target === pagePath ? "page" : "state", { changed: filename || target, at: new Date().toISOString() });
  });
}

let lastRepositorySignature = JSON.stringify(repositoryState());
setInterval(() => {
  const repository = repositoryState();
  const signature = JSON.stringify(repository);
  if (signature !== lastRepositorySignature) {
    lastRepositorySignature = signature;
    broadcast("state", { kind: "repository", repository, at: new Date().toISOString() });
  }
}, 2_000).unref();

function addresses() {
  if (!lan) return ["127.0.0.1"];
  const values = [];
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records || []) {
      if (record.family === "IPv4" && !record.internal) values.push(record.address);
    }
  }
  return values.length ? values : ["127.0.0.1"];
}

server.listen(port, host, () => {
  console.log("Keyoku project brief is live.");
  console.log("");
  for (const address of addresses()) console.log(`  http://${address}:${port}/?token=${token}`);
  console.log("");
  console.log(lan ? "Anyone on this local network with the temporary link can view and steer this session." : "This session is available only on this device. Add --lan to create a phone-accessible local-network link.");
  console.log("Press Ctrl+C to stop sharing.");
});

function shutdown() {
  broadcast("closed", { at: new Date().toISOString() });
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
