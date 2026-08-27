import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGenericPulseFixture,
  buildProcessyardPulseFixture,
  planPulseDispatch,
} from "../dist/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "fixtures", "pulse");
mkdirSync(out, { recursive: true });

const generic = buildGenericPulseFixture();
const processyard = buildProcessyardPulseFixture();
const jsonl = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

writeFileSync(join(out, "generic.jsonl"), jsonl(generic.events), "utf8");
writeFileSync(join(out, "processyard-m0-m6.jsonl"), jsonl(processyard.events), "utf8");

const coalesced = planPulseDispatch({ events: processyard.events, ...processyard.coalescingPlan });
if (coalesced.outcome !== "suppress" || coalesced.reasonCode !== "attested_checkpoint" || coalesced.snapshot) throw new Error(`Expected attested fixture suppression, received ${coalesced.outcome}/${coalesced.reasonCode}.`);
writeFileSync(join(out, "processyard-coalesced.json"), `${JSON.stringify(coalesced, null, 2)}\n`, "utf8");
writeFileSync(join(out, "processyard-timeline.html"), "<!doctype html><meta charset=\"utf-8\"><title>Attested fixture — no projection</title><p>This synthetic fixture is attested, not locally verified. Keyoku correctly produced no dispatchable timeline.</p>\n", "utf8");

const stale = planPulseDispatch({ events: processyard.events, ...processyard.recommendedPlan });
if (stale.outcome !== "stale_no_send") throw new Error(`Expected Processyard stale_no_send, received ${stale.outcome}.`);
writeFileSync(join(out, "processyard-stale-no-send.json"), `${JSON.stringify(stale, null, 2)}\n`, "utf8");

console.log(`Rendered Pulse fixtures under ${out}`);
