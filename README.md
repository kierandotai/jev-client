# jev-client

Lightweight local dev setup for **TypeSafe's Jev** (System One decision model), calling the **real hosted Jev** through cloud endpoints. Zero runtime dependencies — Node 20+ built-ins only.

> This is the closed, hosted Jev via OpenRouter / TypeSafe APIs — **not** an open-weight reproduction. The bundled `mock` provider is a keyword heuristic for offline dev only.

## What Jev is

System One models evaluate a `state` (string / JSON object / array) against a map of **typed questions** and return decisions + calibrated probabilities instead of generated text. Three primitives cover the space:

| Primitive | Ask | Answer |
|---|---|---|
| `noul` | a yes/no question | probability 0–1 |
| `choice` | pick one from options you define | chosen key + per-option probabilities + confidence |
| `score` | rate against an ordered rubric | probability-weighted score + per-level probabilities + confidence |

Responses arrive in 70–500 ms; all questions about one state go in a single call.

## Setup

```bash
cd jev-client
npm install          # dev deps only (typescript, @types/node)
cp .env.example .env # add your key(s)
npm test             # offline — uses the mock provider
```

Provider resolution (`JEV_PROVIDER=auto`, the default): `OPENROUTER_API_KEY` → `TYPESAFE_API_KEY` → mock (with a stderr warning).

### Providers

| Provider | Endpoint | Model id | Notes |
|---|---|---|---|
| **OpenRouter** (primary) | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` (or `~typesafe/jev-latest`) | Any OpenRouter account works; no TypeSafe waitlist. Alpha path — may move. Rejected by `/chat/completions` by design. |
| **TypeSafe direct** | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` → `jev-1.13.0` | Early access, waitlisted. |
| mock | in-process | `mock-jev` | Deterministic keyword overlap. Shape-correct, judgment-free. |

Vercel AI Gateway / Cloudflare Workers AI were **not verified to host Jev** at the time of writing; the `Provider` interface (`src/providers.ts`) is ~15 lines to implement if they appear. An OpenJev-style local logit scorer (small Qwen/Gemma) can be slotted in the same way — the `MockProvider` marks the seam.

## Usage

```ts
import { JevClient, noul, choice, score } from "./src/index.ts";

const jev = new JevClient(); // provider + model from env

const res = await jev.decide(ticket, {
  department: choice("Which team should own this?", {
    billing: "Payments, refunds, provider linking",
    technical: "Bugs, errors, API integration problems",
  }),
  urgent: noul("Needs same-day handling?"),
  frustration: score("How frustrated is the customer?", ["calm", "annoyed", "angry"]),
});

res.answers.department.choice        // "billing"
res.answers.department.probabilities // { billing: 0.87, technical: 0.13 }
res.answers.urgent.noul              // 0.93
res.answers.frustration.score        // 1.4  (0–2 rubric)
res.usage.input_tokens               // billed tokens
res.estimated_cost_usd               // see pricing below
```

Answers are **fully typed per question**: `res.answers.urgent` is a `NoulAnswer` because `urgent` was built with `noul()`.

Helpers in `src/helpers.ts`: `detectUrgency`, `route`, `classify`, `gateToolCall` (agent tool gating), `escalateIfUnsure` (confidence-gated escalation), `severity`.

### Examples

```bash
npm run example:triage   # support ticket triage — 3 questions, 1 call
npm run example:gating   # agent tool gating + confidence-gated escalation
npm run example:fanout   # multi-question fan-out over a review batch
```

All run offline against the mock provider when no key is set (with a warning).

### Local proxy

Expose Jev at TypeSafe's own shape so other tools can call it as if local; keys never leave this process:

```bash
npm run proxy   # http://localhost:8787
curl -s localhost:8787/v1/systemone -H 'content-type: application/json' -d '{
  "state": "refund not received in 10 days",
  "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } }
}'
```

Accepts `POST /v1/systemone` and `POST /api/alpha/decisions`; `GET /healthz` reports the active provider.

## Pricing & limits

- **$0.042 per million input tokens; output free** ("too cheap to meter"). A ~500-token triage call ≈ **$0.000021** — roughly 47,000 such calls per dollar.
- `estimated_cost_usd` uses the API-reported cost when present (OpenRouter), else `input_tokens × $0.042/M`.
- Rate limits (TypeSafe direct, adjusting dynamically): **250k tokens/s, 1,200 requests/min**. The client retries 429/5xx/529 with exponential backoff + jitter, honoring `Retry-After`.
- Context budget: **64k tokens per request** (state + all questions); state + longest question ≤ 32k.

## Known jaggedness (jev-1.13)

From TypeSafe's own [model-jaggedness doc](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) — design around these:

- **Literal reading** — scoping words, negations, implied conditions are taken at face value. State conditions explicitly; split ambiguous questions into separate literal ones.
- **Counting & math** — unreliable at counting characters/occurrences/items; can't judge numeric proximity or interpolate magnitudes. Do arithmetic in code, send Jev the conclusion.
- **Dates & times** — treated as text, not ordered values; comparisons/windows unreliable, especially mixed formats. Precompute ("deadline_passed": true) instead.
- **Indirection** — double negatives and multi-hop "property of a property" questions underperform. Flatten to one hop.
- **Large noisy state** — irrelevant details act as distractors. Filter first; send only what the question needs.
- Also: adversarial content in state can steer outputs; contradictory instructions-vs-criteria confuse it; negation equivalence and threshold portability aren't guaranteed; it does not generate text (by design).

**Rule of thumb:** code does counting, math, and date arithmetic; Jev does semantic judgment.

## Project layout

```
src/types.ts      wire types (mirror TypeSafe's API), cost math, JevError
src/providers.ts  OpenRouter / TypeSafe / mock providers + retry/backoff
src/client.ts     JevClient, provider resolution, noul/choice/score builders
src/helpers.ts    urgency, routing, classification, tool gating, escalation
server/proxy.ts   local HTTP proxy at TypeSafe's API shape
examples/         triage, tool gating, fan-out
test/             offline tests (node:test, stubbed fetch for retry path)
```
