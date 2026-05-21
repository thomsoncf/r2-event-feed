# Architecture

A more detailed companion to the [top-level README](../README.md). Numbers below assume Cloudflare's documented Workers/DO limits as of 2026.

## Goals

1. **Self-service.** Subscribers enroll themselves and receive a working delivery configuration without operator hand-holding.
2. **One pipeline, three transports.** Operators publish once; subscribers choose webhook, pull queue, or push stream.
3. **Cheap at idle, cheap at peak.** No always-on machines. Hibernatable WS, queue-based fan-out, DO sharding.
4. **Public-domain reusable.** Nothing operator-specific.

## Data plane

```
Publisher  ──PUT──►  R2 bucket  ──event──►  Queue  ──consume──►  feed-fanout
                                                                      │
                          ┌───────────────────────────────────────────┼───────────────────────────┐
                          │                                           │                           │
                          ▼                                           ▼                           ▼
                  Webhook delivery                            Pull-queue delivery         Broadcaster DOs (×4)
                  (HMAC POST + retry + DLQ)                   (enqueue → subscriber pulls) (Hibernatable WS / SSE)
```

### Fanout batching

`wrangler.jsonc` configures the queue consumer with:

| Setting | Value | Rationale |
|---|---|---|
| `max_batch_size` | 25 | Big enough to amortise per-invocation startup, small enough that one slow webhook doesn't starve the rest. |
| `max_batch_timeout` | 2s | Sets the worst-case end-to-end latency floor for SSE/WS. |
| `max_retries` | 3 | After 3, message goes to DLQ. |
| `dead_letter_queue` | `r2-event-feed-events-dlq` | Operator monitors via dashboard or tail. |

### Per-message fan-out

For each message in a batch:

1. Look up active subscriptions in D1 (cached in-Worker per batch).
2. Group by channel.
3. Per channel:
   - **Webhook:** sign body with HMAC-SHA256, POST with `X-Feed-Signature`, `X-Feed-Timestamp`, `X-Feed-Event-Id`. Retry 5xx via Cloudflare Queues backoff.
   - **Pull queue:** `env.PER_SUB_QUEUE.send(payload)` to the subscriber's dedicated queue.
   - **Broadcaster:** group subscriptions by their persisted `shard_id`, then `Promise.all` over each distinct shard's `stub.broadcast(payload)`.

## Sharding

The broadcaster is **not** a singleton. There's a fixed pool of `SHARD_COUNT = 4` Durable Objects, named `broadcast-0`…`broadcast-3`.

| Concern | Choice |
|---|---|
| Pool size | 4 (covers peak ~22 ev/s with ~1000× headroom) |
| Assignment | `hash(subscriber_id) % 4` using FNV-1a, persisted in D1 |
| Stickiness | Reconnects land on the same shard because the JWT carries `shard_id` |
| Resizing | Manual; not in MVP |

### Why not a singleton

A single DO can sustain ~1000 simple req/s, ~500-750 req/s for JSON workloads, less with storage IO. Even though peak load (~22 ev/s × 100 connected clients = ~2200 ws.send/s) is well within a single DO, splitting into 4 gives:

- Independent failure domains
- Independent CPU budgets (no head-of-line blocking)
- Room to grow without re-keying clients

### Why not random / round-robin

Stickiness lets us cache subscriber metadata in DO memory, and gives reconnecting clients a deterministic home. Re-balancing across all 4 shards on every event is unnecessary overhead.

## Control plane (portal)

The portal Worker is a Hono app behind Cloudflare Access. It:

- Renders the Astro UI (`/`, `/tokens`, `/feed`, `/admin/approvals`)
- Owns all writes to D1
- Calls the Cloudflare API to mint / revoke R2 tokens
- Calls the Cloudflare API to create per-subscriber pull queues on demand
- Mints "Stream Keys" — JWTs used by SSE/WS clients

The portal never sees real-time events. The fanout Worker never sees a logged-in user. The only thing they share is D1.

## Stream Key design

When a subscriber creates an SSE/WS subscription, the portal:

1. Generates a random `kid` (key id).
2. Generates a random signing secret.
3. Stores `(kid, subscription_id)` in D1.
4. Returns a JWT to the user **once** — never again:

```json
{
  "kid": "fk_a8c…",
  "subscriber_id": "sub_abc",
  "subscription_id": 42,
  "shard_id": 1,
  "iat": 1717000000
}
```

Notes:

- **No `exp`.** Long-lived. Revoke via the portal.
- **No refresh.** Just rotate and replace.
- Signed with HS256 using a per-Worker secret.

### Connect-time validation

On every WS/SSE upgrade, the fanout Worker:

1. Verifies the JWT signature in-Worker.
2. **Reads D1** to check the `kid` is still active and not revoked.
3. If revoked → 401, close the socket.

We chose D1-on-upgrade over a KV bloom filter or in-memory cache because:

- The hot path is the persistent connection, not the upgrade.
- D1 latency on upgrade is acceptable; revocation must be immediate.
- KV's eventual consistency would surprise operators.

## Failure modes

| Failure | Behaviour |
|---|---|
| Subscriber webhook 5xx | Queue retries with backoff; after `max_retries` → DLQ. |
| Subscriber webhook 4xx | Treated as terminal — message dropped, subscriber notified via audit log. |
| Subscriber pull queue full | Cloudflare Queues applies its own backpressure. |
| Broadcaster DO crash | Hibernatable WS clients auto-reconnect; SSE clients reconnect on read error. |
| D1 outage | Portal writes fail loudly; fanout's batched lookups fail → batch retried. |
| Cloudflare API outage | Portal control-plane ops (mint token, create queue) fail loudly; data plane unaffected. |

## What's deliberately out of scope (MVP)

- Per-shard alerting / paging
- Backfill / replay
- Subscriber-facing usage dashboards
- Per-event prefix scoping (e.g. "I only want `/folder/*`")
- Short-lived / auto-rotating R2 tokens
- SAML / OIDC federation
- IP allowlists
- Multi-region active/active

All of these are real features — just not v1.
