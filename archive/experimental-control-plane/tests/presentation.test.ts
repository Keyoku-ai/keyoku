import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { publishProjectView, readProjectView } from "../src/presentation.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-view-")); roots.push(root);
  mkdirSync(join(root, ".keyoku"), { recursive: true });
  writeFileSync(join(root, ".keyoku", "view.yaml"), "schemaVersion: keyoku.dev/project-view/v1alpha1\ntemplate: thread\nfields:\n  header.summary:\n    value: Original\n    description: Header summary\n");
  return root;
}

describe("agent-editable project view", () => {
  it("publishes an attributed update to an allowlisted field", () => {
    const root = fixture();
    publishProjectView(root, { fields: { "header.summary": "Current and useful" }, actor: { id: "ui-agent", harness: "Codex", model: "gpt-5.6-sol" }, confidence: 0.92, reason: "Project state changed" });
    const view = readProjectView(root);
    expect(view.fields["header.summary"]).toMatchObject({ value: "Current and useful", source: "agent", confidence: 0.92 });
  });

  it("protects unknown facts and arbitrary DOM targets", () => {
    const root = fixture();
    expect(() => publishProjectView(root, { fields: { "header.innerHTML": "<script>bad</script>" }, actor: { id: "ui-agent" }, reason: "no" })).toThrow("Unknown or protected");
  });
});
