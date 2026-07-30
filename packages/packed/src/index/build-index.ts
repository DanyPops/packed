/**
 * build-index.ts — batch-generates a versioned snapshot across the whole
 * local catalog (the createrepo/dpkg-scanpackages analog): one
 * assessRegistryAdoption() call per cataloged package, written to a single
 * JSON file. Local generation only -- publishing this file somewhere
 * public is a separate, later decision.
 *
 * Deliberately never calls GitHub: assessRegistryAdoption()'s freshness
 * dimension only takes the git-commit-based path when a caller passes it
 * a candidateCommitAt, and this file never does. Computing that path (a
 * GitHub Commits API call) for every cataloged package would blow through
 * the unauthenticated 60 req/hour limit commit-freshness.ts's own
 * single-attempt design was built around -- bulk generation instead
 * always falls back to the npm publish-date proxy, by construction.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Registry } from "../shared/ports.ts";
import { assessRegistryAdoption, PI_COMMAND_NAME, type AdoptionReport } from "../adoption/score.ts";
import { resolveCurrentPiVersion } from "../pi/pi-version.ts";
import { openDb, catalogList, dbPath } from "../packages/db.ts";
import { INDEX_FILE, PAGE_DELAY_MS } from "../shared/constants.ts";
import { createLogger } from "../shared/log.ts";

const log = createLogger("index");

export interface PackageIndexEntry {
	name: string;
	version: string;
	dimensions: AdoptionReport["dimensions"];
}

export interface PackageIndex {
	generatedAt: string;
	packages: PackageIndexEntry[];
}

export interface IndexStatus {
	stale: boolean;
	generatedAt?: string;
	packageCount?: number;
}

export interface BuildIndexOptions {
	/** Politeness pause between per-package registry calls -- same role as
	 * catalog.ts's PAGE_DELAY_MS. */
	delayMs?: number;
	currentPiVersion?: () => Promise<string | undefined>;
}

/** Same per-directory-filename convention as db.ts's dbPath(). */
export function indexPath(dir: string): string {
	return join(dir, INDEX_FILE);
}

/**
 * One assessRegistryAdoption() call per cataloged package -- npm registry
 * data only, no GitHub. A single package failing its registry lookup
 * (removed, renamed, transient error) is skipped and logged rather than
 * failing the whole run.
 */
export async function buildIndex(reg: Registry, catalogDir: string, options: BuildIndexOptions = {}): Promise<PackageIndex> {
	const delayMs = options.delayMs ?? PAGE_DELAY_MS;
	const currentPiVersion = options.currentPiVersion ?? resolveCurrentPiVersion;

	const db = openDb(dbPath(catalogDir));
	let names: string[];
	try {
		names = catalogList(db).map((p) => p.name);
	} finally {
		db.close();
	}

	const piVersion = await currentPiVersion();
	let piModified: string | undefined;
	if (reg.modifiedAt) {
		try { piModified = await reg.modifiedAt(PI_COMMAND_NAME); } catch { /* freshness stays explicitly unknown for every entry */ }
	}

	const packages: PackageIndexEntry[] = [];
	for (const name of names) {
		try {
			const info = await reg.info(name);
			if (reg.downloads) {
				try { info.downloads = await reg.downloads(name); } catch { /* traction stays explicitly unknown */ }
			}
			if (reg.modifiedAt) {
				try { info.modified = await reg.modifiedAt(name); } catch { /* freshness proxy stays explicitly unknown */ }
			}
			// No candidateCommitAt argument here -- GitHub is never touched
			// during bulk generation, by construction, not by omission.
			const report = assessRegistryAdoption(info, piVersion, piModified);
			packages.push({ name: info.name, version: info.version, dimensions: report.dimensions });
		} catch (e) {
			log.warn("index entry failed, skipping", { name, error: e instanceof Error ? e.message : String(e) });
		}
		if (delayMs > 0) await Bun.sleep(delayMs);
	}
	return { generatedAt: new Date().toISOString(), packages };
}

/** Atomic write -- tmp file + rename, same partial-write-safety convention
 * as security.ts's writeSecuritySettings. */
export function writeIndex(path: string, index: PackageIndex): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(index));
	renameSync(temporary, path);
}

export function readIndex(path: string): PackageIndex | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PackageIndex>;
		if (typeof parsed.generatedAt === "string" && Array.isArray(parsed.packages)) return parsed as PackageIndex;
		return undefined;
	} catch {
		return undefined;
	}
}

export function indexStatus(path: string, ttlMs: number): IndexStatus {
	const index = readIndex(path);
	if (!index) return { stale: true };
	return {
		stale: Date.now() - Date.parse(index.generatedAt) > ttlMs,
		generatedAt: index.generatedAt,
		packageCount: index.packages.length,
	};
}

/** Build + write in one call -- the maintenance-task/CLI entry point. */
export async function generateIndex(reg: Registry, catalogDir: string, path: string, options: BuildIndexOptions = {}): Promise<PackageIndex> {
	const index = await buildIndex(reg, catalogDir, options);
	writeIndex(path, index);
	return index;
}
