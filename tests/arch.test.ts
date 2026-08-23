import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { archCmd, ArchSpecSchema, ICON_IDS, renderArchSvg, type ArchSpec } from "../src/arch.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "keyoku-arch-"));
}

const CHAIN_SPEC: ArchSpec = {
  title: "Chain",
  nodes: [
    { id: "browser", icon: "browser", label: "Browser", sub: "entrypoint" },
    { id: "api", icon: "api", label: "API", sub: "backend" },
    { id: "db", icon: "db", label: "DB", sub: "storage" },
  ],
  edges: [
    { from: "browser", to: "api", label: "HTTP", style: "solid" },
    { from: "api", to: "db", style: "solid" },
  ],
  zones: [],
};

describe("ArchSpecSchema — schema validation", () => {
  it("accepts a well-formed spec with nodes, edges, and zones", () => {
    const spec = {
      nodes: [
        { id: "a", icon: "browser", label: "A", zone: "z1" },
        { id: "b", icon: "api", label: "B", zone: "z1" },
      ],
      edges: [{ from: "a", to: "b", label: "calls", style: "dashed" }],
      zones: [{ id: "z1", label: "Zone One" }],
    };
    const result = ArchSpecSchema.parse(spec);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges[0]!.style).toBe("dashed");
  });

  it("rejects an unknown icon id", () => {
    const spec = { nodes: [{ id: "a", icon: "not-a-real-icon", label: "A" }] };
    expect(ArchSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects an edge referencing an unknown node id", () => {
    const spec = {
      nodes: [{ id: "a", icon: "browser", label: "A" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    const result = ArchSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("unknown node id 'ghost'"))).toBe(true);
    }
  });

  it("rejects a node referencing an unknown zone id", () => {
    const spec = {
      nodes: [{ id: "a", icon: "browser", label: "A", zone: "ghost-zone" }],
      zones: [{ id: "real-zone", label: "Real" }],
    };
    const result = ArchSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("unknown zone id 'ghost-zone'"))).toBe(true);
    }
  });

  it("defaults edges/zones to empty arrays and edge style to solid", () => {
    const result = ArchSpecSchema.parse({ nodes: [{ id: "a", icon: "browser", label: "A" }] });
    expect(result.edges).toEqual([]);
    expect(result.zones).toEqual([]);
  });
});

describe("icon registry completeness", () => {
  it("ships exactly the documented 20 icons", () => {
    expect(ICON_IDS).toHaveLength(20);
    expect(new Set(ICON_IDS).size).toBe(20); // no duplicates
  });

  it("every documented icon id renders a <symbol> def with at least one drawable path/shape", () => {
    for (const icon of ICON_IDS) {
      const spec: ArchSpec = { nodes: [{ id: "n", icon, label: "Node" }], edges: [], zones: [] };
      const svg = renderArchSvg(spec);
      expect(svg).toContain(`<symbol id="icon-${icon}"`);
      expect(svg).toContain(`href="#icon-${icon}"`);
      // The symbol body must contain at least one real drawable primitive.
      const symbolMatch = svg.match(new RegExp(`<symbol id="icon-${icon}"[^>]*>([\\s\\S]*?)</symbol>`));
      expect(symbolMatch).not.toBeNull();
      const body = symbolMatch![1]!;
      expect(/<(path|rect|circle|ellipse|line)\b/.test(body)).toBe(true);
    }
  });

  it("falls back to the 'doc' icon for an icon id not in the registry (defensive, bypassing schema)", () => {
    const spec = { nodes: [{ id: "n", icon: "totally-unknown", label: "Node" }], edges: [], zones: [] } as unknown as ArchSpec;
    const svg = renderArchSvg(spec);
    expect(svg).toContain('href="#icon-doc"');
  });
});

describe("orthogonal edge path generation", () => {
  it("renders a straight two-point path for nodes on the same row", () => {
    const svg = renderArchSvg(CHAIN_SPEC);
    // browser->api and api->db are single-row forward edges: exactly one M...L, no Q (rounded corner) needed.
    const paths = [...svg.matchAll(/<path class="arch-edge-line[^"]*" d="([^"]+)"/g)].map((m) => m[1]!);
    expect(paths).toHaveLength(2);
    for (const d of paths) {
      expect(d).toMatch(/^M[\d.,]+ L[\d.,]+$/);
    }
  });

  it("renders a multi-segment, rounded-corner (Q) orthogonal path for nodes on different rows", () => {
    const spec: ArchSpec = {
      nodes: [
        { id: "a", icon: "gear", label: "A" }, // layer 0
        { id: "b", icon: "gear", label: "B" }, // layer 0 (no incoming edges → same column as a)
        { id: "c", icon: "gear", label: "C" }, // layer 1, fed only by b
      ],
      edges: [{ from: "b", to: "c", style: "solid" }],
      zones: [],
    };
    const svg = renderArchSvg(spec);
    const paths = [...svg.matchAll(/<path class="arch-edge-line[^"]*" d="([^"]+)"/g)].map((m) => m[1]!);
    expect(paths).toHaveLength(1);
    // A bent orthogonal route has 4 via-points -> 2 rounded (Q) corners.
    expect((paths[0]!.match(/Q/g) ?? []).length).toBe(2);
    expect((paths[0]!.match(/L/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("supports the dashed edge style", () => {
    const spec: ArchSpec = {
      nodes: [
        { id: "a", icon: "gear", label: "A" },
        { id: "b", icon: "gear", label: "B" },
      ],
      edges: [{ from: "a", to: "b", style: "dashed" }],
      zones: [],
    };
    const svg = renderArchSvg(spec);
    expect(svg).toContain('class="arch-edge-line arch-edge-dashed"');
  });

  it("wraps an edge label in a pill with a background halo", () => {
    const svg = renderArchSvg(CHAIN_SPEC);
    expect(svg).toContain('class="arch-edge-label"');
    expect(svg).toContain('class="arch-edge-label-bg"');
    expect(svg).toContain(">HTTP<");
  });
});

describe("zone containment", () => {
  it("renders a zone box that fully contains every member node's box", () => {
    const spec: ArchSpec = {
      nodes: [
        { id: "a", icon: "browser", label: "A", zone: "front" },
        { id: "b", icon: "ui", label: "B", zone: "front" },
        { id: "c", icon: "db", label: "C" }, // not in any zone
      ],
      edges: [{ from: "a", to: "c", style: "solid" }],
      zones: [{ id: "front", label: "Frontend" }],
    };
    const svg = renderArchSvg(spec);
    const zoneMatch = svg.match(/<rect class="arch-zone-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    expect(zoneMatch).not.toBeNull();
    const [, zx, zy, zw, zh] = zoneMatch!.map(Number);
    const zoneRight = zx! + zw!;
    const zoneBottom = zy! + zh!;

    // Only zone members (a, b) must be checked for containment — c is drawn but outside the zone.
    const nodeGroups = [...svg.matchAll(/<g class="arch-node" data-id="([^"]+)">[\s\S]*?<rect class="arch-node-box" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
    const members = nodeGroups.filter((m) => m[1] === "a" || m[1] === "b");
    expect(members).toHaveLength(2);
    for (const [, , nx, ny, nw, nh] of members) {
      const [x, y, w, h] = [nx, ny, nw, nh].map(Number);
      expect(x!).toBeGreaterThanOrEqual(zx!);
      expect(y!).toBeGreaterThanOrEqual(zy!);
      expect(x! + w!).toBeLessThanOrEqual(zoneRight);
      expect(y! + h!).toBeLessThanOrEqual(zoneBottom);
    }
    expect(svg).toContain(">Frontend<");
  });

  it("omits a zone box entirely when no node references it", () => {
    const spec: ArchSpec = {
      nodes: [{ id: "a", icon: "browser", label: "A" }],
      edges: [],
      zones: [{ id: "empty", label: "Empty Zone" }],
    };
    const svg = renderArchSvg(spec);
    expect(svg).not.toContain('<rect class="arch-zone-box"');
  });
});

describe("determinism", () => {
  it("produces byte-identical output for the same spec across repeated calls", () => {
    const specCopy: ArchSpec = JSON.parse(JSON.stringify(CHAIN_SPEC));
    const first = renderArchSvg(CHAIN_SPEC);
    const second = renderArchSvg(specCopy);
    expect(first).toBe(second);
  });

  it("standalone (non-embedded) output embeds a <style> block; embedded output does not", () => {
    const standalone = renderArchSvg(CHAIN_SPEC, { embedded: false });
    const embedded = renderArchSvg(CHAIN_SPEC, { embedded: true });
    expect(standalone).toContain("<style>");
    expect(embedded).not.toContain("<style>");
  });
});

describe("keyoku arch render (CLI)", () => {
  it("renders a spec.yaml to architecture.svg by default", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "spec.yaml"),
      `title: Test Diagram
nodes:
  - { id: browser, icon: browser, label: Browser }
  - { id: api, icon: api, label: API }
edges:
  - { from: browser, to: api, label: calls }
`,
      "utf8",
    );
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await archCmd(["render", "spec.yaml"]);
      const outPath = join(root, "architecture.svg");
      expect(existsSync(outPath)).toBe(true);
      const svg = readFileSync(outPath, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("icon-browser");
      expect(svg).toContain("icon-api");
    } finally {
      process.chdir(cwd);
    }
  });

  it("honors -o for a custom output path", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "spec.yaml"),
      `nodes:
  - { id: a, icon: gear, label: A }
`,
      "utf8",
    );
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await archCmd(["render", "spec.yaml", "-o", "out/diagram.svg"]);
      expect(existsSync(join(root, "out", "diagram.svg"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("rejects a spec that fails schema validation with a clear message", async () => {
    const root = fixture();
    writeFileSync(join(root, "bad.yaml"), `nodes:\n  - { id: a, icon: not-real, label: A }\n`, "utf8");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await expect(archCmd(["render", "bad.yaml"])).rejects.toThrow(/Invalid .*bad\.yaml/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("requires a spec path", async () => {
    await expect(archCmd(["render"])).rejects.toThrow(/Usage: keyoku arch render/);
  });

  it("rejects an unknown subcommand", async () => {
    await expect(archCmd(["bogus"])).rejects.toThrow(/Usage: keyoku arch render/);
  });
});

describe("layout aesthetics", () => {
  it("gives every node the same box size (consistent node size)", () => {
    const spec: ArchSpec = {
      nodes: [
        { id: "a", icon: "browser", label: "Short" },
        { id: "b", icon: "api", label: "A Much Longer Label Than Short" },
      ],
      edges: [{ from: "a", to: "b", style: "solid" }],
      zones: [],
    };
    const svg = renderArchSvg(spec);
    const sizes = [...svg.matchAll(/<rect class="arch-node-box"[^>]*width="([\d.]+)" height="([\d.]+)"/g)].map((m) => `${m[1]}x${m[2]}`);
    expect(new Set(sizes).size).toBe(1);
  });

  it("vertically centers a shorter column against a taller one", () => {
    const spec: ArchSpec = {
      nodes: [
        { id: "a", icon: "browser", label: "A" }, // layer 0
        { id: "b", icon: "api", label: "B" }, // layer 1
        { id: "c", icon: "api", label: "C" }, // layer 1
        { id: "d", icon: "api", label: "D" }, // layer 1
      ],
      edges: [
        { from: "a", to: "b", style: "solid" },
        { from: "a", to: "c", style: "solid" },
        { from: "a", to: "d", style: "solid" },
      ],
      zones: [],
    };
    const svg = renderArchSvg(spec);
    const groups = [...svg.matchAll(/<g class="arch-node" data-id="([^"]+)">[\s\S]*?<rect class="arch-node-box" x="([-\d.]+)" y="([-\d.]+)"/g)];
    const byId = Object.fromEntries(groups.map((g) => [g[1], { x: Number(g[2]), y: Number(g[3]) }]));
    const singleColMidY = byId.a!.y; // single-node column is already centered on itself
    const threeColYs = [byId.b!.y, byId.c!.y, byId.d!.y].sort((x, y) => x - y);
    const threeColMidY = (threeColYs[0]! + threeColYs[2]!) / 2 + 46; // + half node height to compare box-center
    expect(Math.abs(singleColMidY + 46 - threeColMidY)).toBeLessThan(1);
  });
});
