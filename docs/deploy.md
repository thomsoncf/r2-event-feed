# Deployment

End-to-end deployment from a fresh Cloudflare account. About 15 minutes including waiting for things.

## 0. Prerequisites

- Cloudflare account with Workers Paid plan
- `node >= 22`, `pnpm >= 10`
- Cloudflare API token with these scopes:
  - `Account → Workers Scripts: Edit`
  - `Account → Workers R2 Storage: Edit`
  - `Account → Workers KV Storage: Edit` (only if you enable KV-based caching)
  - `Account → Queues: Edit`
  - `Account → D1: Edit`
  - `Account → Access: Edit`
  - `User → Memberships: Read`
  - `User → User Details: Read`

Set both:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

## 1. Install deps

```bash
pnpm install
```

## 2. Create the R2 bucket

```bash
pnpm exec wrangler r2 bucket create r2-event-feed-source
```

## 3. Create the event queue + DLQ

```bash
pnpm exec wrangler queues create r2-event-feed-events
pnpm exec wrangler queues create r2-event-feed-events-dlq
```

## 4. Create the D1 database and apply migrations

```bash
pnpm exec wrangler d1 create r2-event-feed
```

Copy the returned `database_id` into **both** `apps/feed-portal/wrangler.jsonc` and `apps/feed-fanout/wrangler.jsonc` (look for `"<D1_DATABASE_ID>"`).

```bash
pnpm exec wrangler d1 migrations apply r2-event-feed --remote \
  --config apps/feed-portal/wrangler.jsonc
```

## 5. Wire R2 → Queue event notifications

```bash
pnpm exec wrangler r2 bucket notification create r2-event-feed-source \
  --queue r2-event-feed-events \
  --event-types object-create,object-delete
```

## 6. Set secrets

Both workers need a few secrets. Set them via `wrangler secret put` (interactive) or pipe in:

```bash
# feed-portal: needs Cloudflare API token to mint R2 tokens / create per-sub queues
pnpm --filter @r2-event-feed/feed-portal exec wrangler secret put CF_API_TOKEN
pnpm --filter @r2-event-feed/feed-portal exec wrangler secret put STREAM_JWT_SECRET
pnpm --filter @r2-event-feed/feed-portal exec wrangler secret put WEBHOOK_SIGNING_SECRET

# feed-fanout: needs the same STREAM_JWT_SECRET (to verify) and WEBHOOK_SIGNING_SECRET (to sign)
pnpm --filter @r2-event-feed/feed-fanout exec wrangler secret put STREAM_JWT_SECRET
pnpm --filter @r2-event-feed/feed-fanout exec wrangler secret put WEBHOOK_SIGNING_SECRET
```

Generate strong secrets with:

```bash
openssl rand -base64 48
```

## 7. Deploy the workers

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler deploy
pnpm --filter @r2-event-feed/feed-portal exec wrangler deploy
```

## 8. Protect the portal with Cloudflare Access

This requires Cloudflare Zero Trust to be set up on your account (free tier is fine).

```bash
# Create a self-hosted Access application for the portal
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "r2-event-feed Portal",
    "domain": "r2-event-feed-portal.<your-workers-subdomain>.workers.dev",
    "type": "self_hosted",
    "session_duration": "24h"
  }'
# → note the returned "id" as APP_ID

# Add an allow policy
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${APP_ID}/policies" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Allow @cloudflare.com",
    "decision": "allow",
    "include": [{ "email_domain": { "domain": "cloudflare.com" } }]
  }'
```

## 9. Verify

Upload a test object:

```bash
echo "hello" > /tmp/hello.txt
pnpm exec wrangler r2 object put r2-event-feed-source/hello.txt --file=/tmp/hello.txt
```

Tail the fanout worker:

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler tail
```

You should see a `processing batch of N` log line within ~2 seconds.

## 10. Onboard your first subscriber

Open the portal in a browser. Cloudflare Access prompts for email OTP. Once authenticated:

1. Click **Enroll** to create a Subscriber record (operator approves it from `/admin/approvals`).
2. From `/tokens`, mint an R2 read token (if the subscriber wants direct object reads) and create one or more subscriptions (webhook, pull queue, SSE).
3. Each secret/key is shown **once**. Save it.

## Rolling back

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler rollback
pnpm --filter @r2-event-feed/feed-portal exec wrangler rollback
```

D1 migrations are forward-only; if you need to downgrade schema, write a new migration that reverses the change.
