import { Hono } from "hono";
import { audit, decideApproval, listPendingApprovals, listSubscribers } from "../d1";
import { getUser, requireOperator } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.use("/api/admin/*", requireOperator());

router.get("/api/admin/subscribers", async (c) => {
	const subscribers = await listSubscribers(c.env.DB);
	return c.json({ subscribers });
});

router.get("/api/admin/approvals", async (c) => {
	const approvals = await listPendingApprovals(c.env.DB);
	return c.json({ approvals });
});

router.post("/api/admin/approvals/:id/decision", async (c) => {
	const user = getUser(c);
	const id = Number.parseInt(c.req.param("id"), 10);
	if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
	const body = (await c.req.json().catch(() => ({}))) as {
		decision?: "approved" | "denied";
		note?: string;
	};
	if (body.decision !== "approved" && body.decision !== "denied") {
		return c.json({ error: "decision must be approved or denied" }, 400);
	}
	await decideApproval(c.env.DB, id, user.id, body.decision, body.note ?? null);
	await audit(c.env.DB, user.id, `approval.${body.decision}`, String(id), null);
	return c.json({ ok: true });
});

router.get("/api/admin/audit", async (c) => {
	const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
	const result = await c.env.DB.prepare(
		"SELECT id, actor, action, target, payload_json, created_at FROM audit_log ORDER BY id DESC LIMIT ?",
	)
		.bind(limit)
		.all();
	return c.json({ audit: result.results });
});

export default router;
