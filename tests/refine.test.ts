import { describe, expect, it } from "vitest";

import type { ActivitySuggestion } from "../src/activity.js";
import { refineSuggestions } from "../src/refine.js";
import type { SlmProvider } from "../src/slm.js";

const drafts: ActivitySuggestion[] = [
  {
    slug: "auto-bash-1",
    name: "Auto: npm test → git push",
    description: "Detected 3×",
    count: 3,
    draftSteps: [
      { type: "bash", summary: "npm test", command: "npm test" },
      { type: "bash", summary: "git push", command: "git push" },
    ],
    key: "Bash:npm test → Bash:git push",
  },
];

const fake = (reply: string): SlmProvider => ({
  name: "fake",
  model: "fake-1",
  complete: async () => reply,
});

describe("refineSuggestions", () => {
  it("returns the model's refined suggestions when valid", async () => {
    const reply = JSON.stringify({
      suggestions: [
        {
          slug: "test-and-push",
          name: "Test & push",
          description: "Runs the test suite, then pushes to the current branch.",
          count: 3,
          draftSteps: [
            { type: "bash", summary: "run tests", command: "npm test" },
            { type: "bash", summary: "push", command: "git push" },
          ],
        },
      ],
    });
    const refined = await refineSuggestions(fake(reply), drafts, []);
    expect(refined).toHaveLength(1);
    expect(refined[0].slug).toBe("test-and-push");
    expect(refined[0].name).toBe("Test & push");
  });

  it("falls back to heuristic drafts on malformed model output", async () => {
    expect(await refineSuggestions(fake("not json"), drafts, [])).toEqual(drafts);
    expect(await refineSuggestions(fake('{"suggestions": "nope"}'), drafts, [])).toEqual(drafts);
    expect(await refineSuggestions(fake('{"suggestions": [{"bad": true}]}'), drafts, [])).toEqual(drafts);
  });

  it("falls back when the model call throws", async () => {
    const boom: SlmProvider = {
      name: "boom",
      model: "x",
      complete: async () => {
        throw new Error("503");
      },
    };
    expect(await refineSuggestions(boom, drafts, [])).toEqual(drafts);
  });

  it("passes empty drafts through without calling the model", async () => {
    let called = false;
    const spy: SlmProvider = {
      name: "spy",
      model: "x",
      complete: async () => {
        called = true;
        return "{}";
      },
    };
    expect(await refineSuggestions(spy, [], [])).toEqual([]);
    expect(called).toBe(false);
  });
});
