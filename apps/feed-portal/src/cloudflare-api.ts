/**
 * Thin Cloudflare REST API client. Used by the portal control plane to:
 *   - Mint R2 Object-Read tokens scoped to a single bucket.
 *   - Provision per-subscriber pull queues on demand.
 *   - Revoke either of the above.
 *
 * We intentionally do NOT proxy the response unchanged — we want to record only
 * the durable, non-secret bits in D1.
 */

interface CfApiResponse<T> {
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	messages: Array<{ code: number; message: string }>;
	result: T;
}

async function cfFetch<T>(
	token: string,
	path: string,
	init?: RequestInit,
): Promise<CfApiResponse<T>> {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const body = (await res.json()) as CfApiResponse<T>;
	if (!body.success) {
		const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
		throw new Error(`Cloudflare API ${path}: ${msg}`);
	}
	return body;
}

export interface MintedR2Token {
	id: string;
	value: string;
	access_key_id: string;
	secret_access_key: string;
	endpoint: string;
}

export async function mintR2Token(args: {
	token: string;
	accountId: string;
	bucket: string;
	subscriberId: string;
	label: string;
}): Promise<MintedR2Token> {
	const body = {
		name: `r2-event-feed/${args.subscriberId}/${args.label}`,
		policies: [
			{
				effect: "allow",
				permission_groups: [{ id: "objects-read" }],
				resources: {
					[`com.cloudflare.api.account.${args.accountId}`]: {
						"r2:bucket": [`${args.bucket}`],
					},
				},
			},
		],
	};

	const res = await cfFetch<MintedR2Token>(
		args.token,
		`/accounts/${args.accountId}/r2/api_tokens`,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);
	return res.result;
}

export async function revokeR2Token(args: {
	token: string;
	accountId: string;
	tokenId: string;
}): Promise<void> {
	await cfFetch(args.token, `/accounts/${args.accountId}/r2/api_tokens/${args.tokenId}`, {
		method: "DELETE",
	});
}

export async function createSubscriberQueue(args: {
	token: string;
	accountId: string;
	subscriberId: string;
}): Promise<{ queue_id: string; queue_name: string }> {
	const queue_name = `r2-event-feed-sub-${args.subscriberId}`.toLowerCase().slice(0, 64);
	const res = await cfFetch<{ queue_id: string; queue_name: string }>(
		args.token,
		`/accounts/${args.accountId}/queues`,
		{
			method: "POST",
			body: JSON.stringify({ queue_name }),
		},
	);
	return res.result;
}
