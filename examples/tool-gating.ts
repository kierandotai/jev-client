/**
 * Agent tool gating: before an agent fires an expensive or side-effecting
 * tool, ask Jev whether the state actually warrants it, and escalate to a
 * human when a routing decision comes back low-confidence.
 */
import { JevClient, choice } from "../src/index.ts";
import { gateToolCall, escalateIfUnsure } from "../src/helpers.ts";

const client = new JevClient();

const agentState = {
  goal: "Resolve the user's billing complaint",
  conversation: [
    { role: "user", content: "You charged me twice for March! I want my money back today." },
    { role: "assistant", content: "I can see two charges on 2026-03-01 and 2026-03-02 for $49 each." },
  ],
  last_step: "verified duplicate charge exists",
};

// 1. Gate a side-effecting tool call.
const gate = await gateToolCall(client, agentState, {
  name: "issue_refund",
  description: "Refunds a charge to the customer's card immediately. Irreversible.",
});
console.log(`issue_refund allowed: ${gate.allow} (p=${gate.probability}, cost $${gate.cost_usd.toFixed(8)})`);

// 2. Confidence-gated escalation on a routing decision.
const res = await client.decide(agentState, {
  next_action: choice("What should the agent do next?", {
    refund: "Issue the refund now — duplicate charge is verified",
    verify_more: "Gather more evidence before touching money",
    escalate: "Hand to a human agent",
  }),
});
const decision = escalateIfUnsure(res.answers.next_action, 0.7);
if (decision.decided) {
  console.log(`next action: ${decision.value}`);
} else {
  console.log(`escalating to human — confidence ${res.answers.next_action.confidence} below 0.7`);
}
