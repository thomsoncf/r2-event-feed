import type { MiddlewareHandler } from "hono";
import { audit } from "../d1";
import type { Env, Variables } from "../types";

/**
 * Lightweight audit middleware. Logs the action AFTER a successful response,
 * with the actor's user id and the request method+path.
 *
 * Routes can override the recorded action / target by setting context vars,
 * but for v0 we record the literal path so the audit log is always populated.
 */
export function auditMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
	return async (c, next) => {
		await next();
		if (c.res.status >= 400) return;
		const user = c.get("user");
		const action = `${c.req.method} ${new URL(c.req.url).pathname}`;
		await audit(c.env.DB, user?.id ?? "anonymous", action, "http", null);
	};
}
