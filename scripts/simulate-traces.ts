// Empirical test: does the heuristic detector find real workflows in
// realistic Claude Code activity traces, and what would an SLM add?
// Run: npx tsx scripts/simulate-traces.ts
import { detectPatterns, enrichWithEntities } from "../src/activity.js";
import type { ActivityEvent } from "../src/types.js";

let n = 0;
function ev(tool: string, cmdOrPath: string): ActivityEvent {
  n += 1;
  const summary =
    tool === "Bash" ? `Bash: ${cmdOrPath.slice(0, 80)}` : `${tool}: ${cmdOrPath}`;
  return enrichWithEntities({
    id: `ev_${n}`,
    type: tool === "Bash" ? (cmdOrPath.startsWith("git ") ? "git" : "shell") : tool === "Edit" || tool === "Write" ? "file_change" : "tool_use",
    summary,
    ...(tool === "Bash" ? { detail: cmdOrPath.slice(0, 500) } : {}),
    tool,
    at: new Date(2026, 5, 1, 9, 0, n).toISOString(),
  });
}

const events: ActivityEvent[] = [];
const srcFiles = ["src/server.ts", "src/store.ts", "src/activity.ts", "src/engine.ts", "src/types.ts"];
const commitMsgs = [
  'fix: handle empty activity log in suggest',
  'feat: add cwd support to bash steps',
  'fix: step index validation in execution_complete',
  'refactor: extract advanceExecution helper',
];

// ---- Workflow A: test-fix-commit-push loop (planted 4×, with realistic variation)
function sessionA(round: number) {
  events.push(ev("Read", `/Users/dev/proj/${srcFiles[round % 5]}`));
  events.push(ev("Edit", `/Users/dev/proj/${srcFiles[(round + 1) % 5]}`));
  events.push(ev("Bash", "npm test"));
  events.push(ev("Edit", `/Users/dev/proj/${srcFiles[(round + 2) % 5]}`));
  events.push(ev("Bash", "npm test"));
  events.push(ev("Bash", "git add -A"));
  events.push(ev("Bash", `git commit -m "${commitMsgs[round % 4]}"`));
  events.push(ev("Bash", "git push"));
}

// ---- Workflow B: deploy routine (planted 3×)
function sessionB() {
  events.push(ev("Bash", "npm run build"));
  events.push(ev("Bash", "npm test"));
  events.push(ev("Bash", "gcloud run deploy api --region us-central1 --quiet"));
  events.push(ev("Bash", "curl -sf https://staging.example.dev/health"));
}

// ---- Noise: the stuff real sessions are full of
const noisePool = [
  () => ev("Read", `/Users/dev/proj/docs/notes-${n}.md`),
  () => ev("Bash", `ls -la src/`),
  () => ev("Bash", `grep -rn "TODO" src/ | head -${(n % 9) + 1}`),
  () => ev("Read", `/Users/dev/proj/package.json`),
  () => ev("Bash", `cat /tmp/out-${n}.log`),
  () => ev("Write", `/tmp/scratch-${n}.md`),
  () => ev("Bash", "npm install lodash"),
  () => ev("Bash", `git diff --stat`),
];
function noise(count: number) {
  for (let i = 0; i < count; i++) events.push(noisePool[(n + i) % noisePool.length]());
}

// Interleave like a real week: noise around and between planted workflows
noise(8);
sessionA(0);
noise(5);
sessionB();
noise(7);
sessionA(1);
noise(4);
sessionB();
noise(6);
sessionA(2);
noise(5);
sessionB();
noise(3);
sessionA(3);
noise(9);

console.log(`Total events: ${events.length}\n`);
const suggestions = detectPatterns(events, 3, 300);
console.log(`Suggestions: ${suggestions.length}\n`);
for (const s of suggestions) {
  console.log(`■ ${s.name}   [count=${s.count}, steps=${s.draftSteps.length}]`);
  console.log(`  slug: ${s.slug}`);
  console.log(`  desc: ${s.description.slice(0, 140)}`);
  for (const st of s.draftSteps) {
    console.log(`    - [${st.type}] ${st.command ?? st.prompt ?? st.summary}`);
  }
  console.log();
}
