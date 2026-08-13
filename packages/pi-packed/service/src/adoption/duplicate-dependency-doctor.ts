/**
 * duplicate-dependency-doctor.ts — walks piHome's npm/node_modules tree
 * (every top-level @danypops/<name>, plus one level of nesting -- the same
 * shadow-copy shape findShadowCopies walks for one named package) and
 * reports any @danypops/<name> resolved to more than one distinct version
 * at once. Generalizes a bug class that recurred four times in one
 * session (pi-web-spider, pi-tickets, pi-papyrus/jittor, pi-packed itself):
 * a stale dependency floor forces a private nested copy instead of
 * deduping to the shared hoisted one.
 *
 * Informational only, not part of DoctorReport's own `ok` -- a duplicate
 * version isn't always a bug (an incompatible major range from a third
 * party can coexist safely), so failing the whole report on every one
 * would make a real, actionable case easy to tune out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DuplicateDependencyLocation {
	readonly path: string;
	readonly version: string;
}

export interface DuplicateDependencyDiagnostic {
	readonly name: string;
	readonly locations: readonly DuplicateDependencyLocation[];
}

/** Matches this file's own scan bound -- a tree-wide sweep never processes an unbounded package list. */
const MAX_PACKAGES_SCANNED = 2_000;

interface FoundPackage {
	readonly name: string;
	readonly version: string;
	readonly path: string;
}

function readNameAndVersion(packageJsonPath: string): { name?: string; version?: string } {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
		return {
			name: typeof pkg.name === "string" ? pkg.name : undefined,
			version: typeof pkg.version === "string" ? pkg.version : undefined,
		};
	} catch {
		return {};
	}
}

/** Every @danypops/<name> directory directly under nodeModulesDir -- never throws; a missing or
 * unreadable directory is just an empty result. */
function listDanypopsPackageDirs(nodeModulesDir: string): string[] {
	let scoped: string[];
	try {
		scoped = readdirSync(join(nodeModulesDir, "@danypops"));
	} catch {
		return [];
	}
	return scoped.map((name) => join(nodeModulesDir, "@danypops", name));
}

function scanInto(nodeModulesDir: string, budget: { remaining: number }, found: FoundPackage[]): void {
	for (const dir of listDanypopsPackageDirs(nodeModulesDir)) {
		if (budget.remaining <= 0) return;
		budget.remaining--;
		const { name, version } = readNameAndVersion(join(dir, "package.json"));
		if (name && version) found.push({ name, version, path: dir });
		// One level of nesting under THIS package's own node_modules -- the real, confirmed-live
		// shadow-copy shape a stale floor produces; never descends deeper (matches findShadowCopies'
		// own bound -- npm's own dedup is responsible for anything nested further than that).
		for (const nestedDir of listDanypopsPackageDirs(join(dir, "node_modules"))) {
			if (budget.remaining <= 0) return;
			budget.remaining--;
			const nested = readNameAndVersion(join(nestedDir, "package.json"));
			if (nested.name && nested.version) found.push({ name: nested.name, version: nested.version, path: nestedDir });
		}
	}
}

/**
 * Every @danypops/<name> resolved to more than one distinct version
 * anywhere under piHome/npm/node_modules -- sorted by name for stable
 * output. Two locations at the SAME version are never reported (npm simply
 * didn't need to hoist further, not a real split); only an actual version
 * disagreement is.
 */
export function findDuplicateDependencyVersions(piHome: string): DuplicateDependencyDiagnostic[] {
	const found: FoundPackage[] = [];
	scanInto(join(piHome, "npm", "node_modules"), { remaining: MAX_PACKAGES_SCANNED }, found);

	const byName = new Map<string, DuplicateDependencyLocation[]>();
	for (const pkg of found) {
		byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), { path: pkg.path, version: pkg.version }]);
	}

	const diagnostics: DuplicateDependencyDiagnostic[] = [];
	for (const [name, locations] of byName) {
		const distinctVersions = new Set(locations.map((location) => location.version));
		if (distinctVersions.size > 1) diagnostics.push({ name, locations });
	}
	diagnostics.sort((a, b) => a.name.localeCompare(b.name));
	return diagnostics;
}
