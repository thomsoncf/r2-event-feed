export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	SOURCE_BUCKET: R2Bucket;
	CF_API_TOKEN: string;
	CF_ACCOUNT_ID: string;
	STREAM_JWT_SECRET: string;
	WEBHOOK_SIGNING_SECRET: string;
	OPERATOR_ALLOWED_DOMAIN: string;
	SOURCE_BUCKET_NAME: string;
	FANOUT_BASE_URL: string;
}

export interface AccessUser {
	email: string;
	sub: string;
	identity_nonce?: string;
}

export interface DbUser {
	id: string;
	subscriber_id: string | null;
	email: string;
	role: "subscriber_user" | "operator_admin";
	created_at: number;
}

export interface Subscriber {
	id: string;
	name: string;
	contact_email: string;
	status: "pending" | "approved" | "suspended";
	created_at: number;
}

export interface FeedSubscription {
	id: number;
	subscriber_id: string;
	channel: "webhook" | "pull_queue" | "sse";
	target: string;
	secret_hash: string | null;
	shard_id: number | null;
	stream_kid: string | null;
	status: "active" | "suspended";
	created_at: number;
	revoked_at: number | null;
}

export type Variables = {
	user: DbUser;
};
