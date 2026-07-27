/**
 * catalog.ts — the sync pipeline (apt update / pkg update analog).
 * Paginates the upstream registry into the local SQLite mirror and records
 * sync metadata (the Release/repomd checksum role) in sync_meta.
 */
import type { Pkg, Registry } from "./ports.ts";
import { PI_PACKAGE_KEYWORD } from "./constants.ts";
import { openDb, replaceAll, getSyncMeta, dbPath } from "./db.ts";
import { createLogger } from "./log.ts";

const log = createLogger("catalog");
import type { SyncMeta } from "./db.ts";

export interface CatalogStatus {
	stale: boolean;
	meta?: SyncMeta;
}

export function catalogStatus(dir: string, ttlMs: number): CatalogStatus {
	const db = openDb(dbPath(dir));
	try {
		const meta = getSyncMeta(db);
		if (!meta) return { stale: true };
		return { stale: Date.now() - Date.parse(meta.fetchedAt) > ttlMs, meta };
	} finally {
		db.close();
	}
}

/** Full mirror sync: upstream pages → atomic SQLite replace. */
export async function syncCatalog(reg: Registry, dir: string, query: string = PI_PACKAGE_KEYWORD): Promise<number> {
	const t0 = Date.now();
	log.info("mirror sync started", { query });
	const packages = await reg.searchAll(query);
	const db = openDb(dbPath(dir));
	try {
		replaceAll(db, packages, "npm:" + query);
		log.info("mirror sync complete", { packages: packages.length, ms: Date.now() - t0 });
		return packages.length;
	} finally {
		db.close();
	}
}

export function startCatalogSync(
	reg: Registry,
	dir: string,
	ttlMs: number,
	onError?: (e: unknown) => void,
): () => void {
	async function sync(): Promise<void> {
		try {
			if (catalogStatus(dir, ttlMs).stale) {
				const n = await syncCatalog(reg, dir);
				log.info("scheduled sync complete", { packages: n });
			}
		} catch (e) {
			onError?.(e);
		}
	}
	void sync();
	const timer = setInterval(() => void sync(), ttlMs);
	return () => clearInterval(timer);
}
