/**
 * Stream Key JWT verifier (HS256). Mirrors apps/feed-portal/src/jwt.ts.
 * Re-implemented (not imported) so the two workers remain independently deployable.
 */

function b64urlDecode(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export interface StreamKeyClaims {
	kid: string;
	subscriber_id: string;
	subscription_id: number;
	shard_id: number;
	iat: number;
}

export async function verifyStreamKey(
	token: string,
	secret: string,
): Promise<StreamKeyClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [h, p, s] = parts as [string, string, string];
	const data = `${h}.${p}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const ok = await crypto.subtle.verify(
		"HMAC",
		key,
		b64urlDecode(s),
		new TextEncoder().encode(data),
	);
	if (!ok) return null;
	try {
		const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as StreamKeyClaims;
		if (!claims.kid || !claims.subscriber_id || typeof claims.subscription_id !== "number") {
			return null;
		}
		return claims;
	} catch {
		return null;
	}
}
