/**
 * HS256 JWT for Stream Keys. Standalone, no deps.
 * Notes:
 *   - No `exp` claim — revocation is via D1.
 *   - `kid` is unique per subscription so revocation is per-key.
 */

function b64url(input: ArrayBuffer | Uint8Array | string): string {
	const bytes =
		typeof input === "string"
			? new TextEncoder().encode(input)
			: input instanceof ArrayBuffer
				? new Uint8Array(input)
				: input;
	let str = "";
	for (let i = 0; i < bytes.length; i++) {
		str += String.fromCharCode(bytes[i]!);
	}
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signStreamKey(claims: StreamKeyClaims, secret: string): Promise<string> {
	const header = { alg: "HS256", typ: "JWT", kid: claims.kid };
	const headerEnc = b64url(JSON.stringify(header));
	const payloadEnc = b64url(JSON.stringify(claims));
	const data = `${headerEnc}.${payloadEnc}`;
	const key = await importKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return `${data}.${b64url(sig)}`;
}

export async function verifyStreamKey(
	token: string,
	secret: string,
): Promise<StreamKeyClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [h, p, s] = parts as [string, string, string];
	const data = `${h}.${p}`;
	const key = await importKey(secret);
	const sigBytes = b64urlDecode(s);
	const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
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

export function newKid(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `fk_${b64url(bytes)}`;
}
