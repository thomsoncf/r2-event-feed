import { shardName } from "../shard";
import type { Env, FeedEvent } from "../types";

/**
 * Broadcaster delivery.
 *
 * Given a set of shard ids that have at least one active SSE subscriber,
 * call each shard's `broadcast(event)` RPC in parallel.
 *
 * The DO will iterate its in-memory client set and `ws.send` / SSE-write each.
 */
export async function deliverBroadcast(
	env: Env,
	shardIds: number[],
	event: FeedEvent,
): Promise<void> {
	if (shardIds.length === 0) return;
	const calls = shardIds.map(async (id) => {
		const ns = env.BROADCASTER.idFromName(shardName(id));
		const stub = env.BROADCASTER.get(ns);
		try {
			await stub.broadcast(event);
		} catch (err) {
			console.warn(`broadcast to shard ${id} failed`, err);
		}
	});
	await Promise.all(calls);
}
