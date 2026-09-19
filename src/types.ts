/**
 * Wire types for TypeSafe System One models (Jev).
 * Mirrors https://docs.typesafe.ai/api.md so requests/responses are portable
 * between TypeSafe direct and OpenRouter's Decisions endpoint unchanged.
 */

/** State is text-only: a string, JSON object, or array of text values. */
export type JevState = string | Record<string, unknown> | unknown[];

/** Instructions/criteria values may be strings or structured JSON (see primitives/advanced). */
export type Structured = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Structured;
  /** Optional boundary definitions for what true/false mean. */
  criteria?: { true?: Structured; false?: Structured };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Structured;
  /** Option key -> description (null allowed when the key is self-explanatory). */
  criteria: Record<string, Structured | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Structured;
  /** Ordered level descriptions, minimum 2. Index 0 = lowest level. */
  criteria: Structured[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface JevRequest {
  model: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability that the answer is yes, 0–1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted value across levels (e.g. 1.3 on a 0–2 rubric). */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  /** Some gateways (OpenRouter) report billed cost directly; otherwise estimated client-side. */
  cost_usd?: number;
}

export interface JevResponse<Q extends Record<string, JevQuestion> = Record<string, JevQuestion>> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: JevUsage;
  /** Which provider actually served the call. */
  provider: string;
  /** Estimated cost at $0.042/M input tokens (output free) when the API didn't report one. */
  estimated_cost_usd: number;
}

/** Maps a question type to its answer type, so answers come back fully typed. */
export type AnswerFor<Q extends JevQuestion> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : JevAnswer;

export class JevError extends Error {
  readonly status: number | undefined;
  readonly provider: string;
  readonly body?: unknown;
  constructor(message: string, status: number | undefined, provider: string, body?: unknown) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.provider = provider;
    this.body = body;
  }
  get retryable(): boolean {
    return this.status === 429 || this.status === 529 || (this.status !== undefined && this.status >= 500);
  }
}

/** $0.042 per million input tokens; output is unmetered. */
export const INPUT_COST_PER_TOKEN_USD = 0.042 / 1_000_000;

export function estimateCostUsd(usage: { input_tokens: number }): number {
  return usage.input_tokens * INPUT_COST_PER_TOKEN_USD;
}
