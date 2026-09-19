/**
 * Customer support triage: one Jev call answers routing, urgency, and
 * frustration for a ticket simultaneously — the canonical System One pattern.
 */
import { JevClient, noul, choice, score } from "../src/index.ts";

const client = new JevClient();

const ticket = {
  subject: "Can't connect Stripe account",
  body:
    "Hi, I've been trying to connect my Stripe account for 3 days. " +
    "Every time I click Connect I get an 'invalid_grant' error. " +
    "We launch on Monday and payments are completely blocked. Please help!",
  plan: "pro",
  prior_tickets: 2,
};

const res = await client.decide(ticket, {
  department: choice("Which team should own this ticket?", {
    billing: "Payments, invoices, refunds, payment-provider account linking",
    technical: "Bugs, errors, API integration problems in the product itself",
    account: "Login, permissions, plan changes, profile issues",
  }),
  urgent: noul("Does this ticket need same-day handling?", {
    true: "Launch-blocking, revenue-blocking, or explicit deadline pressure",
    false: "Routine question or issue with a workaround",
  }),
  frustration: score("How frustrated is the customer?", [
    "Calm: neutral or friendly tone",
    "Annoyed: signals of impatience or repeated attempts",
    "Angry: explicit anger, threats to churn, or escalation demands",
  ]),
});

console.log(`provider: ${res.provider}  model: ${res.model}`);
console.log(`department: ${res.answers.department.choice} (confidence ${res.answers.department.confidence})`);
console.log(`   probabilities:`, res.answers.department.probabilities);
console.log(`urgent: p=${res.answers.urgent.noul}`);
console.log(`frustration: ${res.answers.frustration.score} on 0-2 scale`);
console.log(`tokens: ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
console.log(`cost: $${res.estimated_cost_usd.toFixed(8)}`);
