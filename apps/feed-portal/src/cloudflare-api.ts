/**
 * Thin Cloudflare REST API client. Used by the portal control plane to:
 *   - Mint R2 Object-Read tokens scoped to a single bucket.
 *   - Revoke the same.
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

/**
 * Permission group id for "Workers R2 Storage Bucket Item Read" — bucket-scoped,
 * read-only. Discovered via GET /accounts/{id}/tokens/permission_groups.
 */
const R2_BUCKET_READ_PG_ID = "6a018a9f2fc74eb6b293b0c548f38b39";

async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Mint a bucket-scoped read-only R2 token using the Account API Tokens endpoint.
 *
 * Cloudflare doesn't have a dedicated `/r2/api_tokens` endpoint; R2 tokens are
 * Account API Tokens with the R2 bucket permission group. To derive
 * S3-compatible credentials for the same token:
 *   - access_key_id     = token.id
 *   - secret_access_key = sha256(token.value)
 *   - endpoint          = https://{account_id}.r2.cloudflarestorage.com
 * See https://developers.cloudflare.com/r2/api/tokens/
 */
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
				permission_groups: [
					{ id: R2_BUCKET_READ_PG_ID, name: "Workers R2 Storage Bucket Item Read" },
				],
				resources: {
					[`com.cloudflare.edge.r2.bucket.${args.accountId}_default_${args.bucket}`]: "*",
				},
			},
		],
	};

	const res = await cfFetch<{ id: string; value: string }>(
		args.token,
		`/accounts/${args.accountId}/tokens`,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);

	const access_key_id = res.result.id;
	const secret_access_key = await sha256Hex(res.result.value);
	const endpoint = `https://${args.accountId}.r2.cloudflarestorage.com`;

	return {
		id: res.result.id,
		value: res.result.value,
		access_key_id,
		secret_access_key,
		endpoint,
	};
}

export async function revokeR2Token(args: {
	token: string;
	accountId: string;
	tokenId: string;
}): Promise<void> {
	await cfFetch(args.token, `/accounts/${args.accountId}/tokens/${args.tokenId}`, {
		method: "DELETE",
	});
}
