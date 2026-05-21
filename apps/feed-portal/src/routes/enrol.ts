import { Hono } from "hono";
import { audit, createApproval, createSubscriber, getSubscriber } from "../d1";
import { getUser } from "../middleware/access";
import type { Env, Variables } from "../types";

const router = new Hono<{ Bindings: Env; Variables: Variables }>();

router.post("/api/enrol", async (c) => {
	const user = getUser(c);
	if (user.role !== "subscriber_user") {
		return c.json({ error: "operators cannot self-enrol as subscribers" }, 400);
	}
	if (user.subscriber_id) {
		return c.json({ error: "already_enrolled", subscriber_id: user.subscriber_id }, 409);
	}

	const body = (await c.req.json().catch(() => ({}))) as { name?: string };
	const name = body.name?.trim();
	if (!name) return c.json({ error: "name required" }, 400);

	const id = `sub_${crypto.randomUUID().slice(0, 8)}`;
	await createSubscriber(c.env.DB, {
		id,
		name,
		contact_email: user.email,
		status: "pending",
	});
	await c.env.DB.prepare("UPDATE users SET subscriber_id = ? WHERE id = ?").bind(id, user.id).run();
	const approvalId = await createApproval(c.env.DB, {
		subscriber_id: id,
		requested_by: user.id,
	});
	await audit(c.env.DB, user.id, "subscriber.create", id, { approvalId });

	return c.json({ subscriber_id: id, approval_id: approvalId, status: "pending" }, 201);
});

router.get("/api/me", async (c) => {
	const user = getUser(c);
	const subscriber = user.subscriber_id ? await getSubscriber(c.env.DB, user.subscriber_id) : null;
	return c.json({ user, subscriber });
});

export default router;
