import type { DbUser, FeedSubscription, Subscriber } from "./types";

export async function findUserByEmail(db: D1Database, email: string): Promise<DbUser | null> {
	const row = await db
		.prepare("SELECT id, subscriber_id, email, role, created_at FROM users WHERE email = ?")
		.bind(email.toLowerCase())
		.first<DbUser>();
	return row ?? null;
}

export async function createUser(
	db: D1Database,
	user: Omit<DbUser, "created_at"> & { created_at?: number },
): Promise<DbUser> {
	const created_at = user.created_at ?? Math.floor(Date.now() / 1000);
	await db
		.prepare(
			"INSERT INTO users (id, subscriber_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(user.id, user.subscriber_id, user.email.toLowerCase(), user.role, created_at)
		.run();
	return { ...user, created_at };
}

export async function getSubscriber(db: D1Database, id: string): Promise<Subscriber | null> {
	return (
		(await db
			.prepare("SELECT id, name, contact_email, status, created_at FROM subscribers WHERE id = ?")
			.bind(id)
			.first<Subscriber>()) ?? null
	);
}

export async function createSubscriber(
	db: D1Database,
	sub: Omit<Subscriber, "created_at"> & { created_at?: number },
): Promise<Subscriber> {
	const created_at = sub.created_at ?? Math.floor(Date.now() / 1000);
	await db
		.prepare(
			"INSERT INTO subscribers (id, name, contact_email, status, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(sub.id, sub.name, sub.contact_email, sub.status, created_at)
		.run();
	return { ...sub, created_at };
}

export async function listSubscribers(db: D1Database): Promise<Subscriber[]> {
	const result = await db
		.prepare(
			"SELECT id, name, contact_email, status, created_at FROM subscribers ORDER BY created_at DESC",
		)
		.all<Subscriber>();
	return result.results ?? [];
}

export async function listPendingApprovals(
	db: D1Database,
): Promise<Array<{ id: number; subscriber_id: string; requested_by: string; created_at: number }>> {
	const result = await db
		.prepare(
			`SELECT a.id, a.subscriber_id, a.requested_by, s.created_at
				 FROM approvals a JOIN subscribers s ON s.id = a.subscriber_id
				 WHERE a.status = 'pending' ORDER BY s.created_at ASC`,
		)
		.all<{ id: number; subscriber_id: string; requested_by: string; created_at: number }>();
	return result.results ?? [];
}

export async function createApproval(
	db: D1Database,
	approval: { subscriber_id: string; requested_by: string },
): Promise<number> {
	const res = await db
		.prepare(
			"INSERT INTO approvals (subscriber_id, requested_by, status) VALUES (?, ?, 'pending') RETURNING id",
		)
		.bind(approval.subscriber_id, approval.requested_by)
		.first<{ id: number }>();
	return res!.id;
}

export async function decideApproval(
	db: D1Database,
	approvalId: number,
	decidedBy: string,
	decision: "approved" | "denied",
	note: string | null,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.batch([
		db
			.prepare(
				"UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?",
			)
			.bind(decision, decidedBy, now, note, approvalId),
		db
			.prepare(
				`UPDATE subscribers
					 SET status = CASE WHEN ? = 'approved' THEN 'approved' ELSE status END
					 WHERE id = (SELECT subscriber_id FROM approvals WHERE id = ?)`,
			)
			.bind(decision, approvalId),
	]);
}

export async function listFeedSubscriptions(
	db: D1Database,
	subscriberId: string,
): Promise<FeedSubscription[]> {
	const result = await db
		.prepare(
			`SELECT id, subscriber_id, channel, target, secret_hash, shard_id, stream_kid, status,
								created_at, revoked_at
				 FROM feed_subscriptions
				 WHERE subscriber_id = ? AND status = 'active'
				 ORDER BY created_at DESC`,
		)
		.bind(subscriberId)
		.all<FeedSubscription>();
	return result.results ?? [];
}

export async function createFeedSubscription(
	db: D1Database,
	row: Omit<FeedSubscription, "id" | "created_at" | "revoked_at"> & { created_at?: number },
): Promise<number> {
	const created_at = row.created_at ?? Math.floor(Date.now() / 1000);
	const res = await db
		.prepare(
			`INSERT INTO feed_subscriptions
					(subscriber_id, channel, target, secret_hash, shard_id, stream_kid, status, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			row.subscriber_id,
			row.channel,
			row.target,
			row.secret_hash,
			row.shard_id,
			row.stream_kid,
			row.status,
			created_at,
		)
		.first<{ id: number }>();
	return res!.id;
}

export async function revokeFeedSubscription(
	db: D1Database,
	id: number,
	subscriberId: string,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const res = await db
		.prepare(
			"UPDATE feed_subscriptions SET status = 'suspended', revoked_at = ? WHERE id = ? AND subscriber_id = ?",
		)
		.bind(now, id, subscriberId)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export async function audit(
	db: D1Database,
	actor: string,
	action: string,
	target: string,
	payload: Record<string, unknown> | null = null,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO audit_log (actor, action, target, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(
			actor,
			action,
			target,
			payload ? JSON.stringify(payload) : null,
			Math.floor(Date.now() / 1000),
		)
		.run();
}
