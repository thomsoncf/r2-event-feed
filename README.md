# r2-event-feed

A self-service, multi-subscriber **pub/sub feed** built on top of [Cloudflare R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/).

Operators publish objects to a single R2 bucket. Subscribers receive every event over their preferred channel — **webhook**, **pull-queue**, or **SSE / WebSocket** — all delivered, retried and fanned out by Cloudflare Workers.

This repo is intentionally generic and reusable. There's no operator-specific code, schema, or naming anywhere.

> _This is free and unencumbered software released into the public domain. See [LICENSE](./LICENSE)._

---

## Architecture

```
  Operator                              Subscribers
  --------                              -----------

  upload                                Webhook receiver
    |                                          ^
    v                                          | HMAC POST
  +----+   event   +-------+   batch    +---------+
  | R2 | --------> | Queue | ---------> | Fanout  |
  +----+           +-------+            | Worker  |
                                        +---------+
                                          |     |
                                  enqueue |     | push
                                          v     v
                                   +--------+  +-------------+
                                   |  Pull  |  | Broadcaster |
                                   | queue  |  |  DOs (x4)   |
                                   +--------+  +-------------+
                                       |             |
                                       v             v
                                   Pull client   Topic-Based Subscription
                                                  SSE / WS Client


       Portal (control plane)
       ----------------------

   browser --> Cloudflare Access --> Portal Worker --> D1
                  (@cloudflare.com)         |
                                            v
                                    Cloudflare API
                                 (mint tokens, queues)
```

### What's in this repo

| Path | Purpose |
|---|---|
| `apps/feed-portal/` | Self-service portal Worker. Hono API, Astro UI, D1 layer, Cloudflare API client. |
| `apps/feed-fanout/` | Queue consumer Worker. Owns the broadcaster Durable Objects and the three delivery channels. |
| `demo/` | Seed SQL + sample object uploader so you can exercise the whole pipeline locally and in production. |
| `docs/architecture.md` | Deep dive: sharding, JWT design, D1-on-upgrade rationale, retry / DLQ semantics. |
| `docs/deploy.md` | Step-by-step deployment from a fresh Cloudflare account. |

### Delivery channels at a glance

| Channel | Best for | Auth | Backpressure |
|---|---|---|---|
| **Webhook** | Server-side receivers that already accept HTTPS posts. | HMAC-SHA256 over `body + timestamp`. Replay window enforced. | Fanout worker retries on 5xx; permanent failures go to DLQ. |
| **Pull queue** | Receivers that can't expose a public endpoint, or want to batch. | Queue-scoped pull token. | Native — subscriber pulls at their own rate. |
| **SSE / WebSocket** | Browsers, low-latency dashboards. | Long-lived JWT ("Stream Key"), revocable in D1. | Hibernatable DO + per-shard fan-out. |

### Subscriber model

- A **Subscriber** is a tenant: a row in the `subscribers` D1 table, approved by an operator.
- A subscriber can have multiple **Feed Subscriptions** (one per channel they care about).
- All subscribers see **every** event — there is no per-subscriber prefix scoping in MVP.
- All credentials are long-lived and **manually revocable**. Subscribers can rotate any time from the portal.

### Broadcaster shard pool

The fanout worker owns a fixed pool of **4 broadcaster Durable Objects** (named `broadcast-0` … `broadcast-3`).

- On subscription creation, each SSE/WS subscription is assigned a sticky shard via `hash(subscriber_id) % 4` (FNV-1a).
- The shard id is **persisted in D1** so reconnects always land on the same DO.
- Fanout uses `Promise.all` over the 4 shards per event — no single-DO bottleneck.
- Each DO uses [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) so idle connections cost nothing.

See [`docs/architecture.md`](./docs/architecture.md) for capacity numbers and the rationale.

---

## Quickstart

> Full instructions are in [`docs/deploy.md`](./docs/deploy.md). This is the short version.

### Prerequisites

- Node 22+ and pnpm 10+
- A Cloudflare account with Workers Paid plan (Durable Objects + Queues require it)
- `wrangler` is already a workspace devDependency — no separate install
- A Cloudflare API token with **all** of the scopes below. The most easily-missed
  one is **`Account API Tokens: Edit`** — the portal calls
  `POST /accounts/{id}/tokens` at runtime to mint bucket-scoped R2 read tokens
  for subscribers. Without it you get `Unauthorized to access requested resource`
  when a subscriber clicks **Mint R2 token**.

  | Scope                            | Why it's needed                                                                         |
  | -------------------------------- | --------------------------------------------------------------------------------------- |
  | `Account: Account Settings: Read`| Resolve the account itself (`/accounts/{id}` and basic introspection).                  |
  | `Account: Workers Scripts: Edit` | Deploy `feed-portal` and `feed-fanout`, upload secrets, run `wrangler deploy`.          |
  | `Account: Workers R2 Storage: Edit` | Create the source bucket and wire its event notifications to the queue.              |
  | `Account: Queues: Edit`          | Create the event queue + DLQ, and let the portal provision per-subscriber pull queues.  |
  | `Account: D1: Edit`              | Create the metadata DB and apply migrations.                                            |
  | `Account: Access: Edit`          | Create the Access self-hosted app + policy that protects the portal.                    |
  | **`Account: Account API Tokens: Edit`** | **Mint and revoke bucket-scoped R2 read tokens on behalf of subscribers (runtime).** |

  > Tip: in the Cloudflare dashboard, create a **Custom Token** under
  > [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) and
  > add each of the above as a separate permission line, scoped to the single
  > account that hosts this deploy.

### 1. Install

```bash
pnpm install
```

### 2. Create Cloudflare resources

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...

# R2 bucket that publishers write to
pnpm exec wrangler r2 bucket create r2-event-feed-source

# Event queue (R2 notifications → fanout)
pnpm exec wrangler queues create r2-event-feed-events

# D1 metadata database
pnpm exec wrangler d1 create r2-event-feed
# → copy the returned database_id into apps/feed-portal/wrangler.jsonc
# →                            and apps/feed-fanout/wrangler.jsonc

# Apply migrations
pnpm exec wrangler d1 migrations apply r2-event-feed --remote \
  --config apps/feed-portal/wrangler.jsonc

# Wire R2 → Queue notifications
pnpm exec wrangler r2 bucket notification create r2-event-feed-source \
  --queue r2-event-feed-events \
  --event-types object-create,object-delete
```

### 3. Deploy

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler deploy
pnpm --filter @r2-event-feed/feed-portal exec wrangler deploy
```

### 4. Protect the portal with Cloudflare Access

> **For production deployments, use a custom domain — not `*.workers.dev`.**
>
> The `workers.dev` subdomain is shared across the entire Cloudflare account
> and (more importantly) across **all** Cloudflare accounts. That means:
>
> - Cloudflare Access cookies on `*.workers.dev` share an etld+1 with every
>   other worker on that subdomain — session collisions are possible.
> - You can't apply zone-level controls (WAF, rate-limit rules) to a
>   `workers.dev` URL.
> - Branding: users see `r2-event-feed-portal.<random>.workers.dev` instead
>   of `portal.your-company.com`.
>
> For production, add a custom domain to the portal worker. In
> `apps/feed-portal/wrangler.jsonc`:
>
> ```jsonc
> "routes": [
>   { "pattern": "portal.your-company.com", "custom_domain": true }
> ]
> ```
>
> Then point the Access app's `domain` at `portal.your-company.com`. The
> `workers.dev` URL still works as a fallback during development.

Create a self-hosted Access app for the portal Worker's URL and apply a policy
requiring `emails_ending_in: cloudflare.com` (or whatever domain your
subscribers use). See [`docs/deploy.md`](./docs/deploy.md) for the API calls.

### 5. Try it

Upload a sample object:

```bash
pnpm exec wrangler r2 object put r2-event-feed-source/hello.txt \
  --file=./demo/samples/hello.txt --remote
```

Within a couple of seconds the event flows through the queue, hits the fanout worker, and is delivered to every subscribed webhook / pull-queue / WS client. Tail the logs:

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler tail
```

---

## Development

```bash
pnpm dev              # turbo runs both workers + the Astro frontend
pnpm lint             # biome check
pnpm check-types      # tsc --noEmit per app
pnpm test             # vitest
```

## Layout

```
r2-event-feed/
├── apps/
│   ├── feed-portal/         # Hono API + Astro frontend
│   │   ├── src/             # Worker source
│   │   ├── frontend/        # Astro pages
│   │   └── migrations/      # D1 schema
│   └── feed-fanout/         # Queue consumer + broadcaster DOs
│       └── src/
├── demo/                    # Seed data + sample uploader
├── docs/
│   ├── architecture.md
│   └── deploy.md
└── (root config)
```

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). The project is in the public domain (Unlicense); by contributing you agree your contributions are too.
