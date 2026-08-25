import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { proposeArchitectureChange, renderArchitectureSvg, scanArchitecture } from "../src/architecture.js";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-architecture-"));
  roots.push(root);
  mkdirSync(join(root, ".keyoku", "runtime"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "server.ts"), "export const server = true;\n");
  writeFileSync(join(root, ".keyoku", "architecture.yaml"), `schemaVersion: keyoku.dev/architecture/v1alpha1
projectId: demo
title: Demo architecture
components:
  - id: server
    label: Server
    summary: Serves the product
    layer: control
    icon: mcp
    view: { x: 100, y: 100 }
    owns: [src/server.ts]
  - id: agent
    label: Agent
    summary: External worker
    layer: execution
    icon: agent
    external: true
    view: { x: 400, y: 100 }
relations:
  - from: server
    to: agent
    kind: routes
`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("architecture projection", () => {
  it("combines declared meaning with observed files and exports accessible SVG", () => {
    const architecture = scanArchitecture(fixture());
    expect(architecture.components[0]).toMatchObject({ id: "server", observedFiles: 1, state: "stable" });
    expect(architecture.components[1]).toMatchObject({ id: "agent", state: "external" });
    const svg = renderArchitectureSvg(architecture);
    expect(svg).toContain("<title id=\"title\">Demo architecture</title>");
    expect(svg).toContain("data-component=\"server\"");
  });

  it("keeps semantic updates attributed as proposals", () => {
    const root = fixture();
    const proposal = proposeArchitectureChange({
      root,
      summary: "Add proof plane",
      rationale: "The tests now emit durable evidence.",
      operations: [{ op: "add", target: "components/proof", value: { label: "Proof" } }],
      actor: { id: "agent-1", name: "Steward", harness: "keyoku" },
      confidence: 0.82,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.baseSnapshotRef).toHaveLength(16);
    expect(scanArchitecture(root).components.map((component) => component.id)).not.toContain("proof");
  });
});
