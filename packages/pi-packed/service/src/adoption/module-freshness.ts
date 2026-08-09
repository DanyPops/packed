/**
 * module-freshness.ts — turns a recurring diagnosis-by-intuition ("this
 * looks like Bun/Node holding a cached copy of an old build across a live
 * process") into a real, checkable signal.
 *
 * A long-running process (the packed daemon) loads its own dependencies
 * once via static imports at startup; Node/Bun's module cache then holds
 * that exact in-memory copy for the rest of the process's life, regardless
 * of whatever a later `pkg_update`/`npm install` writes to the same files
 * on disk -- only a restart picks up the new code. Detecting that gap
 * needs one snapshot taken at process start (captureLoadedModule, reusing
 * smoke.ts's own real module-resolution helper, never executing anything)
 * and a later re-read of the exact same on-disk path (checkModuleFreshness)
 * -- if the file's mtime moved since the snapshot, the running process is
 * provably still holding stale code in memory.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveDependencyModulesDir } from "./smoke.ts";

export interface LoadedModuleSnapshot {
	readonly name: string;
	readonly packageJsonPath: string;
	readonly version?: string;
	readonly mtimeMs?: number;
}

export interface ModuleFreshnessDiagnostic {
	readonly name: string;
	readonly loadedVersion?: string;
	readonly currentVersion?: string;
	/** True only when both mtimes are known and genuinely differ -- never a
	 * guess from version alone (a version string can stay identical across
	 * a same-version reinstall that still replaced the file, and not every
	 * package bumps a version for a local/dev iteration). */
	readonly stale: boolean;
}

function readVersionAndMtime(packageJsonPath: string): { version?: string; mtimeMs?: number } {
	try {
		const mtimeMs = statSync(packageJsonPath).mtimeMs;
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
		return { version: typeof pkg.version === "string" ? pkg.version : undefined, mtimeMs };
	} catch {
		return {};
	}
}

/**
 * Resolves `name`'s real installed package.json via Node's own module
 * resolution (see smoke.ts's resolveDependencyModulesDir -- correct for
 * both a nested and a hoisted layout, never executes anything) starting
 * from `fromDir`, then records its version/mtime. undefined when `name`
 * isn't resolvable from here at all -- never thrown, so one unresolvable
 * watched name never prevents capturing the rest.
 */
export function captureLoadedModule(fromDir: string, name: string): LoadedModuleSnapshot | undefined {
	const dir = resolveDependencyModulesDir(fromDir, name);
	if (!dir) return undefined;
	const packageJsonPath = join(dir, "package.json");
	return { name, packageJsonPath, ...readVersionAndMtime(packageJsonPath) };
}

/** Bulk capture, skipping (not failing on) any name that isn't resolvable. */
export function captureLoadedModules(fromDir: string, names: readonly string[]): LoadedModuleSnapshot[] {
	const snapshots: LoadedModuleSnapshot[] = [];
	for (const name of names) {
		const snapshot = captureLoadedModule(fromDir, name);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

export function checkModuleFreshness(snapshot: LoadedModuleSnapshot): ModuleFreshnessDiagnostic {
	const current = readVersionAndMtime(snapshot.packageJsonPath);
	const stale = snapshot.mtimeMs !== undefined && current.mtimeMs !== undefined && current.mtimeMs !== snapshot.mtimeMs;
	return { name: snapshot.name, loadedVersion: snapshot.version, currentVersion: current.version, stale };
}

export function checkModuleFreshnessAll(snapshots: readonly LoadedModuleSnapshot[]): ModuleFreshnessDiagnostic[] {
	return snapshots.map(checkModuleFreshness);
}

/** The exact set of names worth watching for a long-running process: its
 * own direct runtime dependencies (package.json's "dependencies" field) --
 * the ones a static top-level import actually loads once at process start.
 * devDependencies/peerDependencies are never loaded by the running process
 * itself, so watching them would only ever report false staleness. Bounded
 * the same way readPackageDeclarations elsewhere in this codebase bounds
 * an untrusted-shape read -- never throws on a malformed package.json,
 * just reports nothing to watch. */
export function ownRuntimeDependencyNames(packageJsonPath: string, maxNames = 200): string[] {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { dependencies?: unknown };
		if (typeof pkg.dependencies !== "object" || pkg.dependencies === null) return [];
		return Object.keys(pkg.dependencies).slice(0, maxNames);
	} catch {
		return [];
	}
}
