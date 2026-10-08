// POST /ingest/email — Apps Script's Gmail poller hands each new forwarded
// email to the Worker. HMAC-signed (INTERNAL_SECRET). Replies:
//   200 { status }  — handled (saved/review/linked/duplicate/ignored/no_tenant);
//                     the poller labels the message processed
//   400             — malformed body (labelled too: retrying won't help)
//   401             — bad signature
//   503 { status }  — transient failure (LLM down); poller leaves it unlabelled
import { verifySignedRequest } from "./auth.js";
import { tenantForForward } from "./onboarding.js";
import { ingest } from "./ingest.js";

export async function handleIngestEmail(ctx, request) {
  const auth = await verifySignedRequest(request, ctx.env.INTERNAL_SECRET, ctx.now());
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: 401 });

  let body;
  try {
    body = JSON.parse(auth.body);
  } catch (_) {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { messageId, forwarder, receivedAt, text, silent } = body || {};
  if (!messageId || !forwarder || typeof text !== "string") {
    return Response.json({ error: "messageId, forwarder and text are required" }, { status: 400 });
  }

  const tenant = await tenantForForward(ctx, forwarder);
  if (!tenant) return Response.json({ status: "no_tenant" });

  const res = await ingest(ctx, {
    tenant,
    source: "email",
    sourceRef: String(messageId),
    text,
    receivedAt: Number(receivedAt) || ctx.now(),
    forwarder: String(forwarder).split("@")[0],
    silent: !!silent
  });
  return Response.json(res, { status: res.status === "failed" ? 503 : 200 });
}
