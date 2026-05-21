import type { FeedEvent } from "../types";

/**
 * Webhook delivery. HMAC-SHA256 over `${timestamp}.${body}` (Stripe-style).
 * Returns true on success (2xx). Throws on 5xx so Queues retries the batch.
 * 4xx is treated as terminal — caller decides whether to swallow.
 */
export async function deliverWebhook(args: {
	url: string;
	event: FeedEvent;
	signingSecret: string;
}): Promise<{ ok: boolean; status: number; retryable: boolean }> {
	const body = JSON.stringify(args.event);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const sig = await sign(`${timestamp}.${body}`, args.signingSecret);

	const res = await fetch(args.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Feed-Event-Id": args.event.id,
			"X-Feed-Timestamp": timestamp,
			"X-Feed-Signature": `sha256=${sig}`,
		},
		body,
	});

	const retryable = res.status >= 500 || res.status === 429;
	return { ok: res.ok, status: res.status, retryable };
}

async function sign(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
