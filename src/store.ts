import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ActionRecord,
  ActivityEvent,
  ApprovalRequest,
  AuditEntry,
  Connector,
  Goal,
  Observation,
  Pattern,
  WorkflowArtifact,
  WorkflowExecution,
  WorkflowTemplate,
} from "./types.js";

/** Resolve the harness home directory (KEYOKU_HOME or ~/.keyoku). */
export function resolveHome(override?: string): string {
  return override ?? process.env.KEYOKU_HOME ?? join(homedir(), ".keyoku");
}

let counter = 0;

/** Sortable, collision-resistant id without external deps. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const seq = counter.toString(36).padStart(2, "0");
  return `${prefix}_${time}${seq}${rand}`;
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "goal";
}

type CollectionName = "goals" | "connectors" | "workflows" | "patterns" | "approvals" | "templates" | "executions";

interface CollectionType {
  goals: Goal;
  connectors: Connector;
  workflows: WorkflowArtifact;
  patterns: Pattern;
  approvals: ApprovalRequest;
  templates: WorkflowTemplate;
  executions: WorkflowExecution;
}

// Files may hold credentials (connector env/headers, probe auth headers), so
// the home dir is 0700 and every file 0600 — same posture as ~/.aws.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * JSON-file persistence under the harness home directory. Deliberately boring
 * for M1: synchronous, atomic (tmp + rename), and CACHELESS — every read goes
 * to disk so long-running processes (the MCP serve session, the watch CLI)
 * always see each other's writes. Mutations are read-modify-write over the
 * freshest copy, which makes concurrent processes last-writer-wins per entry
 * rather than silently destructive. The interface is the contract; SQLite can
 * swap in later.
 */
export class Store {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = resolveHome(dir);
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    mkdirSync(join(this.dir, "records"), { recursive: true, mode: DIR_MODE });
    mkdirSync(join(this.dir, "observations"), { recursive: true, mode: DIR_MODE });
  }

  private file(name: CollectionName): string {
    return join(this.dir, `${name}.json`);
  }

  private read<N extends CollectionName>(name: N): CollectionType[N][] {
    const path = this.file(name);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(
        `Corrupt store file ${path}: ${err instanceof Error ? err.message : String(err)}. Fix or delete it to continue.`,
      );
    }
  }

  private write<N extends CollectionName>(name: N, data: CollectionType[N][]): void {
    const path = this.file(name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
    renameSync(tmp, path);
  }

  // ----- goals -----

  listGoals(): Goal[] {
    return this.read("goals");
  }

  /** Find by slug or id. */
  getGoal(ref: string): Goal | undefined {
    return this.read("goals").find((g) => g.slug === ref || g.id === ref);
  }

  saveGoal(goal: Goal): void {
    const goals = this.read("goals");
    const idx = goals.findIndex((g) => g.id === goal.id);
    if (idx >= 0) goals[idx] = goal;
    else goals.push(goal);
    this.write("goals", goals);
  }

  deleteGoal(id: string): boolean {
    const goals = this.read("goals");
    const remaining = goals.filter((g) => g.id !== id);
    this.write("goals", remaining);
    rmSync(this.recordsFile(id), { force: true });
    return remaining.length < goals.length;
  }

  /**
   * Slugs must be unique across goals AND workflows — workflows survive goal
   * deletion, and an unrelated new goal must not silently merge into a dead
   * goal's learned workflow.
   */
  uniqueSlug(base: string): string {
    const taken = new Set<string>([
      ...this.read("goals").map((g) => g.slug),
      ...this.read("workflows").map((w) => w.slug),
    ]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }
  }

  // ----- action records (append-only JSONL per goal) -----

  private recordsFile(goalId: string): string {
    return join(this.dir, "records", `${goalId}.jsonl`);
  }

  appendRecord(record: ActionRecord): void {
    appendFileSync(this.recordsFile(record.goalId), `${JSON.stringify(record)}\n`, {
      mode: FILE_MODE,
    });
  }

  listRecords(goalId: string): ActionRecord[] {
    const path = this.recordsFile(goalId);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ActionRecord);
  }

  // ----- connectors -----

  listConnectors(): Connector[] {
    return this.read("connectors");
  }

  getConnector(name: string): Connector | undefined {
    return this.read("connectors").find((c) => c.name === name);
  }

  saveConnector(connector: Connector): void {
    const connectors = this.read("connectors");
    const idx = connectors.findIndex((c) => c.name === connector.name);
    if (idx >= 0) connectors[idx] = connector;
    else connectors.push(connector);
    this.write("connectors", connectors);
  }

  deleteConnector(name: string): boolean {
    const connectors = this.read("connectors");
    const remaining = connectors.filter((c) => c.name !== name);
    this.write("connectors", remaining);
    return remaining.length < connectors.length;
  }

  // ----- observations (M2: append-only JSONL per goal, capped) -----

  private observationsFile(goalId: string): string {
    return join(this.dir, "observations", `${goalId}.jsonl`);
  }

  appendObservation(observation: Observation): void {
    appendFileSync(
      this.observationsFile(observation.goalId),
      `${JSON.stringify(observation)}\n`,
      { mode: FILE_MODE },
    );
    // Cap the file so steady-state watch loops don't grow it unboundedly.
    const all = this.listObservations(observation.goalId);
    if (all.length > 500) {
      const tmp = `${this.observationsFile(observation.goalId)}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        all.slice(-400).map((o) => JSON.stringify(o)).join("\n") + "\n",
        { mode: FILE_MODE },
      );
      renameSync(tmp, this.observationsFile(observation.goalId));
    }
  }

  listObservations(goalId: string, limit?: number): Observation[] {
    const path = this.observationsFile(goalId);
    if (!existsSync(path)) return [];
    const all = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Observation);
    // limit === 0 must mean "none", not "all" (slice(-0) returns everything).
    if (limit === undefined) return all;
    return limit <= 0 ? [] : all.slice(-limit);
  }

  // ----- patterns (M2) -----

  listPatterns(): Pattern[] {
    return this.read("patterns");
  }

  savePattern(pattern: Pattern): void {
    const patterns = this.read("patterns");
    const idx = patterns.findIndex((p) => p.id === pattern.id);
    if (idx >= 0) patterns[idx] = pattern;
    else patterns.push(pattern);
    this.write("patterns", patterns);
  }

  saveAllPatterns(patterns: Pattern[]): void {
    this.write("patterns", patterns);
  }

  // ----- approvals (M4) -----

  listApprovals(status?: ApprovalRequest["status"]): ApprovalRequest[] {
    const approvals = this.read("approvals");
    return status ? approvals.filter((a) => a.status === status) : approvals;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.read("approvals").find((a) => a.id === id);
  }

  saveApproval(approval: ApprovalRequest): void {
    const approvals = this.read("approvals");
    const idx = approvals.findIndex((a) => a.id === approval.id);
    if (idx >= 0) approvals[idx] = approval;
    else approvals.push(approval);
    this.write("approvals", approvals);
  }

  // ----- audit (M4: append-only JSONL) -----

  private auditFile(): string {
    return join(this.dir, "audit.jsonl");
  }

  appendAudit(entry: AuditEntry): void {
    appendFileSync(this.auditFile(), `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
  }

  listAudit(limit = 100): AuditEntry[] {
    const path = this.auditFile();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  // ----- workflows -----

  listWorkflows(): WorkflowArtifact[] {
    return this.read("workflows");
  }

  getWorkflow(slug: string): WorkflowArtifact | undefined {
    return this.read("workflows").find((w) => w.slug === slug);
  }

  saveWorkflow(workflow: WorkflowArtifact): void {
    const workflows = this.read("workflows");
    const idx = workflows.findIndex((w) => w.slug === workflow.slug);
    if (idx >= 0) workflows[idx] = workflow;
    else workflows.push(workflow);
    this.write("workflows", workflows);
  }

  // ----- activity events (append-only JSONL, capped at 10k) -----

  private activityFile(): string {
    return join(this.dir, "activity.jsonl");
  }

  appendActivity(event: ActivityEvent): void {
    appendFileSync(this.activityFile(), `${JSON.stringify(event)}\n`, { mode: FILE_MODE });
    const all = this.listActivity();
    if (all.length > 10_000) {
      const trimmed = all.slice(-8_000);
      const tmp = `${this.activityFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: FILE_MODE });
      renameSync(tmp, this.activityFile());
    }
  }

  listActivity(limit?: number): ActivityEvent[] {
    const path = this.activityFile();
    if (!existsSync(path)) return [];
    const all = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as ActivityEvent);
    if (limit === undefined) return all;
    return limit <= 0 ? [] : all.slice(-limit);
  }

  // ----- workflow templates (approved recipes) -----

  listTemplates(): WorkflowTemplate[] {
    return this.read("templates");
  }

  getTemplate(ref: string): WorkflowTemplate | undefined {
    return this.read("templates").find((t) => t.slug === ref || t.id === ref);
  }

  saveTemplate(template: WorkflowTemplate): void {
    const templates = this.read("templates");
    const idx = templates.findIndex((t) => t.id === template.id);
    if (idx >= 0) templates[idx] = template;
    else templates.push(template);
    this.write("templates", templates);
  }

  deleteTemplate(id: string): boolean {
    const templates = this.read("templates");
    const remaining = templates.filter((t) => t.id !== id);
    this.write("templates", remaining);
    return remaining.length < templates.length;
  }

  // ----- executions -----

  listExecutions(status?: WorkflowExecution["status"]): WorkflowExecution[] {
    const all = this.read("executions");
    return status ? all.filter((e) => e.status === status) : all;
  }

  getExecution(id: string): WorkflowExecution | undefined {
    return this.read("executions").find((e) => e.id === id);
  }

  saveExecution(execution: WorkflowExecution): void {
    const executions = this.read("executions");
    const idx = executions.findIndex((e) => e.id === execution.id);
    if (idx >= 0) executions[idx] = execution;
    else executions.push(execution);
    this.write("executions", executions);
  }
}
