#!/usr/bin/env node
/**
 * Walk demo/samples/ and PUT each file into the source R2 bucket via wrangler.
 * Requires: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars.
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BUCKET = process.env.SOURCE_BUCKET_NAME ?? "r2-event-feed-source";
const SAMPLES = join(import.meta.dirname ?? ".", "samples");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

function main() {
	let files: string[] = [];
	try {
		files = walk(SAMPLES);
	} catch {
		console.error(`No samples/ dir at ${SAMPLES}. Create one with a few files.`);
		process.exit(1);
	}
	if (files.length === 0) {
		console.error("No sample files found.");
		process.exit(1);
	}

	for (const file of files) {
		const key = relative(SAMPLES, file).replace(/\\/g, "/");
		console.log(`PUT ${BUCKET}/${key}`);
		execSync(`pnpm exec wrangler r2 object put "${BUCKET}/${key}" --file="${file}" --remote`, {
			stdio: "inherit",
		});
	}

	console.log(`\nUploaded ${files.length} object(s). Tail the fanout worker to see deliveries.`);
}

main();
