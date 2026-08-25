import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGenericPulseFixture,
  buildProcessyardPulseFixture,
  planPulseDispatch,
  renderPulseProjection,
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
if (coalesced.outcome !== "coalesce" || !coalesced.snapshot) throw new Error(`Expected Processyard coalesce, received ${coalesced.outcome}.`);
writeFileSync(join(out, "processyard-coalesced.json"), `${JSON.stringify(coalesced, null, 2)}\n`, "utf8");
writeFileSync(join(out, "processyard-timeline.html"), renderPulseProjection(coalesced.snapshot, "timeline"), "utf8");

const stale = planPulseDispatch({ events: processyard.events, ...processyard.recommendedPlan });
if (stale.outcome !== "stale_no_send") throw new Error(`Expected Processyard stale_no_send, received ${stale.outcome}.`);
writeFileSync(join(out, "processyard-stale-no-send.json"), `${JSON.stringify(stale, null, 2)}\n`, "utf8");

console.log(`Rendered Pulse fixtures under ${out}`);
