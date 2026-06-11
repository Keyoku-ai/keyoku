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
  provider: "gemini" | "anthropic";
  apiKey: string;
  model?: string;
}

const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
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

export function createSlm(config: SlmConfig): SlmProvider {
  switch (config.provider) {
    case "gemini":
      return createGemini(config.apiKey, config.model ?? GEMINI_DEFAULT_MODEL);
    case "anthropic":
      return createAnthropic(config.apiKey, config.model ?? ANTHROPIC_DEFAULT_MODEL);
    default: {
      const exhausted: never = config.provider;
      throw new Error(`unknown SLM provider ${String(exhausted)}`);
    }
  }
}

/**
 * Resolve an SLM provider from the environment.
 *
 * - KEYOKU_SLM_PROVIDER=none      → null (explicitly disabled)
 * - KEYOKU_SLM_PROVIDER=gemini    → gemini, but only if GEMINI_API_KEY is set
 * - KEYOKU_SLM_PROVIDER=anthropic → anthropic, but only if ANTHROPIC_API_KEY is set
 * - unset (or unrecognized)       → gemini if GEMINI_API_KEY, else anthropic if
 *                                   ANTHROPIC_API_KEY, else null
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

  if (requested === "none") return null;
  if (requested === "gemini") {
    return geminiKey ? createSlm({ provider: "gemini", apiKey: geminiKey, model }) : null;
  }
  if (requested === "anthropic") {
    return anthropicKey ? createSlm({ provider: "anthropic", apiKey: anthropicKey, model }) : null;
  }
  if (geminiKey) return createSlm({ provider: "gemini", apiKey: geminiKey, model });
  if (anthropicKey) return createSlm({ provider: "anthropic", apiKey: anthropicKey, model });
  return null;
}
