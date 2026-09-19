/**
 * Multi-question fan-out over a batch of items: one request per item, each
 * carrying several questions. Requests run concurrently; Jev bills input
 * tokens only, so the summed cost is printed at the end.
 */
import { JevClient, noul, choice } from "../src/index.ts";

const client = new JevClient();

const reviews = [
  "The app crashes every time I open the camera. Unusable since the last update.",
  "Love it! The new dark mode is gorgeous and battery life improved too.",
  "Decent, but I wish exports supported CSV. Also, pricing feels steep for solo users.",
  "My data disappeared after syncing across devices. This is unacceptable — I'm deleting my account.",
];

const results = await Promise.all(
  reviews.map((text) =>
    client.decide(text, {
      sentiment: choice("What is the overall sentiment?", {
        positive: null,
        neutral: null,
        negative: null,
      }),
      churn_risk: noul("Is this user at risk of leaving the product?", {
        true: "Expresses intent to quit, delete, or switch away",
        false: "No signal of leaving",
      }),
      bug_report: noul("Does this review report a defect (crash, data loss, error)?"),
    }),
  ),
);

let totalCost = 0;
results.forEach((res, i) => {
  totalCost += res.estimated_cost_usd;
  console.log(
    `#${i + 1} ${res.answers.sentiment.choice.padEnd(8)} churn=${res.answers.churn_risk.noul.toFixed(2)} ` +
      `bug=${res.answers.bug_report.noul.toFixed(2)}  "${reviews[i].slice(0, 48)}..."`,
  );
});
console.log(`\n${reviews.length} reviews, total cost $${totalCost.toFixed(8)} via ${results[0].provider}`);
