# Demo

End-to-end exercise of the pipeline.

## 1. Seed two subscribers

These pre-populate the D1 database so you can skip the approval flow.

```bash
pnpm exec wrangler d1 execute r2-event-feed \
  --remote \
  --config ../apps/feed-portal/wrangler.jsonc \
  --file ./seed-subscribers.sql
```

## 2. Upload sample objects

The script reads `samples/` and PUTs each file into the source bucket via wrangler.

```bash
pnpm exec tsx ./upload-sample-objects.ts
```

Each upload triggers an R2 event notification → queue → fanout → all active subscriptions.

## 3. Watch deliveries land

In separate terminals:

```bash
pnpm --filter @r2-event-feed/feed-fanout exec wrangler tail
```

```bash
# If you have an SSE subscription set up, open /feed/ in the portal and paste your Stream Key.
```
