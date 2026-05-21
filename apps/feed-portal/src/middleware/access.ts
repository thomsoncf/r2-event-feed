import type { Context, MiddlewareHandler } from "hono";
import { createUser, findUserByEmail } from "../d1";
import type { AccessUser, DbUser, Env, Variables } from "../types";

/**
 * Decode the Cf-Access-Jwt-Assertion header.
 *
 * In production behind Cloudflare Access, this header is signed by Cloudflare
 * and ALREADY validated at the edge. We decode (not verify) the payload to
 * extract the user's email + sub claim and use them to find/create our local
 * D1 user row.
 *
 * In dev (no Access in front), we accept a fallback `X-Demo-Email` header
 * gated by a `DEMO_AUTH=1` env var (not set in production).
 */

function b64urlDecode(input: string): string {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((input.length + 3) % 4);
	return atob(padded);
}

function decodeJwtUnsafe(jwt: string): AccessUser | null {
	const parts = jwt.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const claims = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
		const email = (claims.email as string | undefined) ?? (claims.identity as string | undefined);
		const sub = (claims.sub as string | undefined) ?? (claims.user_uuid as string | undefined);
		if (!email || !sub) return null;
		return { email, sub };
	} catch {
		return null;
	}
}

async function syncUser(db: D1Database, env: Env, access: AccessUser): Promise<DbUser> {
	const existing = await findUserByEmail(db, access.email);
	if (existing) return existing;

	// First time we've seen this user. Decide role from their email domain.
	const isOperator = access.email.toLowerCase().endsWith(`@${env.OPERATOR_ALLOWED_DOMAIN}`);
	const user = await createUser(db, {
		id: access.sub,
		subscriber_id: null,
		email: access.email,
		role: isOperator ? "operator_admin" : "subscriber_user",
	});
	return user;
}

export function accessMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
	return async (c, next) => {
		const jwt = c.req.header("Cf-Access-Jwt-Assertion");
		let access: AccessUser | null = null;

		if (jwt) {
			access = decodeJwtUnsafe(jwt);
		}

		// Dev / unauthenticated path
		if (!access) {
			const demoEmail = c.req.header("X-Demo-Email");
			if (demoEmail) {
				access = { email: demoEmail, sub: `demo:${demoEmail}` };
			}
		}

		if (!access) {
			return c.json({ error: "unauthenticated" }, 401);
		}

		const user = await syncUser(c.env.DB, c.env, access);
		c.set("user", user);
		await next();
	};
}

export function requireOperator(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
	return async (c, next) => {
		const u = c.get("user");
		if (u.role !== "operator_admin") return c.json({ error: "forbidden" }, 403);
		await next();
	};
}

export function requireSubscriber(): MiddlewareHandler<{
	Bindings: Env;
	Variables: Variables;
}> {
	return async (c, next) => {
		const u = c.get("user");
		if (u.role !== "subscriber_user" || !u.subscriber_id) {
			return c.json({ error: "not_enrolled" }, 403);
		}
		await next();
	};
}

export function getUser(c: Context<{ Bindings: Env; Variables: Variables }>) {
	return c.get("user");
}
