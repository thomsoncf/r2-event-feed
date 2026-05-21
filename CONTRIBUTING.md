# Contributing

Thanks for your interest! This project is in the public domain (Unlicense). By contributing, you agree your contribution is too.

## Ground rules

- **Generic.** Don't add operator-specific naming, schemas, or examples. The whole point is reusability.
- **Cloudflare-only.** No code paths that depend on AWS, GCP, or self-hosted infra in the runtime hot path.
- **Conventional commits** preferred (`feat:`, `fix:`, `docs:`…) but not strictly enforced.
- **Run the suite before pushing:**
  ```bash
  pnpm lint
  pnpm check-types
  pnpm test
  pnpm build
  ```

## Local dev

```bash
pnpm install
pnpm dev
```

Each app has its own `wrangler.jsonc` and `.dev.vars.example`. Copy the latter to `.dev.vars` and fill in.

## Architecture changes

If you're changing the broadcaster shard count, queue batching, JWT shape, or revocation strategy, update `docs/architecture.md` in the same PR.

## Reporting issues

Open a GitHub issue with a reproducer. Cloudflare account IDs, API tokens, and customer-identifying info should be redacted.
