import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlm, resolveSlmFromEnv } from "../src/slm.js";

const geminiBody = (...texts: string[]): string =>
  JSON.stringify({ candidates: [{ content: { parts: texts.map((text) => ({ text })) } }] });

const httpResponse = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

const lastCall = (fetchMock: { mock: { calls: unknown[][] } }): FetchCall => {
  const call = fetchMock.mock.calls.at(-1) as [string, FetchCall["init"]];
  return { url: call[0], init: call[1] };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSlmFromEnv", () => {
  it("returns null when KEYOKU_SLM_PROVIDER is none, even with keys present", () => {
    expect(
      resolveSlmFromEnv({
        KEYOKU_SLM_PROVIDER: "none",
        GEMINI_API_KEY: "g",
        ANTHROPIC_API_KEY: "a",
      }),
    ).toBeNull();
  });

  it("honors an explicit gemini request when GEMINI_API_KEY is set", () => {
    const slm = resolveSlmFromEnv({ KEYOKU_SLM_PROVIDER: "gemini", GEMINI_API_KEY: "g" });
    expect(slm).not.toBeNull();
    expect(slm?.name).toBe("gemini");
    expect(slm?.model).toBe("gemini-3.5-flash");
  });

  it("returns null for an explicit gemini request without GEMINI_API_KEY", () => {
    expect(
      resolveSlmFromEnv({ KEYOKU_SLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" }),
    ).toBeNull();
  });

  it("honors an explicit anthropic request when ANTHROPIC_API_KEY is set", () => {
    const slm = resolveSlmFromEnv({ KEYOKU_SLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a" });
    expect(slm).not.toBeNull();
    expect(slm?.name).toBe("anthropic");
    expect(slm?.model).toBe("claude-haiku-4-5");
  });

  it("returns null for an explicit anthropic request without ANTHROPIC_API_KEY", () => {
    expect(
      resolveSlmFromEnv({ KEYOKU_SLM_PROVIDER: "anthropic", GEMINI_API_KEY: "g" }),
    ).toBeNull();
  });

  it("prefers gemini when unset and both keys are present", () => {
    const slm = resolveSlmFromEnv({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    expect(slm?.name).toBe("gemini");
  });

  it("falls back to anthropic when unset and only ANTHROPIC_API_KEY is present", () => {
    const slm = resolveSlmFromEnv({ ANTHROPIC_API_KEY: "a" });
    expect(slm?.name).toBe("anthropic");
  });

  it("returns null when unset and no keys are present", () => {
    expect(resolveSlmFromEnv({})).toBeNull();
    expect(resolveSlmFromEnv({ KEYOKU_SLM_MODEL: "whatever" })).toBeNull();
  });

  it("applies the KEYOKU_SLM_MODEL override for both providers", () => {
    const gemini = resolveSlmFromEnv({
      KEYOKU_SLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "g",
      KEYOKU_SLM_MODEL: "gemini-3.5-pro",
    });
    expect(gemini?.model).toBe("gemini-3.5-pro");
    const anthropic = resolveSlmFromEnv({
      KEYOKU_SLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "a",
      KEYOKU_SLM_MODEL: "claude-sonnet-4-5",
    });
    expect(anthropic?.model).toBe("claude-sonnet-4-5");
  });

  it("treats an unrecognized provider value like unset (auto-detect)", () => {
    const slm = resolveSlmFromEnv({ KEYOKU_SLM_PROVIDER: "openai", GEMINI_API_KEY: "g" });
    expect(slm?.name).toBe("gemini");
  });
});

describe("gemini provider", () => {
  it("posts the prompt to the model endpoint with the api key header and joins parts", async () => {
    const fetchMock = vi.fn(async () => httpResponse(200, geminiBody("hello ", "world")));
    vi.stubGlobal("fetch", fetchMock);

    const slm = createSlm({ provider: "gemini", apiKey: "test-key", model: "gemini-3.5-flash" });
    const text = await slm.complete("say hi");

    expect(text).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastCall(fetchMock);
    expect(url).toContain("gemini-3.5-flash");
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":generateContent");
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([{ parts: [{ text: "say hi" }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it("sets responseMimeType and honors maxTokens when json is requested", async () => {
    const fetchMock = vi.fn(async () => httpResponse(200, geminiBody("{\"ok\":true}")));
    vi.stubGlobal("fetch", fetchMock);

    const slm = createSlm({ provider: "gemini", apiKey: "k" });
    const text = await slm.complete("emit json", { json: true, maxTokens: 512 });

    expect(text).toBe("{\"ok\":true}");
    const { init } = lastCall(fetchMock);
    const body = JSON.parse(init.body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.maxOutputTokens).toBe(512);
  });

  it("throws with status and body snippet on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () =>
      httpResponse(400, JSON.stringify({ error: { message: "API key not valid" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const slm = createSlm({ provider: "gemini", apiKey: "bad" });
    await expect(slm.complete("hi")).rejects.toThrow(/400/);
    await expect(slm.complete("hi")).rejects.toThrow(/API key not valid/);
  });

  it("throws when the response has no candidates or no text", async () => {
    const fetchMock = vi.fn(async () => httpResponse(200, JSON.stringify({ candidates: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const slm = createSlm({ provider: "gemini", apiKey: "k" });
    await expect(slm.complete("hi")).rejects.toThrow(/no text/);

    fetchMock.mockImplementation(async () =>
      httpResponse(200, JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
    );
    await expect(slm.complete("hi")).rejects.toThrow(/no text/);
  });

  it("throws on a non-JSON body", async () => {
    const fetchMock = vi.fn(async () => httpResponse(200, "<html>gateway</html>"));
    vi.stubGlobal("fetch", fetchMock);

    const slm = createSlm({ provider: "gemini", apiKey: "k" });
    await expect(slm.complete("hi")).rejects.toThrow(/non-JSON/);
  });
});

describe("createSlm", () => {
  it("builds an anthropic provider with the default model", () => {
    const slm = createSlm({ provider: "anthropic", apiKey: "sk-test" });
    expect(slm.name).toBe("anthropic");
    expect(slm.model).toBe("claude-haiku-4-5");
    expect(typeof slm.complete).toBe("function");
  });

  it("honors a model override for both providers", () => {
    expect(createSlm({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-4-5" }).model).toBe(
      "claude-sonnet-4-5",
    );
    expect(createSlm({ provider: "gemini", apiKey: "k", model: "gemini-3.5-pro" }).model).toBe(
      "gemini-3.5-pro",
    );
  });
});
