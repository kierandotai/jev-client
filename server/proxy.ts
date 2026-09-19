/**
 * Local HTTP proxy exposing Jev at TypeSafe's own API shape, so any tool that
 * can speak `POST /v1/systemone` can point its base URL at localhost and work
 * unchanged. Keys stay in this process; callers need none.
 *
 *   npm run proxy
 *   curl -s localhost:8787/v1/systemone -H 'content-type: application/json' \
 *     -d '{"state":"refund not received in 10 days","questions":{"urgent":{"type":"noul","instructions":"Is this urgent?"}}}'
 */
import { createServer } from "node:http";
import { JevClient } from "../src/client.ts";
import { JevError, type JevRequest } from "../src/types.ts";

const client = new JevClient();
const port = Number(process.env.JEV_PROXY_PORT ?? 8787);

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/healthz") {
    return send(200, { ok: true, provider: client.provider.name, model: client.model });
  }
  // Accept both the TypeSafe path and the OpenRouter alpha path.
  if (req.method !== "POST" || !["/v1/systemone", "/api/alpha/decisions"].includes(req.url ?? "")) {
    return send(404, { error: "Use POST /v1/systemone (or /api/alpha/decisions), GET /healthz" });
  }

  let body: Partial<JevRequest>;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(400, { error: "Invalid JSON body" });
  }
  if (body.state === undefined || !body.questions || Object.keys(body.questions).length === 0) {
    return send(422, { error: "Body must include `state` and a non-empty `questions` map" });
  }

  try {
    const out = await client.decide(body.state, body.questions, { model: body.model });
    send(200, out);
  } catch (err) {
    if (err instanceof JevError) return send(err.status ?? 502, { error: err.message, provider: err.provider });
    send(500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, () => {
  console.log(`jev proxy on http://localhost:${port} → provider=${client.provider.name} model=${client.model}`);
});
