# Keyoku — The Outcome Engine

**Product thesis v0.1** · a governed, self-improving decision layer.

> Status: formalization of an active design discussion. **Clean-room**: all examples use
> synthetic data and contain no client code or confidential terms. The *pattern* used as the
> beachhead (regulated decisioning) is general market knowledge, not any client's IP.

---

## 0. Thesis (one paragraph)

Enterprises deployed AI agents/copilots (2023–25) and stalled in pilot purgatory: the agents are
**unreliable, ungoverned, and don't improve**, and the data they need **isn't organized for AI**.
The **Outcome Engine** is the layer that fixes this. Point it at a *measurable* business process and it
(1) **organizes** the relevant context into a graph, (2) **achieves** the outcome with an *auditable
rationale*, and (3) **ratchets** the KPI upward over time under *explicit governance*. The context graph
is the "knows-your-business" layer; the Keyoku process layer is the "achieves-and-improves" layer. The
differentiator is **grounded, governed self-improvement** — not another agent, not another eval dashboard.

---

## 1. Formal model

A deployment is the tuple **`E = (G, d_θ, F, Ω, Γ)`**:

- **Context graph `G = (V, E)`** — typed entities + relationships projected from the business's
  systems-of-record (CRM/ERP/docs/tickets). Provides retrieval `r_G(x)` → relevant context for input `x`.
- **Decision policy `d_θ`** — given input `x` and context `r_G(x)`, emits an **outcome `ŷ`** plus an
  **auditable rationale `ρ`** (citations, the graph path, the rule fired). `θ` = the *strategy*:
  retrieval method, scoring weights, thresholds, ontology granularity. Deterministic-first; an LLM is
  used only for generative/explanatory sub-steps, never as the sole decider in regulated paths.
- **Ground truth `y`** — realized outcomes from the system-of-record, **held out** from `θ`.
- **Fitness `F(θ)`** — a **vector** of metrics on a held-out set, *not* a scalar:
  `F = ⟨balanced_accuracy, calibration_error, coverage@precision≥τ, cost, latency, …⟩`.
  Vector-valued is deliberate (see grounding invariant I2).
- **Process goal `Ω`** — objective + machine-checkable criteria `C = {(probe_i, assert_i)}` over `F`,
  each with a **ratchet target**: `target_i(t) = max(baseline_i, best_so_far_i) + ε`. The bar *moves up*;
  the engine optimizes for *monotone improvement*, not a fixed pass mark.
- **Governance `Γ`** — autonomy level `∈ {observe, suggest, approve, autonomous}`, an append-only audit
  log, and the validity guard (I3). Every promotion is gated by `Γ`.

This is the difference between a **goal-hitter** (constraint solver: "criterion met → done") and a
**process-improver** (optimizer with memory: "better than best-so-far, and improvable still?").

---

## 2. The improvement loop (procedure)

At iteration `t`, holding `G` and the held-out set fixed:

1. **Assess** — run probes; compute `F(θ_t)`.
2. **Propose** — a human or agent advances a *candidate* `θ'` (a mechanism change: new retrieval, a
   risk feature, an ontology edit). The loop *selects*; it does not invent — proposals are the input.
3. **Compare (champion-challenger)** — evaluate `F(θ')` vs `F(θ_t)` on the *same* held-out set.
4. **Promote iff** `θ'` **Pareto-improves** `θ_t` (≥ on every *guarded* metric, > on at least one) **and**
   the validity guard (I3) holds **and** governance `Γ` permits → `θ_{t+1} = θ'`; else discard.
5. **Record** — append `(hypothesis, ΔF, decision, rationale)` to the experiment ledger (audit + learning).
6. **Mine** — periodically learn *which classes of change improved which metric* → suggest the next
   candidate. (This is Keyoku's `harness_learn`, pointed at improvements rather than just workflows.)

**Convergence** = no candidate Pareto-improves for `k` consecutive rounds (plateau) **or** a target tier
is reached. A rejected hypothesis is retained — a rejection is a finding.

---

## 3. The grounding contract — why this is not AutoGPT

A self-improver that optimizes an ungrounded proxy gets *confidently wrong at scale*. Four invariants
make the loop science instead of self-delusion; they are **enforced, not advisory**:

- **I1 — External, held-out labels.** Ground truth comes from the system-of-record and is hidden from
  `θ`. The engine **cannot author its own exam** (critical for the recursive/dogfood case).
- **I2 — Multi-metric, no single-number ratchet.** Promotion requires a **Pareto** improvement; you can
  never trade away a guarded metric (e.g. decline-recall, calibration) for a headline number. Kills Goodhart.
- **I3 — Metric validity is itself a standing criterion.** Any LLM-judged metric is calibrated against a
  human gold set (judge-vs-human κ tracked); data-drift and selection-bias checks run continuously. If the
  metric stops being trustworthy, the loop halts rather than optimizes noise.
- **I4 — Every promotion is audit-logged with rationale.** Governance (`Γ`) gates promotions by autonomy
  level; nothing changes silently.

---

## 4. Architecture — four planes

| Plane | Responsibility | Keyoku / component |
|---|---|---|
| **Data** | ingest systems-of-record → typed entities + relationships + projections | Context graph `G`, source-of-truth adapters |
| **Decision** | `r_G(x)` → policy `d_θ` → outcome `ŷ` + rationale `ρ` (deterministic-first) | retrieval + scoring + decision module |
| **Improvement** | assess → compare → promote → record → mine (the §2 loop) | Keyoku process-improver mode |
| **Governance** | autonomy ladder, audit log, validity guard | Keyoku governance (`Γ`) |

The **decision plane is swappable** (`θ`), the **improvement plane is the moat** (compounds per account),
the **governance plane is the regulated-market key**, the **data plane is the "knows-your-business" wedge**.

---

## 5. Concrete example — a process goal in Keyoku's own format

Underwriting-style decisioning, **synthetic data**, expressed as a Keyoku goal with ratchet criteria.
The eval script emits one flat JSON object; each criterion probes it and asserts a *moving* target.

```jsonc
{
  "objective": "Decisioning policy improves on held-out outcomes without regressing guarded metrics",
  "slug": "decisioning-ratchet",
  "autonomy": "approve",                 // promotions need human sign-off (Γ)
  "criteria": [
    { "description": "balanced_accuracy ≥ best-so-far (ratchet)",
      "probe":  { "kind": "command", "run": "node eval.js --holdout --json", "parse": "json" },
      "assert": { "path": "output.balanced_accuracy", "op": "gte", "value": 0.78 } },   // value = current baseline, raised on each win

    { "description": "GUARDED: decline_recall must not regress",
      "probe":  { "kind": "command", "run": "node eval.js --holdout --json", "parse": "json" },
      "assert": { "path": "output.decline_recall", "op": "gte", "value": 0.60 } },

    { "description": "auto-decide coverage at precision≥0.99 ≥ 0.60",
      "probe":  { "kind": "command", "run": "node eval.js --holdout --json", "parse": "json" },
      "assert": { "path": "output.coverage_at_p99", "op": "gte", "value": 0.60 } },

    { "description": "VALIDITY (I3): judge-vs-human agreement κ ≥ 0.7",
      "probe":  { "kind": "command", "run": "node eval.js --judge-cal --json", "parse": "json" },
      "assert": { "path": "output.judge_kappa", "op": "gte", "value": 0.7 } }
  ],
  "constraints": [
    "Held-out set is frozen and external (I1)",
    "Promotion requires Pareto improvement across guarded metrics (I2)"
  ]
}
```

The "balanced_accuracy" target is the **ratchet**; the "decline_recall" criterion is a **guard** (I2); the
"judge_kappa" criterion enforces **metric validity** (I3). This is the formal model made runnable today.

---

## 6. Product

- **Category.** *Outcome Engine* — a governed, self-improving **decision layer**. (Avoid pitching
  "self-learning intelligence layer" — post-AutoGPT it reads as hype. Lead with grounded + governed.)
- **ICP (beachhead).** Regulated decisioning ops — **underwriting / credit / claims / KYC-AML / prior-auth**.
  Outcomes are measurable, a system-of-record exists, audit is mandatory, determinism is required (so
  pure-LLM vendors structurally can't compete).
- **Wedge.** Drop in *beside* an existing decision process in **shadow mode**; show the ratchet + audit on
  their own data before taking any decision authority. Value visible in weeks, not a year.
- **Wow.** On the customer's own data and KPI: organize messy context into a graph → decide with a
  **human-readable, traceable rationale** ("a graph path is a sentence a human can read") → **watch the
  KPI ratchet up, with receipts for which change improved what.** Most tools ship one of these; the
  combination is the wow — and it's hard to fake, which is why it's also the moat.
- **Moat (defensible).** *Compounding per-account*: the context graph + learned "muscle memory" +
  vertical ontology accrue inside each customer → switching cost rises with use (a within-account
  data/learning network effect). Governance/audit is the regulated-market key.
- **Anti-positioning (what it is NOT).** Not an agent framework (LangGraph/CrewAI — commodity). Not an
  eval dashboard (Braintrust/LangSmith — they measure, don't improve themselves). Not an autonomous AGI.

---

## 7. MVP / concrete build order

1. **Process-improver mode in Keyoku** — the new primitives: per-criterion **metric history**, **ratchet
   targets** (`≥ best-so-far + ε`), **champion-challenger** compare, regression gate. *(engine evolution)*
2. **Self-dogfood benchmark** — a *frozen* "goal gym" (corpus of held-out goals) + meta-metrics
   (convergence rate, iterations-to-converge, pattern-transfer). Run process-improver mode **on Keyoku
   itself** (proves the thesis and improves the product). Frozen + external = no self-grading (I1).
3. **Clean-room reference app** — a generic decisioning demo on **synthetic** data showing all four planes
   (graph → deterministic decision + rationale → ratchet → governance). This is the *wow* demo.
4. **Source-of-truth adapter** — CSV first, then CRM (e.g. Salesforce) for *real* held-out labels;
   handle **selection bias / censored outcomes** (reject-inference), not naive "match the CRM."
5. **Governance + audit surface** — autonomy ladder UI + the promotion/rationale ledger.

---

## 8. Risks & kill-criteria (honest)

- **Narrow-or-die.** "Outcome engine for any process" has no PMF. Commit to one regulated vertical first.
- **Grounding is the whole ballgame.** If real customer labels are too noisy/biased to produce a
  trustworthy `F` → the loop can't self-improve. **Kill/pivot** to human-in-the-loop assist if the ratchet
  won't move on real data within N iterations.
- **Credibility tax.** The "self-improving agent" category is a graveyard (AutoGPT/BabyAGI). Mitigate by
  always leading with the grounding contract (§3) and shadow-mode proof.
- **Sales cycle.** Regulated buyers are slow. The wedge must show value in weeks or the runway math fails.
- **Moat timing.** The compounding moat only exists *after* deployment; early on, defensibility = vertical
  ontology depth + governance, not the stack.

---

## 9. Open questions

- Decision target: **imitate good underwriters** (match historical decisions) vs **optimize realized
  outcomes** (loss ratio/claims)? Different ground truths, different value, different difficulty.
- Where does the context graph stop and the customer's data platform begin? (build vs integrate)
- Is the first commercial unit a **product** (self-serve engine) or a **design-partner engagement**
  (services-led, productize later)?
- Pricing: per-decision, per-KPI-lift, or platform seat?
