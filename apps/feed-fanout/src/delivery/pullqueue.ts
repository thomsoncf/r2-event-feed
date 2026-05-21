import type { FeedEvent } from "../types";

/**
 * Pull-queue delivery.
 *
 * Per-subscriber pull queues are dynamic — the queue is provisioned by the
 * portal at subscription time. The fanout worker dispatches via the
 * Cloudflare REST API rather than binding to N queues, because we'd otherwise
 * need to redeploy the worker every time a subscriber enrols.
 *
 * For a small-N MVP a binding-per-queue is fine too; we use REST here to keep
 * the architecture truly self-service.
 */
export async function deliverPullQueue(args: {
	accountId: string;
	apiToken: string;
	queueName: string;
	event: FeedEvent;
}): Promise<{ ok: boolean; status: number; retryable: boolean }> {
	// First, resolve queue_name → queue_id (could be cached; KV would help here).
	const list = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${args.accountId}/queues`,
		{
			headers: { Authorization: `Bearer ${args.apiToken}` },
		},
	);
	const body = (await list.json()) as { result?: Array<{ queue_id: string; queue_name: string }> };
	const queue = body.result?.find((q) => q.queue_name === args.queueName);
	if (!queue) return { ok: false, status: 404, retryable: false };

	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${args.accountId}/queues/${queue.queue_id}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				body: args.event,
				content_type: "json",
			}),
		},
	);

	const retryable = res.status >= 500 || res.status === 429;
	return { ok: res.ok, status: res.status, retryable };
}
