import {
  JevError,
  estimateCostUsd,
  type JevRequest,
  type JevResponse,
  type JevQuestion,
  type JevAnswer,
  type JevUsage,
} from "./types.ts";

export interface Provider {
  readonly name: string;
  /** Default model id in this provider's namespace. */
  readonly defaultModel: string;
  decide(req: JevRequest, signal?: AbortSignal): Promise<RawDecision>;
}

export interface RawDecision {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 4;

/** POST with exponential backoff + jitter on 429/5xx/529, honoring Retry-After. */
async function postJson(
  url: string,
  apiKey: string,
  body: JevRequest,
  providerName: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<RawDecision> {
  let lastError: JevError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return (await res.json()) as RawDecision;

    const text = await res.text().catch(() => "");
    lastError = new JevError(
      `${providerName} returned ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      providerName,
      text,
    );
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS - 1) throw lastError;

    const retryAfter = Number(res.headers.get("retry-after"));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt + Math.random() * 250;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastError!;
}

/** OpenRouter Decisions API (alpha). Path may move off /alpha/ — override via baseUrl. */
export class OpenRouterProvider implements Provider {
  readonly name = "openrouter";
  readonly defaultModel = "typesafe/jev-1.13";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  constructor(apiKey: string, baseUrl = "https://openrouter.ai/api/alpha") {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
  }
  decide(req: JevRequest, signal?: AbortSignal): Promise<RawDecision> {
    return postJson(`${this.#baseUrl}/decisions`, this.#apiKey, req, this.name, {}, signal);
  }
}

/** TypeSafe direct (early access). */
export class TypeSafeProvider implements Provider {
  readonly name = "typesafe";
  readonly defaultModel = "jev-latest";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  constructor(apiKey: string, baseUrl = "https://api.typesafe.ai/v1") {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
  }
  decide(req: JevRequest, signal?: AbortSignal): Promise<RawDecision> {
    return postJson(`${this.#baseUrl}/systemone`, this.#apiKey, req, this.name, {}, signal);
  }
}

/**
 * Deterministic offline fallback so examples and tests run without any API key.
 * NOT a model: naive keyword overlap between state text and criteria text.
 * Answers are shaped correctly but carry no real judgment — clearly marked by
 * model id "mock-jev". Swap for an OpenJev-style local logit scorer if needed.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly defaultModel = "mock-jev";

  async decide(req: JevRequest): Promise<RawDecision> {
    const stateText = JSON.stringify(req.state).toLowerCase();
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      answers[id] = this.answer(q, stateText);
    }
    const inputTokens = Math.ceil(JSON.stringify(req).length / 4);
    return { model: "mock-jev", answers, usage: { input_tokens: inputTokens, output_tokens: 0 } };
  }

  private overlap(stateText: string, criterion: unknown): number {
    const words = JSON.stringify(criterion ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
    if (words.length === 0) return 0.1;
    const hits = words.filter((w) => stateText.includes(w)).length;
    return hits / words.length;
  }

  private answer(q: JevQuestion, stateText: string): JevAnswer {
    if (q.type === "noul") {
      const yes = this.overlap(stateText, q.criteria?.true ?? q.instructions);
      const no = this.overlap(stateText, q.criteria?.false ?? "");
      const p = Math.min(0.95, Math.max(0.05, 0.5 + (yes - no)));
      return { type: "noul", noul: Number(p.toFixed(3)) };
    }
    const entries = q.type === "choice"
      ? Object.entries(q.criteria)
      : q.criteria.map((c, i) => [String(i), c] as const);
    const raw = entries.map(([k, v]) => [k, this.overlap(stateText, v) + 0.05] as const);
    const total = raw.reduce((s, [, v]) => s + v, 0);
    const probabilities = Object.fromEntries(raw.map(([k, v]) => [k, Number((v / total).toFixed(3))]));
    const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    const confidence = Number((sorted[0][1] - (sorted[1]?.[1] ?? 0) + sorted[0][1]).toFixed(3));
    if (q.type === "choice") {
      return { type: "choice", choice: sorted[0][0], probabilities, confidence: Math.min(1, confidence) };
    }
    const score = Object.entries(probabilities).reduce((s, [k, p]) => s + Number(k) * p, 0);
    const legend = Object.fromEntries(
      q.criteria.map((c, i) => [String(i), typeof c === "string" ? c : JSON.stringify(c)]),
    );
    return {
      type: "score",
      score: Number(score.toFixed(3)),
      legend,
      probabilities,
      confidence: Math.min(1, confidence),
    };
  }
}

/** Normalize a raw provider response into the client-facing JevResponse. */
export function normalize(raw: RawDecision, provider: string): JevResponse {
  const estimated = estimateCostUsd(raw.usage);
  return {
    model: raw.model,
    answers: raw.answers,
    usage: raw.usage,
    provider,
    estimated_cost_usd: raw.usage.cost_usd ?? estimated,
  };
}
