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
	if (shardIds.length === 0) {
		console.log(`broadcast: no SSE/WS shards for event ${event.id}, skipping`);
		return;
	}
	const calls = shardIds.map(async (id) => {
		const ns = env.BROADCASTER.idFromName(shardName(id));
		const stub = env.BROADCASTER.get(ns);
		try {
			const res = await stub.broadcast(event);
			console.log(
				`broadcast: shard=${id} event=${event.id} key=${event.key} delivered=${res.delivered}`,
			);
		} catch (err) {
			console.warn(`broadcast: shard=${id} threw`, err);
		}
	});
	await Promise.all(calls);
}
