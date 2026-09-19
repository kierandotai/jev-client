import {
  MockProvider,
  OpenRouterProvider,
  TypeSafeProvider,
  normalize,
  type Provider,
} from "./providers.ts";
import type {
  ChoiceQuestion,
  JevQuestion,
  JevResponse,
  JevState,
  NoulQuestion,
  ScoreQuestion,
  Structured,
} from "./types.ts";

export interface JevClientOptions {
  /** "openrouter" | "typesafe" | "mock" | a custom Provider. Default: auto from env. */
  provider?: string | Provider;
  /** Model id override; defaults to the provider's canonical id. */
  model?: string;
  openrouterApiKey?: string;
  typesafeApiKey?: string;
  /** Warn on stderr when falling back to the mock provider (default true). */
  warnOnMock?: boolean;
}

export class JevClient {
  readonly provider: Provider;
  readonly model: string;

  constructor(opts: JevClientOptions = {}) {
    this.provider = resolveProvider(opts);
    this.model = opts.model ?? process.env.JEV_MODEL ?? this.provider.defaultModel;
  }

  /** Evaluate one state against a map of typed questions in a single call. */
  async decide<Q extends Record<string, JevQuestion>>(
    state: JevState,
    questions: Q,
    opts: { signal?: AbortSignal; model?: string } = {},
  ): Promise<JevResponse<Q>> {
    const raw = await this.provider.decide(
      { model: opts.model ?? this.model, state, questions },
      opts.signal,
    );
    return normalize(raw, this.provider.name) as JevResponse<Q>;
  }
}

function resolveProvider(opts: JevClientOptions): Provider {
  const choice = opts.provider ?? process.env.JEV_PROVIDER ?? "auto";
  if (typeof choice === "object") return choice;

  const orKey = opts.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  const tsKey = opts.typesafeApiKey ?? process.env.TYPESAFE_API_KEY;

  switch (choice) {
    case "openrouter":
      if (!orKey) throw new Error("JEV_PROVIDER=openrouter but OPENROUTER_API_KEY is not set");
      return new OpenRouterProvider(orKey);
    case "typesafe":
      if (!tsKey) throw new Error("JEV_PROVIDER=typesafe but TYPESAFE_API_KEY is not set");
      return new TypeSafeProvider(tsKey);
    case "mock":
      return new MockProvider();
    case "auto": {
      if (orKey) return new OpenRouterProvider(orKey);
      if (tsKey) return new TypeSafeProvider(tsKey);
      if (opts.warnOnMock !== false) {
        console.error(
          "[jev-client] No OPENROUTER_API_KEY or TYPESAFE_API_KEY found — using the mock provider. " +
            "Answers are keyword heuristics, not real Jev decisions.",
        );
      }
      return new MockProvider();
    }
    default:
      throw new Error(`Unknown JEV_PROVIDER "${choice}" (expected openrouter|typesafe|mock)`);
  }
}

// ---- Question builders ------------------------------------------------------

/** Yes/no probability question. */
export function noul(
  instructions: Structured,
  criteria?: { true?: Structured; false?: Structured },
): NoulQuestion {
  return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
}

/** Pick-one question over a defined option set. */
export function choice(
  instructions: Structured,
  criteria: Record<string, Structured | null>,
): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

/** Ordered-rubric question; criteria index 0 is the lowest level. */
export function score(instructions: Structured, criteria: Structured[]): ScoreQuestion {
  if (criteria.length < 2) throw new Error("score questions need at least 2 ordered levels");
  return { type: "score", instructions, criteria };
}
