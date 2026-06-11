import type { KnowledgeEntry } from "./types.js";

// ---------------------------------------------------------------------------
// keyoku-engine bridge — "the brain". Opt-in via KEYOKU_ENGINE_URL: when a
// running engine is configured, every knowledge entry is mirrored into it
// (semantic indexing, decay, graph — the engine's existing /remember and
// /search endpoints, no Go changes needed), and knowledge_query upgrades from
// substring matching to semantic search. Everything degrades to the local
// JSONL silently — the engine adds intelligence, it is never a dependency.
//
// Storage convention: all harness knowledge lives under one engine entity
// ("keyoku-harness") with the subject encoded as a content prefix
// "[subject] fact" — keeps cross-subject semantic search trivial and
// sidesteps per-entity scoping.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 4000;
const ENTITY = "keyoku-harness";

export interface BrainSearchHit {
  subject: string;
  fact: string;
  score: number;
}

export class Brain {
  private constructor(readonly baseUrl: string) {}

  /** null unless KEYOKU_ENGINE_URL is set — explicit opt-in, no port scans. */
  static fromEnv(env: Record<string, string | undefined> = process.env): Brain | null {
    const url = env.KEYOKU_ENGINE_URL?.trim();
    return url ? new Brain(url.replace(/\/+$/, "")) : null;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`engine ${path} HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mirror a knowledge entry into the engine. Fire-and-forget safe.
   * Uses /api/v1/seed — the extraction-free door: our facts are already
   * structured, so no engine-side LLM is needed (only the embedder, which
   * the engine supports locally via Ollama). */
  async remember(entry: KnowledgeEntry): Promise<boolean> {
    const importance: Record<KnowledgeEntry["source"], number> = {
      user: 0.8,
      "agent-research": 0.7,
      "pattern-mining": 0.6,
      "mcp-description": 0.4,
    };
    try {
      await this.post("/api/v1/seed", {
        memories: [
          {
            entity_id: ENTITY,
            content: `[${entry.subject}] ${entry.fact}`,
            type: "CONTEXT",
            importance: importance[entry.source] ?? 0.5,
            tags: ["keyoku-harness", entry.kind, entry.source],
            created_at: entry.at,
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Semantic search over mirrored knowledge. Returns null on ANY failure so
   * callers fall back to the local store. */
  async search(query: string, limit = 50): Promise<BrainSearchHit[] | null> {
    try {
      const data = (await this.post("/api/v1/search", {
        entity_id: ENTITY,
        query,
        limit,
      })) as {
        results?: Array<{
          memory?: { content?: string };
          score?: number;
          similarity?: number;
        }>;
      };
      if (!Array.isArray(data.results)) return null;
      return data.results
        .filter((r) => typeof r.memory?.content === "string")
        .map((r) => {
          const content = r.memory?.content ?? "";
          const m = content.match(/^\[([^\]]+)\]\s*/);
          return {
            subject: m?.[1] ?? "",
            fact: m ? content.slice(m[0].length) : content,
            score: r.score ?? r.similarity ?? 0,
          };
        });
    } catch {
      return null;
    }
  }
}
