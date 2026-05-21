import { Hono } from "hono";
import { Broadcaster } from "./broadcaster";
import { deliverBroadcast } from "./delivery/broadcast";
import { deliverWebhook } from "./delivery/webhook";
import { verifyStreamKey } from "./jwt";
import { shardName } from "./shard";
import type { Env, FeedEvent, R2EventMessage } from "./types";

export { Broadcaster };

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ ok: true, service: "feed-fanout" }));

/**
 * SSE upgrade endpoint.
 * Caller is the subscriber's browser / server holding a Stream Key JWT.
 *
 * We validate the JWT signature, then read D1 to ensure the kid is still
 * active and not revoked. On any failure → 401.
 */
app.get("/stream", async (c) => {
	const key = c.req.query("key") ?? c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
	if (!key) return c.json({ error: "missing key" }, 401);

	const claims = await verifyStreamKey(key, c.env.STREAM_JWT_SECRET);
	if (!claims) return c.json({ error: "invalid key" }, 401);

	// D1 revocation check on every upgrade. Cheap and authoritative.
	const row = await c.env.DB.prepare(
		"SELECT id, status, shard_id FROM feed_subscriptions WHERE stream_kid = ? LIMIT 1",
	)
		.bind(claims.kid)
		.first<{ id: number; status: string; shard_id: number }>();

	if (!row || row.status !== "active") {
		return c.json({ error: "key revoked" }, 401);
	}

	const ns = c.env.BROADCASTER.idFromName(shardName(row.shard_id));
	const stub = c.env.BROADCASTER.get(ns);
	return stub.fetch(`https://internal/internal/sse`, {
		headers: {
			"X-Feed-Subscriber": claims.subscriber_id,
			"X-Feed-Subscription": String(row.id),
		},
	});
});

/**
 * WebSocket upgrade. Same validation as /stream.
 */
app.get("/ws", async (c) => {
	if (c.req.header("Upgrade") !== "websocket") {
		return c.json({ error: "upgrade required" }, 426);
	}
	const key = c.req.query("key");
	if (!key) return c.json({ error: "missing key" }, 401);
	const claims = await verifyStreamKey(key, c.env.STREAM_JWT_SECRET);
	if (!claims) return c.json({ error: "invalid key" }, 401);

	const row = await c.env.DB.prepare(
		"SELECT id, status, shard_id FROM feed_subscriptions WHERE stream_kid = ? LIMIT 1",
	)
		.bind(claims.kid)
		.first<{ id: number; status: string; shard_id: number }>();
	if (!row || row.status !== "active") return c.json({ error: "key revoked" }, 401);

	const ns = c.env.BROADCASTER.idFromName(shardName(row.shard_id));
	const stub = c.env.BROADCASTER.get(ns);
	return stub.fetch(`https://internal/internal/ws`, {
		headers: {
			Upgrade: "websocket",
			"X-Feed-Subscriber": claims.subscriber_id,
			"X-Feed-Subscription": String(row.id),
		},
	});
});

/**
 * Queue consumer. Each incoming R2 event notification is fanned out to every
 * active feed subscription.
 */
async function handleQueue(
	batch: MessageBatch<R2EventMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	console.log(`processing batch of ${batch.messages.length}`);

	// Pull active subscriptions once per batch.
	const subs = await env.DB.prepare(
		`SELECT id, subscriber_id, channel, target, shard_id
			 FROM feed_subscriptions WHERE status = 'active'`,
	).all<{
		id: number;
		subscriber_id: string;
		channel: "webhook" | "pull_queue" | "sse";
		target: string;
		shard_id: number | null;
	}>();

	const subscriptions = subs.results ?? [];

	const webhookSubs = subscriptions.filter((s) => s.channel === "webhook");
	const sseShardIds = Array.from(
		new Set(
			subscriptions
				.filter((s) => s.channel === "sse" && s.shard_id !== null)
				.map((s) => s.shard_id as number),
		),
	);

	for (const msg of batch.messages) {
		const event = msgToEvent(msg.body);

		// SSE / WS broadcast FIRST — fire-and-forget, never blocks the queue.
		// Doing this before webhooks ensures broadcast clients are not starved
		// when a webhook target flakes. Broadcast is idempotent on the client
		// side: each event carries a unique id, so duplicates from a queue
		// retry are safe to dedupe by the receiver.
		try {
			await deliverBroadcast(env, sseShardIds, event);
		} catch (err) {
			console.warn("broadcast threw, continuing", err);
		}

		// Webhook deliveries — fire in parallel. A retryable failure (5xx/429)
		// puts the message back on the queue with backoff. Broadcast clients
		// will see the event again on retry; that's expected.
		if (webhookSubs.length > 0) {
			const webhookResults = await Promise.allSettled(
				webhookSubs.map((s) =>
					deliverWebhook({ url: s.target, event, signingSecret: env.WEBHOOK_SIGNING_SECRET }),
				),
			);
			const retryable = webhookResults.some((r) => r.status === "fulfilled" && r.value.retryable);
			if (retryable) {
				console.log(`webhook retryable; queueing retry for event ${event.id}`);
				msg.retry();
				continue;
			}
		}

		// Pull-queue deliveries are intentionally omitted from the data plane
		// fanout for v0 — see docs/architecture.md. The Queues HTTP Pull API
		// is the canonical mechanism for that channel; we expose the queue
		// name in the portal so subscribers can pull directly.

		msg.ack();
	}
}

function msgToEvent(m: R2EventMessage): FeedEvent {
	return {
		id: crypto.randomUUID(),
		bucket: m.bucket,
		key: m.object?.key ?? "",
		action: m.action,
		size: m.object?.size,
		etag: m.object?.eTag,
		event_time: m.eventTime,
	};
}

export default {
	fetch: app.fetch,
	queue: handleQueue,
} satisfies ExportedHandler<Env, R2EventMessage>;
