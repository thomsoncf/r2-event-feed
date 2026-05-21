import { Hono } from "hono";
import { createSubscriberQueue } from "../cloudflare-api";
import { audit, createFeedSubscription, revokeFeedSubscription } from "../d1";
import { newKid, signStreamKey } from "../jwt";
import { getUser, requireSubscriber } from "../middleware/access";
import { pickShard } from "../shard";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.use("/api/subscriptions/stream*", requireSubscriber());
router.use("/api/subscriptions/pull-queue*", requireSubscriber());

router.post("/api/subscriptions/stream", async (c) => {
	const user = getUser(c);
	const subscriberId = user.subscriber_id!;
	const kid = newKid();
	const shard_id = pickShard(subscriberId);

	const id = await createFeedSubscription(c.env.DB, {
		subscriber_id: subscriberId,
		channel: "sse",
		target: `shard:${shard_id}`,
		secret_hash: null,
		shard_id,
		stream_kid: kid,
		status: "active",
	});

	const jwt = await signStreamKey(
		{
			kid,
			subscriber_id: subscriberId,
			subscription_id: id,
			shard_id,
			iat: Math.floor(Date.now() / 1000),
		},
		c.env.STREAM_JWT_SECRET,
	);

	await audit(c.env.DB, user.id, "subscription.stream.create", String(id), { kid, shard_id });

	return c.json(
		{
			id,
			channel: "sse",
			kid,
			shard_id,
			stream_key: jwt,
			notice: "Save this stream key now. It will not be shown again.",
		},
		201,
	);
});

router.delete("/api/subscriptions/stream/:id", async (c) => {
	const user = getUser(c);
	const id = Number.parseInt(c.req.param("id"), 10);
	if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
	const ok = await revokeFeedSubscription(c.env.DB, id, user.subscriber_id!);
	if (!ok) return c.json({ error: "not_found" }, 404);
	await audit(c.env.DB, user.id, "subscription.stream.revoke", String(id), null);
	return c.json({ revoked: true });
});

router.post("/api/subscriptions/pull-queue", async (c) => {
	const user = getUser(c);
	const subscriberId = user.subscriber_id!;

	const { queue_name } = await createSubscriberQueue({
		token: c.env.CF_API_TOKEN,
		accountId: c.env.CF_ACCOUNT_ID,
		subscriberId,
	});

	const id = await createFeedSubscription(c.env.DB, {
		subscriber_id: subscriberId,
		channel: "pull_queue",
		target: queue_name,
		secret_hash: null,
		shard_id: null,
		stream_kid: null,
		status: "active",
	});
	await audit(c.env.DB, user.id, "subscription.pull_queue.create", String(id), { queue_name });

	return c.json(
		{
			id,
			channel: "pull_queue",
			queue_name,
			notice: "Use the Queues HTTP Pull API with a queue-scoped token to receive messages.",
		},
		201,
	);
});

router.delete("/api/subscriptions/pull-queue/:id", async (c) => {
	const user = getUser(c);
	const id = Number.parseInt(c.req.param("id"), 10);
	if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
	const ok = await revokeFeedSubscription(c.env.DB, id, user.subscriber_id!);
	if (!ok) return c.json({ error: "not_found" }, 404);
	await audit(c.env.DB, user.id, "subscription.pull_queue.revoke", String(id), null);
	return c.json({ revoked: true });
});

router.get("/api/subscriptions", async (c) => {
	const user = getUser(c);
	const result = await c.env.DB.prepare(
		`SELECT id, channel, target, shard_id, status, created_at, revoked_at
			 FROM feed_subscriptions WHERE subscriber_id = ? ORDER BY created_at DESC`,
	)
		.bind(user.subscriber_id!)
		.all();
	return c.json({ subscriptions: result.results });
});

export default router;
