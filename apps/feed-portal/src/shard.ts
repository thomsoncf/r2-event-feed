/**
 * FNV-1a 32-bit hash. Deterministic, fast, no deps.
 * Used to deterministically map a subscriber to one of SHARD_COUNT broadcaster DOs.
 */
export const SHARD_COUNT = 4;

export function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return hash >>> 0;
}

export function pickShard(subscriberId: string): number {
	return fnv1a(subscriberId) % SHARD_COUNT;
}

export function shardName(shardId: number): string {
	return `broadcast-${shardId}`;
}
