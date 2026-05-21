import { Hono } from "hono";
import { audit, createApproval, createSubscriber, getSubscriber } from "../d1";
import { getUser } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.post("/api/enrol", async (c) => {
	const user = getUser(c);
	// Anyone authenticated who isn't already linked to a subscriber may enrol.
	// The two roles are independent — having a subscriber_id grants subscriber
	// capabilities, the `role` column grants admin capabilities.
	if (user.subscriber_id) {
		return c.json({ error: "already_enrolled", subscriber_id: user.subscriber_id }, 409);
	}

	const body = (await c.req.json().catch(() => ({}))) as { name?: string };
	const name = body.name?.trim();
	if (!name) return c.json({ error: "name required" }, 400);

	// Auto-approval: anyone who can sign in (i.e. passes Cloudflare Access) is
	// trusted enough to be a subscriber. We still write an approvals row for
	// the audit trail, but mark it decided immediately and the subscriber
	// goes straight to 'approved'.
	const id = `sub_${crypto.randomUUID().slice(0, 8)}`;
	const now = Math.floor(Date.now() / 1000);
	await createSubscriber(c.env.DB, {
		id,
		name,
		contact_email: user.email,
		status: "approved",
		created_at: now,
	});
	await c.env.DB.prepare("UPDATE users SET subscriber_id = ? WHERE id = ?").bind(id, user.id).run();
	const approvalId = await createApproval(c.env.DB, {
		subscriber_id: id,
		requested_by: user.id,
	});
	// Mark the approval as already auto-approved by the same user.
	await c.env.DB.prepare(
		"UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, note = 'auto-approved on enrol' WHERE id = ?",
	)
		.bind(user.id, now, approvalId)
		.run();
	await audit(c.env.DB, user.id, "subscriber.create", id, { approvalId, auto_approved: true });

	return c.json({ subscriber_id: id, approval_id: approvalId, status: "approved" }, 201);
});

router.get("/api/me", async (c) => {
	const user = getUser(c);
	const subscriber = user.subscriber_id ? await getSubscriber(c.env.DB, user.subscriber_id) : null;
	return c.json({ user, subscriber });
});

export default router;
