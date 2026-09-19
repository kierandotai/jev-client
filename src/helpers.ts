import { JevClient, choice, noul, score } from "./client.ts";
import type { ChoiceAnswer, JevState } from "./types.ts";

/**
 * Common decision patterns on top of JevClient.
 * Each helper is one Jev call; fan several together with client.decide()
 * when you need multiple answers about the same state (cheaper: one request).
 */

export interface UrgencyResult {
  urgent: boolean;
  probability: number;
  cost_usd: number;
}

/** Is this state urgent? Returns the noul probability with a 0.5 default threshold. */
export async function detectUrgency(
  client: JevClient,
  state: JevState,
  threshold = 0.5,
): Promise<UrgencyResult> {
  const res = await client.decide(state, {
    urgent: noul("Does this require immediate attention or action?", {
      true: "Time-sensitive, blocking, or explicitly demanding fast action",
      false: "Routine, informational, or can wait for normal handling",
    }),
  });
  const p = res.answers.urgent.noul;
  return { urgent: p >= threshold, probability: p, cost_usd: res.estimated_cost_usd };
}

export interface RouteResult {
  route: string;
  probabilities: Record<string, number>;
  confidence: number;
  cost_usd: number;
}

/** Route a state to one of several named destinations (queues, teams, handlers). */
export async function route(
  client: JevClient,
  state: JevState,
  routes: Record<string, string>,
): Promise<RouteResult> {
  const res = await client.decide(state, {
    route: choice("Which destination should handle this?", routes),
  });
  const a = res.answers.route;
  return {
    route: a.choice,
    probabilities: a.probabilities,
    confidence: a.confidence,
    cost_usd: res.estimated_cost_usd,
  };
}

/** Classify a state into one label from a flat list (labels used as their own descriptions). */
export async function classify(
  client: JevClient,
  state: JevState,
  labels: string[],
): Promise<RouteResult> {
  return route(client, state, Object.fromEntries(labels.map((l) => [l, l])));
}

export interface GateResult {
  allow: boolean;
  probability: number;
  cost_usd: number;
}

/**
 * Tool-call gating: should an agent invoke `tool` given the current state?
 * Use before expensive or side-effecting tool calls.
 */
export async function gateToolCall(
  client: JevClient,
  state: JevState,
  tool: { name: string; description: string },
  threshold = 0.5,
): Promise<GateResult> {
  const res = await client.decide(state, {
    invoke: noul(
      {
        question: `Should the agent invoke the tool "${tool.name}" right now?`,
        tool: tool.description,
      },
      {
        true: "The state clearly calls for this tool's capability now",
        false: "The tool is unnecessary, premature, or the wrong capability for this state",
      },
    ),
  });
  const p = res.answers.invoke.noul;
  return { allow: p >= threshold, probability: p, cost_usd: res.estimated_cost_usd };
}

export type Gated<T> = { decided: true; value: T } | { decided: false; reason: "low_confidence" };

/**
 * Confidence-gated escalation: accept a choice answer only when the model is
 * sufficiently sure; otherwise hand the case to a human / bigger model.
 */
export function escalateIfUnsure(answer: ChoiceAnswer, minConfidence = 0.7): Gated<string> {
  return answer.confidence >= minConfidence
    ? { decided: true, value: answer.choice }
    : { decided: false, reason: "low_confidence" };
}

/** Severity scoring on a standard 0–3 rubric; returns the weighted score and top level. */
export async function severity(client: JevClient, state: JevState) {
  const res = await client.decide(state, {
    severity: score("How severe is the situation described?", [
      "No issue: informational or positive",
      "Minor: inconvenience with an easy workaround",
      "Major: core functionality impaired for the user",
      "Critical: outage, data loss, security exposure, or money at risk",
    ]),
  });
  return { ...res.answers.severity, cost_usd: res.estimated_cost_usd };
}
