import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// SLM providers — pluggable small-language-model backends for the M2 learning
// loop (pattern mining over traces + observations). The harness never needs a
// frontier model here: a fast, cheap model summarizing/structuring traces is
// the point. Providers are resolved from the environment so the harness stays
// fully functional (heuristic mining only) when no key is configured.
// ---------------------------------------------------------------------------

export interface SlmProvider {
  readonly name: string;
  readonly model: string;
  complete(prompt: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string>;
}

export interface SlmConfig {
  provider: "gemini" | "anthropic" | "openai-compat";
  apiKey: string;
  model?: string;
  /** openai-compat only: base URL of any /v1 endpoint — Ollama, LM Studio,
   * llama.cpp server, vLLM, Groq, OpenRouter, a LiteLLM proxy, … */
  baseUrl?: string;
}

const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 2048;
const GEMINI_TIMEOUT_MS = 60_000;
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Truncate an error body to something log-friendly. */
function snippet(body: string, max = 300): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

function createGemini(apiKey: string, model: string): SlmProvider {
  return {
    name: "gemini",
    model,
    async complete(prompt, opts = {}) {
      const url = `${GEMINI_BASE_URL}/${model}:generateContent`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      // Keep the timer armed across BOTH the fetch and the body read — a server
      // that sends headers then stalls the body would otherwise hang forever.
      let body: string;
      let status: number;
      let ok: boolean;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
              ...(opts.json ? { responseMimeType: "application/json" } : {}),
            },
          }),
          signal: controller.signal,
        });
        status = res.status;
        ok = res.ok;
        body = await res.text();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms (model ${model})`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      const res = { ok, status };
      if (!res.ok) {
        throw new Error(`Gemini request failed (HTTP ${res.status}): ${snippet(body)}`);
      }

      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(body) as GeminiResponse;
      } catch {
        throw new Error(`Gemini returned non-JSON (HTTP ${res.status}): ${snippet(body)}`);
      }

      const parts = parsed.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((part) => part.text ?? "").join("");
      if (text === "") {
        throw new Error(`Gemini returned no text (HTTP ${res.status}): ${snippet(body)}`);
      }
      return text;
    },
  };
}

function createAnthropic(apiKey: string, model: string): SlmProvider {
  const client = new Anthropic({ apiKey });
  return {
    name: "anthropic",
    model,
    async complete(prompt, opts = {}) {
      const content = opts.json
        ? `${prompt}\n\nRespond with raw JSON only — no prose, no code fences.`
        : prompt;
      try {
        const response = await client.messages.create({
          model,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [{ role: "user", content }],
        });
        return response.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
      } catch (err) {
        throw new Error(
          `Anthropic request failed (model ${model}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}

const COMPAT_TIMEOUT_MS = 60_000;

/** Any OpenAI-compatible /v1 endpoint: local (Ollama, LM Studio, llama.cpp,
 * vLLM) or hosted (Groq, OpenRouter, a LiteLLM proxy). One provider class
 * covers them all — this is how keyoku gets a native local SLM without
 * bundling a model runtime. */
function createOpenAICompat(baseUrl: string, apiKey: string, model: string): SlmProvider {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: "openai-compat",
    model,
    async complete(prompt, opts = {}) {
      const content = opts.json
        ? `${prompt}\n\nRespond with raw JSON only — no prose, no code fences.`
        : prompt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMPAT_TIMEOUT_MS);
      let body: string;
      let status: number;
      let ok: boolean;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            messages: [{ role: "user", content }],
          }),
          signal: controller.signal,
        });
        status = res.status;
        ok = res.ok;
        body = await res.text();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`openai-compat request timed out after ${COMPAT_TIMEOUT_MS}ms (${url}, model ${model})`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (!ok) {
        throw new Error(`openai-compat request failed (HTTP ${status}, ${url}): ${snippet(body)}`);
      }
      let parsed: { choices?: Array<{ message?: { content?: string } }> };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`openai-compat returned non-JSON (HTTP ${status}, ${url}): ${snippet(body)}`);
      }
      const text = parsed.choices?.[0]?.message?.content ?? "";
      if (text === "") {
        throw new Error(`openai-compat returned no text (HTTP ${status}, ${url}): ${snippet(body)}`);
      }
      return text;
    },
  };
}

export function createSlm(config: SlmConfig): SlmProvider {
  switch (config.provider) {
    case "gemini":
      return createGemini(config.apiKey, config.model ?? GEMINI_DEFAULT_MODEL);
    case "anthropic":
      return createAnthropic(config.apiKey, config.model ?? ANTHROPIC_DEFAULT_MODEL);
    case "openai-compat": {
      if (!config.baseUrl) throw new Error("openai-compat provider requires baseUrl (KEYOKU_SLM_BASE_URL)");
      if (!config.model) throw new Error("openai-compat provider requires an explicit model (KEYOKU_SLM_MODEL)");
      return createOpenAICompat(config.baseUrl, config.apiKey, config.model);
    }
    default: {
      const exhausted: never = config.provider;
      throw new Error(`unknown SLM provider ${String(exhausted)}`);
    }
  }
}

/**
 * Resolve an SLM provider from the environment.
 *
 * - KEYOKU_SLM_PROVIDER=none          → null (explicitly disabled)
 * - KEYOKU_SLM_PROVIDER=gemini        → gemini, but only if GEMINI_API_KEY is set
 * - KEYOKU_SLM_PROVIDER=anthropic     → anthropic, but only if ANTHROPIC_API_KEY is set
 * - KEYOKU_SLM_PROVIDER=openai-compat → any /v1 endpoint; needs KEYOKU_SLM_BASE_URL
 *                                       + KEYOKU_SLM_MODEL (KEYOKU_SLM_API_KEY optional)
 * - unset (or unrecognized)           → openai-compat if BASE_URL+MODEL are set
 *                                       (local-first), else gemini if GEMINI_API_KEY,
 *                                       else anthropic if ANTHROPIC_API_KEY, else null
 *
 * KEYOKU_SLM_MODEL overrides the per-provider default model.
 */
export function resolveSlmFromEnv(
  env: Record<string, string | undefined> = process.env,
): SlmProvider | null {
  const requested = env.KEYOKU_SLM_PROVIDER?.trim().toLowerCase();
  // An empty (but set) KEYOKU_SLM_MODEL must fall back to the per-provider
  // default, not produce a ".../models/:generateContent" 404.
  const model = env.KEYOKU_SLM_MODEL?.trim() || undefined;
  const geminiKey = env.GEMINI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const baseUrl = env.KEYOKU_SLM_BASE_URL?.trim() || undefined;
  const compatKey = env.KEYOKU_SLM_API_KEY ?? "";

  if (requested === "none") return null;
  if (requested === "openai-compat") {
    return baseUrl && model
      ? createSlm({ provider: "openai-compat", apiKey: compatKey, model, baseUrl })
      : null;
  }
  if (requested === "gemini") {
    return geminiKey ? createSlm({ provider: "gemini", apiKey: geminiKey, model }) : null;
  }
  if (requested === "anthropic") {
    return anthropicKey ? createSlm({ provider: "anthropic", apiKey: anthropicKey, model }) : null;
  }
  // Auto-detect: an explicitly configured local/compat endpoint wins over
  // cloud keys — local-first by default.
  if (baseUrl && model) return createSlm({ provider: "openai-compat", apiKey: compatKey, model, baseUrl });
  if (geminiKey) return createSlm({ provider: "gemini", apiKey: geminiKey, model });
  if (anthropicKey) return createSlm({ provider: "anthropic", apiKey: anthropicKey, model });
  return null;
}
