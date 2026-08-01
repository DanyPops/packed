/**
 * build-index.ts — batch-generates a versioned snapshot across the whole
 * local catalog (the createrepo/dpkg-scanpackages analog). Incremental:
 * a package new to the catalog or whose npm date has advanced since it
 * was last scored gets a real assessRegistryAdoption() call; a package
 * whose catalog date hasn't moved is carried forward from the prior index
 * untouched, at zero live-call cost. Local generation only -- publishing
 * this file somewhere public is a separate, later decision.
 *
 * Deliberately never calls GitHub: assessRegistryAdoption()'s freshness
 * dimension only takes the git-commit-based path when a caller passes it
 * a candidateCommitAt, and this file never does. Computing that path (a
 * GitHub Commits API call) for every cataloged package would blow through
 * the unauthenticated 60 req/hour limit commit-freshness.ts's own
 * single-attempt design was built around -- bulk generation instead
 * always falls back to the npm publish-date proxy, by construction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AdoptionReport, assessRegistryAdoption, PI_COMMAND_NAME } from "../adoption/score.ts";
import { catalogList, dbPath, openDb } from "../packages/db.ts";
import { resolveCurrentPiVersion } from "../pi/pi-version.ts";
import { writeJsonAtomic } from "../shared/atomic-json.ts";
import { INDEX_FILE, PAGE_DELAY_MS } from "../shared/constants.ts";
import { createLogger } from "../shared/log.ts";
import type { Registry } from "../shared/ports.ts";

const log = createLogger("index");

export interface PackageIndexEntry {
	name: string;
	version: string;
	dimensions: AdoptionReport["dimensions"];
	/** The catalog's own npm date this entry was scored against -- the
	 * per-package staleness watermark the next run compares its current
	 * catalog date to. Undefined when the catalog had no date for this
	 * package at scoring time (rare; treated as "unknown, always rescore"
	 * by the next run rather than assumed unchanged). A single global
	 * generatedAt watermark would be wrong here: packages enter the catalog
	 * and get scored at different times, so staleness must be per-package. */
	date?: string;
}

export interface PackageIndex {
	generatedAt: string;
	packages: PackageIndexEntry[];
	/** True when the local catalog held more entries than maxPackages --
	 * confirmed live against this project's own real catalog (5,250
	 * keywords:pi-package matches, overwhelmingly false positives from the
	 * search itself, a separate known issue): an unbounded run hit npm's
	 * downloads API 149 times with 429s in under three minutes and would
	 * have run for hours. Never silently incomplete -- always stated. */
	truncated: boolean;
}

/** Confirmed live this needs to stay small: even with downloads() removed,
 * 500 packages against a real npm registry took long enough that two
 * overlapping runs (the daemon's own maintenance-task tick and an
 * on-demand CLI build) compounded into a shutdown the daemon's own
 * SIGTERM grace period couldn't outlast, forcing a SIGABRT/coredump.
 * Small and bounded beats generous here. */
const DEFAULT_MAX_PACKAGES = 50;

// Guards against the exact failure just described: the daemon's scheduled
// maintenance tick and an on-demand `packed index build` both call into
// this module inside the same process. Without this, both would run a
// full generation concurrently against the same npm endpoints, doubling
// load and compounding retry backoff. A concurrent caller gets the
// in-flight run's own result instead of starting a second one.
let inFlight: Promise<PackageIndex> | undefined;

export interface IndexStatus {
	stale: boolean;
	generatedAt?: string;
	packageCount?: number;
	truncated?: boolean;
}

export interface BuildIndexOptions {
	/** Politeness pause between per-package registry calls -- same role as
	 * catalog.ts's PAGE_DELAY_MS. */
	delayMs?: number;
	currentPiVersion?: () => Promise<string | undefined>;
	/** Explicit bound on how many cataloged packages one generation run will
	 * process -- defaults to DEFAULT_MAX_PACKAGES. A run never silently
	 * processes an unbounded catalog. */
	maxPackages?: number;
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
 *
 * Deliberately never calls reg.downloads(): confirmed live against this
 * project's own real catalog (5,250 entries, overwhelmingly false
 * positives from the keywords:pi-package search itself, a separate known
 * issue) that calling it per package hits npm's downloads API 429s within
 * minutes -- two extra requests per package on top of info(). traction
 * stays "unknown" for every bulk-generated entry, which is already the
 * dimension's own honest fallback for missing download data, not a new
 * failure mode.
 */
export function buildIndex(reg: Registry, catalogDir: string, options: BuildIndexOptions = {}): Promise<PackageIndex> {
	if (inFlight) return inFlight;
	const run = buildIndexNow(reg, catalogDir, options).finally(() => {
		inFlight = undefined;
	});
	inFlight = run;
	return run;
}

/**
 * Partitions the current catalog against the prior index (when one exists)
 * into three groups -- New (never scored before), Changed (scored before,
 * but the catalog's date for it has advanced since), and Unchanged (scored
 * before, same date). Identity (name presence) decides New vs. known;
 * date decides Changed vs. Unchanged among known packages -- these are
 * deliberately different questions (see this module's own research Doc):
 * a package can be old on npm but new to *our* catalog, so date alone
 * can never answer "have we scored this before."
 */
function partitionAgainstPriorIndex(
	catalogPkgs: Array<{ name: string; date?: string }>,
	priorByName: Map<string, PackageIndexEntry>,
): { toScore: string[]; unchanged: PackageIndexEntry[] } {
	const toScore: string[] = [];
	const unchanged: PackageIndexEntry[] = [];
	for (const pkg of catalogPkgs) {
		const prior = priorByName.get(pkg.name);
		if (!prior) {
			toScore.push(pkg.name);
			continue;
		} // New
		// Can't prove nothing changed without both dates -- rescore rather
		// than assume, matching this codebase's "never guess" convention.
		if (pkg.date === undefined || prior.date === undefined) {
			toScore.push(pkg.name);
			continue;
		}
		if (Date.parse(pkg.date) > Date.parse(prior.date)) {
			toScore.push(pkg.name);
			continue;
		} // Changed
		unchanged.push(prior); // Unchanged -- carried forward verbatim, zero live calls
	}
	return { toScore, unchanged };
}

async function buildIndexNow(reg: Registry, catalogDir: string, options: BuildIndexOptions): Promise<PackageIndex> {
	const delayMs = options.delayMs ?? PAGE_DELAY_MS;
	const currentPiVersion = options.currentPiVersion ?? resolveCurrentPiVersion;
	const maxPackages = options.maxPackages ?? DEFAULT_MAX_PACKAGES;

	const db = openDb(dbPath(catalogDir));
	let catalogPkgs: Array<{ name: string; date?: string }>;
	try {
		catalogPkgs = catalogList(db).map((p) => ({ name: p.name, date: p.date }));
	} finally {
		db.close();
	}

	const priorIndex = readIndex(indexPath(catalogDir));
	const priorByName = new Map((priorIndex?.packages ?? []).map((entry) => [entry.name, entry]));
	const { toScore, unchanged } = partitionAgainstPriorIndex(catalogPkgs, priorByName);
	const catalogDateByName = new Map(catalogPkgs.map((p) => [p.name, p.date]));

	// The bound applies to the live-call queue specifically, not the whole
	// catalog -- Unchanged carry-forwards are cheap local copies and were
	// never the resource this cap exists to protect.
	const truncated = toScore.length > maxPackages;
	const names = toScore.slice(0, maxPackages);
	if (truncated) log.warn("new/changed queue exceeds maxPackages, truncating this run", { queueSize: toScore.length, maxPackages });

	// Skip both lookups entirely when nothing needs live scoring this run --
	// an all-Unchanged catalog should make zero network calls, not one.
	let piVersion: string | undefined;
	let piModified: string | undefined;
	if (names.length > 0) {
		piVersion = await currentPiVersion();
		if (reg.modifiedAt) {
			try {
				piModified = await reg.modifiedAt(PI_COMMAND_NAME);
			} catch {
				/* freshness stays explicitly unknown for every entry */
			}
		}
	}

	const scored: PackageIndexEntry[] = [];
	for (const name of names) {
		try {
			const info = await reg.info(name);
			if (reg.modifiedAt) {
				try {
					info.modified = await reg.modifiedAt(name);
				} catch {
					/* freshness proxy stays explicitly unknown */
				}
			}
			// No candidateCommitAt argument here -- GitHub is never touched
			// during bulk generation, by construction, not by omission.
			const report = assessRegistryAdoption(info, piVersion, piModified);
			scored.push({ name: info.name, version: info.version, dimensions: report.dimensions, date: catalogDateByName.get(name) });
		} catch (e) {
			log.warn("index entry failed, skipping", { name, error: e instanceof Error ? e.message : String(e) });
		}
		if (delayMs > 0) await Bun.sleep(delayMs);
	}
	return { generatedAt: new Date().toISOString(), packages: [...unchanged, ...scored], truncated };
}

/** Atomic write -- tmp file + rename, same partial-write-safety convention
 * as security.ts's writeSecuritySettings. */
export async function writeIndex(path: string, index: PackageIndex): Promise<void> {
	await writeJsonAtomic(path, index, { trailingNewline: false });
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
		truncated: index.truncated,
	};
}

/** Build + write in one call -- the maintenance-task/CLI entry point. */
export async function generateIndex(
	reg: Registry,
	catalogDir: string,
	path: string,
	options: BuildIndexOptions = {},
): Promise<PackageIndex> {
	const index = await buildIndex(reg, catalogDir, options);
	await writeIndex(path, index);
	return index;
}
