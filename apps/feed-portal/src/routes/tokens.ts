import { Hono } from "hono";
import { mintR2Token, revokeR2Token } from "../cloudflare-api";
import { audit } from "../d1";
import { getUser, requireSubscriber } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.use("/api/r2-tokens/*", requireSubscriber());

router.post("/api/r2-tokens", async (c) => {
	const user = getUser(c);
	const subscriberId = user.subscriber_id!;
	const body = (await c.req.json().catch(() => ({}))) as { label?: string };
	const label = body.label?.trim() || "default";

	const minted = await mintR2Token({
		token: c.env.CF_API_TOKEN,
		accountId: c.env.CF_ACCOUNT_ID,
		bucket: c.env.SOURCE_BUCKET_NAME,
		subscriberId,
		label,
	});

	const scope = JSON.stringify({ bucket: c.env.SOURCE_BUCKET_NAME, permission: "objects-read" });
	await c.env.DB.prepare(
		"INSERT INTO r2_tokens (id, subscriber_id, label, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(minted.id, subscriberId, label, scope, user.id, Math.floor(Date.now() / 1000))
		.run();

	await audit(c.env.DB, user.id, "r2_token.mint", minted.id, { label });

	// IMPORTANT: secret is shown ONCE.
	return c.json(
		{
			id: minted.id,
			label,
			access_key_id: minted.access_key_id,
			secret_access_key: minted.secret_access_key,
			endpoint: minted.endpoint,
			bucket: c.env.SOURCE_BUCKET_NAME,
			notice: "Save this secret now. It will not be shown again.",
		},
		201,
	);
});

router.get("/api/r2-tokens", async (c) => {
	const user = getUser(c);
	const result = await c.env.DB.prepare(
		"SELECT id, label, scope, created_at, revoked_at FROM r2_tokens WHERE subscriber_id = ? ORDER BY created_at DESC",
	)
		.bind(user.subscriber_id!)
		.all();
	return c.json({ tokens: result.results });
});

router.delete("/api/r2-tokens/:id", async (c) => {
	const user = getUser(c);
	const tokenId = c.req.param("id");
	const owned = await c.env.DB.prepare(
		"SELECT id FROM r2_tokens WHERE id = ? AND subscriber_id = ?",
	)
		.bind(tokenId, user.subscriber_id!)
		.first();
	if (!owned) return c.json({ error: "not_found" }, 404);

	await revokeR2Token({
		token: c.env.CF_API_TOKEN,
		accountId: c.env.CF_ACCOUNT_ID,
		tokenId,
	});
	await c.env.DB.prepare("UPDATE r2_tokens SET revoked_at = ? WHERE id = ?")
		.bind(Math.floor(Date.now() / 1000), tokenId)
		.run();
	await audit(c.env.DB, user.id, "r2_token.revoke", tokenId, null);

	return c.json({ revoked: true });
});

export default router;
