// Dogfood probe: run the pattern detector against YOUR real activity log.
// Run: npx tsx scripts/suggest-local.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectPatterns } from "../src/activity.js";
import type { ActivityEvent } from "../src/types.js";

const path = process.env.KEYOKU_HOME
  ? join(process.env.KEYOKU_HOME, "activity.jsonl")
  : join(homedir(), ".keyoku", "activity.jsonl");

const events: ActivityEvent[] = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .flatMap((l) => {
    try { return [JSON.parse(l) as ActivityEvent]; } catch { return []; }
  });

const win = Number(process.env.KEYOKU_WINDOW ?? 5000);
console.log(`Events: ${events.length} (from ${path}, window ${win})\n`);
const suggestions = detectPatterns(events, 3, win);
console.log(`Suggestions: ${suggestions.length}\n`);
for (const s of suggestions) {
  console.log(`■ [${s.kind}] ${s.name}   [count=${s.count}, steps=${s.draftSteps.length}]`);
  for (const st of s.draftSteps) {
    console.log(`    - [${st.type}] ${(st.command ?? st.prompt ?? st.summary).slice(0, 100)}`);
  }
  console.log();
}
