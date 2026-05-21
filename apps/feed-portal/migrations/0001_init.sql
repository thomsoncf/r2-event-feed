-- 0001_init.sql
-- Initial schema for r2-event-feed.

PRAGMA foreign_keys = ON;

CREATE TABLE subscribers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'suspended')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  subscriber_id TEXT,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('subscriber_user', 'operator_admin')),
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_subscriber ON users(subscriber_id);

CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by    TEXT,
  decided_at    INTEGER,
  note          TEXT,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id),
  FOREIGN KEY (requested_by) REFERENCES users(id)
);

CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE feed_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('webhook', 'pull_queue', 'sse')),
  target        TEXT NOT NULL,
  secret_hash   TEXT,
  shard_id      INTEGER,
  stream_kid    TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
);

CREATE INDEX idx_feedsub_subscriber ON feed_subscriptions(subscriber_id);
CREATE INDEX idx_feedsub_status_channel ON feed_subscriptions(status, channel);
CREATE UNIQUE INDEX idx_feedsub_kid ON feed_subscriptions(stream_kid)
  WHERE stream_kid IS NOT NULL;

CREATE TABLE r2_tokens (
  id            TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  label         TEXT,
  scope         TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_r2tokens_subscriber ON r2_tokens(subscriber_id);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor);
