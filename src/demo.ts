import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

import { KEYOKU_DIR } from "./contribution.js";

// ---------------------------------------------------------------------------
// "Demo evidence" — a recorded, agent-watched product demo as first-class
// Keyoku evidence. Generic for any project: `keyoku demo init` writes a
// .keyoku/demo.yaml script, `keyoku demo record` drives a real browser
// through it and captures one screenshot ("frame") per stop, and `keyoku
// demo watch` has an agent look at the frames against the expectations the
// project author wrote and produce a machine-checkable verdict. `keyoku demo
// watch --assert` closes the loop as an outcome criterion probe.
// ---------------------------------------------------------------------------

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lowercase letters, numbers, dots, dashes, or underscores");

const ActionSchema = z.union([
  z.object({ goto: z.string().min(1) }).strict(),
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ fill: z.object({ selector: z.string().min(1), value: z.string() }) }).strict(),
  z.object({ select: z.object({ selector: z.string().min(1), label: z.string().min(1) }) }).strict(),
  z.object({ press: z.string().min(1) }).strict(),
  z.object({ waitMs: z.number().int().nonnegative() }).strict(),
]);

const StopSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  actions: z.array(ActionSchema).default([]),
  expect: z.array(z.string().min(1)).min(1),
  caption: z.string().min(1).optional(),
  fullPage: z.boolean().optional(),
});

const DemoConfigSchema = z.object({
  baseUrl: z.string().min(1),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  settleMs: z.number().int().nonnegative().default(2500),
  fullPage: z.boolean().default(true),
  auth: z.object({ url: z.string().min(1), steps: z.array(ActionSchema).default([]) }).optional(),
  stops: z.array(StopSchema).min(1),
});

const ManifestSchema = z.object({
  recordedAt: z.string().min(1),
  baseUrl: z.string().min(1),
  stops: z.array(z.object({
    id: z.string().min(1),
    order: z.number().int().nonnegative(),
    frame: z.string().min(1),
    title: z.string().optional(),
    expect: z.array(z.string()),
    caption: z.string().optional(),
  })),
});

const VerdictSchema = z.object({
  watched_at: z.string().min(1),
  frames: z.array(z.object({
    id: z.string().min(1),
    requirement_met: z.union([z.boolean(), z.literal("partial")]),
    evidence_seen: z.string().min(1),
    concerns: z.array(z.string()).default([]),
  })),
  overall: z.object({
    frames_pass: z.number().int().nonnegative(),
    frames_partial: z.number().int().nonnegative(),
    frames_fail: z.number().int().nonnegative(),
    verdict: z.enum(["pass", "fail"]),
    summary: z.string().min(1),
  }),
  uiux_audit: z.object({
    findings: z.array(z.object({
      severity: z.enum(["high", "medium", "low"]),
      description: z.string().min(1),
      suggested_fix: z.string().optional(),
    })).default([]),
    top_priorities: z.array(z.string()).default([]),
  }),
});

type Action = z.infer<typeof ActionSchema>;
type DemoConfig = z.infer<typeof DemoConfigSchema>;
type DemoManifest = z.infer<typeof ManifestSchema>;
type DemoVerdict = z.infer<typeof VerdictSchema>;

const DEMO_TEMPLATE = `# .keyoku/demo.yaml — Keyoku demo evidence: record -> watch -> gate
#
# This file describes a scripted walk through your running app.
# \`keyoku demo record\` drives a real browser through it and captures one
# screenshot per "stop"; \`keyoku demo watch\` has an agent look at those
# screenshots against the expectations you write below and writes a verdict
# you can gate on with \`keyoku demo watch --assert\`.

# baseUrl: where the app is running (e.g. your local dev server).
baseUrl: http://localhost:3000

# viewport: optional, defaults to 1440x900.
# viewport:
#   width: 1440
#   height: 900

# settleMs: how long to wait after navigating/acting, before the screenshot
# (default 2500). Give async UI (spinners, charts, animations) time to settle.
# settleMs: 2500

# fullPage: capture the full scrollable page, not just the viewport (default
# true). Can also be set per-stop below.
# fullPage: true

# auth: optional. Runs ONCE, before the first stop — e.g. to log in.
# auth:
#   url: /login
#   steps:
#     - fill:
#         selector: "#email"
#         value: "demo@example.com"
#     - fill:
#         selector: "#password"
#         value: "demo-password"
#     - click: "button[type=submit]"
#     - waitMs: 1000

# stops: the ordered walk through the product. Each stop navigates (if url is
# given, relative to baseUrl or absolute), runs its actions in order, waits
# settleMs, then takes one screenshot ("frame").
#
# expect: REQUIRED, at least one per stop. Plain-language, human-readable
# assertions about what must be VISIBLE in that frame — this is what the
# watching agent checks the screenshot against.
stops:
  - id: dashboard
    title: Dashboard
    url: /dashboard
    expect:
      - "The main navigation is visible"
      - "At least one summary metric card is rendered with a non-empty value"
    caption: "Landing view after login"

  # - id: settings
  #   url: /settings
  #   actions:
  #     - click: "#nav-settings"
  #     - waitMs: 500
  #   expect:
  #     - "The settings form is visible with labeled fields"
  #   caption: "Settings page"
`;

function configPath(root: string): string {
  return join(root, KEYOKU_DIR, "demo.yaml");
}

function demoDir(root: string): string {
  return join(root, KEYOKU_DIR, "demo");
}

function manifestPath(root: string): string {
  return join(demoDir(root), "manifest.json");
}

function verdictPath(root: string): string {
  return join(demoDir(root), "verdict.json");
}

function demoInit(): void {
  const root = resolve(process.cwd());
  mkdirSync(join(root, KEYOKU_DIR), { recursive: true });
  const path = configPath(root);
  if (existsSync(path)) {
    throw new Error(`${relative(root, path) || "demo.yaml"} already exists; Keyoku will not overwrite it.`);
  }
  writeFileSync(path, DEMO_TEMPLATE, "utf8");
  console.log(`Created ${relative(root, path)}.

Edit baseUrl and stops for your app, then:
  keyoku demo record          Launch a real browser, capture one screenshot per stop
  keyoku demo watch           An agent watches the frames, writes .keyoku/demo/verdict.json
  keyoku demo watch --assert  Exit 0 only if the watched demo passed AND is fresh

Paste this into an outcome's criteria (.keyoku/outcomes/<id>.yaml) to make the
watched demo part of the proof:

  - description: "The recorded product demo passes agent review"
    probe:
      kind: command
      run: "keyoku demo record && keyoku demo watch --assert"
      timeoutMs: 900000
    assert:
      path: exitCode
      op: eq
      value: 0
    evidence:
      summary: "An agent watched the recorded demo frames against their stated expectations and ran a UI/UX audit."
      whyItMatters: "The demo is recorded evidence, not a claim about it — the same frames a human would watch are what the agent checked."
      code: []
      artifacts:
        - kind: screenshot
          path: ".keyoku/demo/frames/*.jpeg"
          label: "Recorded demo frames"
          caption: "One frame per stop, captured by keyoku demo record"
`);
}

function readDemoConfig(path: string): DemoConfig {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = DemoConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid ${path}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

/** Resolve playwright from the TARGET project (the one being demoed), not
 * from keyoku's own install — keyoku itself does not depend on playwright.
 * The `specifier` indirection keeps this a non-literal dynamic import so
 * TypeScript doesn't try (and fail) to resolve playwright's types at
 * keyoku's own compile time. */
async function loadChromium(root: string): Promise<{ launch: (options?: Record<string, unknown>) => Promise<any> }> {
  let mod: any;
  try {
    const req = createRequire(join(root, "package.json"));
    const resolved = req.resolve("playwright");
    mod = await import(pathToFileURL(resolved).href);
  } catch {
    try {
      const specifier = "playwright";
      mod = await import(specifier);
    } catch {
      throw new Error(
        "Playwright is not installed in this project.\n" +
          "Run `npm i -D playwright` (and `npx playwright install chromium` if browsers " +
          "aren't installed yet), then re-run `keyoku demo record`.",
      );
    }
  }
  return mod.chromium;
}

function resolveAgainst(baseUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${baseUrl.replace(/\/+$/, "")}/${target.replace(/^\/+/, "")}`;
}

async function runAction(page: any, action: Action, baseUrl: string): Promise<void> {
  if ("goto" in action) {
    await page.goto(resolveAgainst(baseUrl, action.goto));
  } else if ("click" in action) {
    await page.click(action.click);
  } else if ("fill" in action) {
    await page.fill(action.fill.selector, action.fill.value);
  } else if ("select" in action) {
    await page.selectOption(action.select.selector, { label: action.select.label });
  } else if ("press" in action) {
    await page.keyboard.press(action.press);
  } else {
    await page.waitForTimeout(action.waitMs);
  }
}

async function demoRecord(): Promise<void> {
  const root = resolve(process.cwd());
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new Error(`No ${relative(root, path)} found. Run 'keyoku demo init' first.`);
  }
  const config = readDemoConfig(path);
  const chromium = await loadChromium(root);
  const framesDir = join(demoDir(root), "frames");
  mkdirSync(framesDir, { recursive: true });

  console.log(`Recording ${config.stops.length} stop(s) from ${config.baseUrl}…`);
  const browser = await chromium.launch();
  const results: DemoManifest["stops"] = [];
  const failures: string[] = [];
  try {
    const context = await browser.newContext({ viewport: config.viewport ?? { width: 1440, height: 900 } });
    const page = await context.newPage();

    if (config.auth) {
      await page.goto(resolveAgainst(config.baseUrl, config.auth.url));
      for (const action of config.auth.steps) await runAction(page, action, config.baseUrl);
    }

    let order = 0;
    for (const stop of config.stops) {
      order += 1;
      try {
        if (stop.url) await page.goto(resolveAgainst(config.baseUrl, stop.url));
        for (const action of stop.actions) await runAction(page, action, config.baseUrl);
        await page.waitForTimeout(config.settleMs);
        const frameName = `${String(order).padStart(2, "0")}-${stop.id}.jpeg`;
        const framePath = join(framesDir, frameName);
        await page.screenshot({
          path: framePath,
          type: "jpeg",
          quality: 80,
          animations: "disabled",
          fullPage: stop.fullPage ?? config.fullPage,
        });
        results.push({
          id: stop.id,
          order,
          frame: `${KEYOKU_DIR}/demo/frames/${frameName}`,
          ...(stop.title ? { title: stop.title } : {}),
          expect: stop.expect,
          ...(stop.caption ? { caption: stop.caption } : {}),
        });
        console.log(`  [${order}/${config.stops.length}] ${stop.id} -> ${frameName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${stop.id}: ${message}`);
        console.error(`  [${order}/${config.stops.length}] ${stop.id} FAILED — ${message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const manifest: DemoManifest = {
    recordedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    stops: results,
  };
  mkdirSync(demoDir(root), { recursive: true });
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`\nRecorded ${results.length}/${config.stops.length} stop(s) -> ${relative(root, manifestPath(root))}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} stop(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
  }
}

function buildWatchPrompt(root: string, manifest: DemoManifest): string {
  const target = verdictPath(root);
  const framesBlock = manifest.stops
    .map((stop) => {
      const heading = `Stop "${stop.id}"${stop.title ? ` (${stop.title})` : ""} — frame: ${stop.frame}`;
      const expectations = stop.expect.map((e) => `    - ${e}`).join("\n");
      const caption = stop.caption ? `\n  Caption: ${stop.caption}` : "";
      return `${heading}\n  Must be visible / true in this frame:\n${expectations}${caption}`;
    })
    .join("\n\n");

  return `You are reviewing a recorded product demo captured as a sequence of screenshots ("frames"), one per "stop". Base URL: ${manifest.baseUrl}. Recorded at: ${manifest.recordedAt}.

For EACH stop below, open its frame (an image file — actually look at it, do not assume) and:
  (a) Check every "must be visible" expectation against what is ACTUALLY visible in the frame.
  (b) Record requirement_met as true (every expectation for this stop is clearly satisfied), false (something required is missing, wrong, or broken), or "partial" (some expectations met, some not, or ambiguous) — plus a short evidence_seen note describing what you actually observed, and any concerns.

Stops:

${framesBlock}

ALSO run a UI/UX audit across ALL the frames together, independent of the per-stop expectations above: visual hierarchy, information density, text truncation, empty or broken charts/tables, color semantics (e.g. red/green misuse), and cross-page consistency (spacing, typography, component reuse). Produce findings with a severity of "high", "medium", or "low" and a suggested_fix for each; then pick the handful that matter most as top_priorities.

When you are done, WRITE the file ${target} containing EXACTLY this JSON shape (no markdown code fences, no extra top-level keys):

{
  "watched_at": "<ISO 8601 timestamp, now>",
  "frames": [
    { "id": "<stop id>", "requirement_met": true, "evidence_seen": "<what you actually saw>", "concerns": [] }
  ],
  "overall": {
    "frames_pass": <count of frames with requirement_met === true>,
    "frames_partial": <count of frames with requirement_met === "partial">,
    "frames_fail": <count of frames with requirement_met === false>,
    "verdict": "pass",
    "summary": "<1-3 sentence summary of what the demo shows and any risk>"
  },
  "uiux_audit": {
    "findings": [
      { "severity": "medium", "description": "<finding>", "suggested_fix": "<fix>" }
    ],
    "top_priorities": ["<most important fix>"]
  }
}

Rules for "overall.verdict": it must be "pass" if and only if NO frame has requirement_met === false. If any frame is false, "overall.verdict" must be "fail".

Contract note for any agent runner substituted for this CLI wrapper: the only hard requirement is that ${target} exists after the run and matches this exact shape — how you get there (tool calls, reasoning) is up to you.`;
}

async function demoWatch(rest: string[]): Promise<void> {
  const assertMode = rest.includes("--assert");
  const root = resolve(process.cwd());
  const mPath = manifestPath(root);
  if (!existsSync(mPath)) {
    throw new Error(`No ${relative(root, mPath)} found. Run 'keyoku demo record' first.`);
  }
  let manifest: DemoManifest;
  {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(mPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot parse ${mPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = ManifestSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid ${mPath}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    manifest = result.data;
  }

  const availability = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (availability.status !== 0) {
    console.error(
      "No agent runner available: the `claude` CLI was not found on PATH.\n" +
        "`keyoku demo watch` needs an agent that can view images and write a file.\n" +
        `Any runner may be substituted, as long as it writes ${verdictPath(root)} matching the\n` +
        "verdict contract (watched_at, frames[], overall{frames_pass,frames_partial,frames_fail,verdict,summary}, uiux_audit{findings[],top_priorities[]}) — see docs/demo-evidence.md.",
    );
    process.exit(2);
  }

  const prompt = buildWatchPrompt(root, manifest);
  console.log(`Watching ${manifest.stops.length} frame(s) with \`claude\`…`);
  const run = spawnSync("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], {
    cwd: root,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    console.error(`\`claude\` exited with status ${run.status ?? "unknown"}.`);
    process.exit(run.status && run.status > 0 ? run.status : 1);
  }

  const vPath = verdictPath(root);
  if (!existsSync(vPath)) {
    console.error(`The agent run finished but ${vPath} was not written. See the verdict contract in docs/demo-evidence.md.`);
    process.exit(assertMode ? 1 : 2);
  }
  let verdict: DemoVerdict;
  try {
    const raw = JSON.parse(readFileSync(vPath, "utf8"));
    const result = VerdictSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    verdict = result.data;
  } catch (error) {
    console.error(`${vPath} does not match the verdict contract: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(assertMode ? 1 : 2);
    return;
  }

  console.log(
    `\nVerdict: ${verdict.overall.verdict.toUpperCase()} — ${verdict.overall.frames_pass} pass, ${verdict.overall.frames_partial} partial, ${verdict.overall.frames_fail} fail`,
  );
  console.log(verdict.overall.summary);
  const failing = verdict.frames.filter((f) => f.requirement_met !== true);
  if (failing.length > 0) {
    console.log("\nFrames needing attention:");
    for (const f of failing) {
      const tag = f.requirement_met === false ? "FAIL" : "PARTIAL";
      console.log(`  [${tag}] ${f.id} — ${f.evidence_seen}${f.concerns.length ? ` (${f.concerns.join("; ")})` : ""}`);
    }
  }
  if (verdict.uiux_audit.findings.length > 0) {
    console.log(`\nUI/UX audit: ${verdict.uiux_audit.findings.length} finding(s)`);
    for (const finding of verdict.uiux_audit.findings.slice(0, 5)) {
      console.log(`  [${finding.severity}] ${finding.description}`);
    }
  }

  if (!assertMode) return;

  const fresh = new Date(verdict.watched_at).getTime() > new Date(manifest.recordedAt).getTime();
  if (verdict.overall.verdict === "pass" && fresh) {
    console.log("\nkeyoku demo watch --assert: PASS");
    process.exitCode = 0;
    return;
  }
  console.error(
    `\nkeyoku demo watch --assert: FAIL — ${
      verdict.overall.verdict !== "pass"
        ? `verdict is '${verdict.overall.verdict}' (${verdict.overall.frames_fail} failing frame(s))`
        : `verdict.watched_at (${verdict.watched_at}) is not newer than manifest.recordedAt (${manifest.recordedAt}); re-run 'keyoku demo record' then 'keyoku demo watch'`
    }`,
  );
  process.exitCode = 1;
}

export async function demoCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "init") return demoInit();
  if (sub === "record") return demoRecord();
  if (sub === "watch") return demoWatch(rest);
  throw new Error("Usage: keyoku demo init|record|watch [--assert]");
}
