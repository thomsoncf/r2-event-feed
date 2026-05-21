import { Hono } from "hono";
import { audit } from "../d1";
import { getUser } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * One-click "trigger a test event" — PUTs a small object into the source
 * bucket. R2 event notifications then carry it through the queue, the
 * fanout worker, and out to every active subscription.
 *
 * Intentionally bound to the portal (which already has Access in front of it)
 * rather than exposed publicly. Any signed-in user can trigger.
 */
router.post("/api/demo/trigger", async (c) => {
	const user = getUser(c);
	const body = (await c.req.json().catch(() => ({}))) as { key?: string; content?: string };
	const key = (body.key ?? `demo/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt`).slice(
		0,
		256,
	);
	const content =
		body.content ??
		`r2-event-feed demo trigger\nuser: ${user.email}\nat: ${new Date().toISOString()}\n`;

	await c.env.SOURCE_BUCKET.put(key, content, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
		customMetadata: { source: "demo-trigger", triggered_by: user.email },
	});

	await audit(c.env.DB, user.id, "demo.trigger", key, { size: content.length });

	return c.json({
		ok: true,
		bucket: c.env.SOURCE_BUCKET_NAME,
		key,
		size: content.length,
		hint: "An event notification should land on your active subscriptions within ~2s.",
	});
});

export default router;
