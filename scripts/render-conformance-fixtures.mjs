import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPulseConformanceVectors } from "../dist/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(repositoryRoot, "fixtures", "conformance", "v1");
const vectors = buildPulseConformanceVectors();
const write = (path, value) => {
  const absolute = join(outputRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, value);
};
const jsonl = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

write("manifest.json", `${JSON.stringify(vectors.manifest, null, 2)}\n`);
for (const [id, events] of Object.entries(vectors.eventSets)) write(`events/${id}.jsonl`, jsonl(events));
write(vectors.manifest.bytes.factfile.path, vectors.factfileBytes);
write(vectors.manifest.bytes.asset.path, vectors.assetBytes);
write(vectors.manifest.bytes.poster.path, vectors.posterBytes);

console.log(`Rendered Pulse conformance vectors under ${outputRoot}`);
