import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bytesDigest, canonicalJson, canonicalJsonDigest } from "../src/canonical-json.js";
import { readVerifiedFactfile } from "../src/contribution.js";
import {
  PulseConformanceManifestSchema,
  buildPulseConformanceVectors,
} from "../src/pulse-conformance.js";
import {
  PulseAssetSchema,
  PulseEventSchema,
  planPulseDispatch,
  replayPulseEvents,
  type PulseDispatchDecision,
  type PulseEvent,
} from "../src/pulse.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(repositoryRoot, "fixtures", "conformance", "v1");

function readEvents(path: string): PulseEvent[] {
  return readFileSync(join(fixtureRoot, path), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => PulseEventSchema.parse(JSON.parse(line)));
}

function decisionExpectation(decision: PulseDispatchDecision): Record<string, unknown> {
  return {
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    failClosed: decision.failClosed,
    checkpointIds: decision.checkpointIds,
    ...(decision.snapshot ? { snapshotContentDigest: decision.snapshot.contentDigest } : {}),
    ...(decision.frozenSnapshot ? { frozenSnapshotContentDigest: decision.frozenSnapshot.contentDigest } : {}),
  };
}

describe("Pulse cross-implementation conformance vectors", () => {
  it("keeps every exported file byte-for-byte aligned with the source builder", () => {
    const vectors = buildPulseConformanceVectors();
    const manifest = PulseConformanceManifestSchema.parse(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")));
    expect(manifest).toEqual(vectors.manifest);
    expect(readFileSync(join(fixtureRoot, manifest.bytes.factfile.path), "utf8")).toBe(vectors.factfileBytes);
    expect(readFileSync(join(fixtureRoot, manifest.bytes.asset.path), "utf8")).toBe(vectors.assetBytes);
    expect(readFileSync(join(fixtureRoot, manifest.bytes.poster.path), "utf8")).toBe(vectors.posterBytes);
    for (const [id, path] of Object.entries(manifest.eventSets)) {
      expect(readEvents(path)).toEqual(vectors.eventSets[id]);
    }
  });

  it("binds canonical JSON, raw Factfile bytes, and poster assets to exact digests", () => {
    const manifest = PulseConformanceManifestSchema.parse(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")));
    for (const vector of manifest.canonicalJson) {
      expect(canonicalJson(vector.input)).toBe(vector.canonical);
      expect(canonicalJsonDigest(vector.input)).toBe(vector.digest);
    }
    const factfilePath = join(fixtureRoot, manifest.bytes.factfile.path);
    const factfileBytes = readFileSync(factfilePath);
    expect(factfileBytes).toHaveLength(manifest.bytes.factfile.byteLength);
    expect(bytesDigest(factfileBytes)).toBe(manifest.bytes.factfile.bytesDigest);
    expect(readVerifiedFactfile(factfilePath).digest).toBe(manifest.bytes.factfile.factfileDigest);

    const { byteLength, ...asset } = manifest.bytes.asset;
    expect(PulseAssetSchema.parse(asset)).toEqual(asset);
    const assetBytes = readFileSync(join(fixtureRoot, asset.path));
    const posterBytes = readFileSync(join(fixtureRoot, asset.posterPath));
    expect(assetBytes).toHaveLength(byteLength);
    expect(bytesDigest(assetBytes)).toBe(asset.digest);
    expect(bytesDigest(posterBytes)).toBe(asset.posterDigest);
    expect(asset.posterDigest).toBe(manifest.bytes.poster.posterDigest);
  });

  it("replays canonical and reversed inputs identically and rejects same-time ambiguity", () => {
    const manifest = PulseConformanceManifestSchema.parse(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")));
    for (const vector of manifest.ordering) {
      const events = readEvents(manifest.eventSets[vector.eventSet]!);
      if (vector.expectedErrorIncludes) {
        expect(() => replayPulseEvents(events)).toThrow(vector.expectedErrorIncludes);
        continue;
      }
      const replay = replayPulseEvents(events);
      expect(replay.events.map((event) => event.id)).toEqual(vector.expectedEventIds);
      expect(replay.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(vector.expectedCheckpointIds);
    }
  });

  it("freezes all required dispatcher outcomes and fails closed on source conflict", () => {
    const manifest = PulseConformanceManifestSchema.parse(JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")));
    for (const vector of manifest.dispatch) {
      const events = readEvents(manifest.eventSets[vector.eventSet]!);
      expect(decisionExpectation(planPulseDispatch({ events, ...vector.plan }))).toEqual(vector.expected);
    }
    expect(new Set(manifest.dispatch.map((vector) => vector.expected.outcome))).toEqual(new Set(["send", "defer", "coalesce", "stale_no_send", "deduplicate", "suppress"]));
    const conflict = manifest.dispatch.find((vector) => vector.id === manifest.sourceConflict.dispatchVector);
    expect(conflict).toMatchObject({ eventSet: manifest.sourceConflict.eventSet, expected: { outcome: "suppress", reasonCode: "source_conflict", failClosed: true } });
  });
});
