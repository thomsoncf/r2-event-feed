import { Hono } from "hono";
import { audit, createFeedSubscription, revokeFeedSubscription } from "../d1";
import { getUser, requireSubscriber } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.use("/api/subscriptions/webhook*", requireSubscriber());

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

router.post("/api/subscriptions/webhook", async (c) => {
	const user = getUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { url?: string };
	const url = body.url?.trim();
	if (!url || !/^https:\/\//.test(url)) return c.json({ error: "https url required" }, 400);

	// Generate a per-subscription HMAC secret. We only persist the hash so a
	// D1 leak doesn't leak the signing key. The subscriber sees it once.
	const secretBytes = new Uint8Array(32);
	crypto.getRandomValues(secretBytes);
	const secret = btoa(String.fromCharCode(...secretBytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const secret_hash = await sha256hex(secret);

	const id = await createFeedSubscription(c.env.DB, {
		subscriber_id: user.subscriber_id!,
		channel: "webhook",
		target: url,
		secret_hash,
		shard_id: null,
		stream_kid: null,
		status: "active",
	});
	await audit(c.env.DB, user.id, "subscription.webhook.create", String(id), { url });

	return c.json(
		{
			id,
			channel: "webhook",
			url,
			secret,
			notice: "Save this signing secret now. It will not be shown again.",
		},
		201,
	);
});

router.delete("/api/subscriptions/webhook/:id", async (c) => {
	const user = getUser(c);
	const id = Number.parseInt(c.req.param("id"), 10);
	if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
	const ok = await revokeFeedSubscription(c.env.DB, id, user.subscriber_id!);
	if (!ok) return c.json({ error: "not_found" }, 404);
	await audit(c.env.DB, user.id, "subscription.webhook.revoke", String(id), null);
	return c.json({ revoked: true });
});

export default router;
