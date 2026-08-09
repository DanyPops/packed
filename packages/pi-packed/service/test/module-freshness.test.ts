/**
 * module-freshness.test.ts — the "X is not a constructor" pattern this
 * exists to catch: a long-running process's in-memory copy of a dependency
 * going stale after an on-disk update, with the process itself none the
 * wiser until restarted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureLoadedModule,
	captureLoadedModules,
	checkModuleFreshness,
	checkModuleFreshnessAll,
	ownRuntimeDependencyNames,
} from "../src/adoption/module-freshness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function writeDependency(nodeModulesDir: string, name: string, version: string): string {
	const dir = join(nodeModulesDir, name);
	mkdirSync(dir, { recursive: true });
	const packageJsonPath = join(dir, "package.json");
	writeFileSync(packageJsonPath, JSON.stringify({ name, version }));
	return packageJsonPath;
}

function fromPackageDir(): string {
	const dir = track(mkdtempSync(join(tmpdir(), "packed-module-freshness-")));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
	return dir;
}

describe("captureLoadedModule / checkModuleFreshness", () => {
	it("reports not stale immediately after capture -- nothing has changed yet", () => {
		const fromDir = fromPackageDir();
		writeDependency(join(fromDir, "node_modules"), "watched-dep", "1.0.0");

		const snapshot = captureLoadedModule(fromDir, "watched-dep");
		expect(snapshot).toBeDefined();
		expect(snapshot!.version).toBe("1.0.0");

		const diagnostic = checkModuleFreshness(snapshot!);
		expect(diagnostic.stale).toBe(false);
		expect(diagnostic.loadedVersion).toBe("1.0.0");
		expect(diagnostic.currentVersion).toBe("1.0.0");
	});

	it("reports stale once the on-disk package.json is rewritten after the snapshot was taken -- the exact confirmed-live pattern", async () => {
		const fromDir = fromPackageDir();
		const packageJsonPath = writeDependency(join(fromDir, "node_modules"), "watched-dep", "1.0.0");
		const snapshot = captureLoadedModule(fromDir, "watched-dep")!;

		// Simulate a pkg_update landing a new build while this process (whose
		// own snapshot was already taken) keeps running -- rewrite the file
		// and force its mtime forward, since two writes in the same tick can
		// otherwise land on an indistinguishable mtime on a fast filesystem.
		writeFileSync(packageJsonPath, JSON.stringify({ name: "watched-dep", version: "2.0.0" }));
		const future = new Date(Date.now() + 5_000);
		utimesSync(packageJsonPath, future, future);

		const diagnostic = checkModuleFreshness(snapshot);
		expect(diagnostic.stale).toBe(true);
		expect(diagnostic.loadedVersion).toBe("1.0.0");
		expect(diagnostic.currentVersion).toBe("2.0.0");
	});

	it("never reports stale when either mtime is unknown -- never guesses from version alone", () => {
		const fromDir = fromPackageDir();
		const packageJsonPath = writeDependency(join(fromDir, "node_modules"), "watched-dep", "1.0.0");
		const snapshot = { name: "watched-dep", packageJsonPath, version: "1.0.0", mtimeMs: undefined };

		expect(checkModuleFreshness(snapshot).stale).toBe(false);
	});

	it("returns undefined (never throws) when the dependency isn't resolvable from here at all", () => {
		const fromDir = fromPackageDir();
		expect(captureLoadedModule(fromDir, "does-not-exist-anywhere")).toBeUndefined();
	});
});

describe("captureLoadedModules / checkModuleFreshnessAll -- bulk, one unresolvable name never blocks the rest", () => {
	it("captures every resolvable name and silently skips the rest", () => {
		const fromDir = fromPackageDir();
		writeDependency(join(fromDir, "node_modules"), "dep-a", "1.0.0");
		writeDependency(join(fromDir, "node_modules"), "dep-b", "2.0.0");

		const snapshots = captureLoadedModules(fromDir, ["dep-a", "dep-b", "dep-missing"]);

		expect(snapshots.map((s) => s.name)).toEqual(["dep-a", "dep-b"]);
	});

	it("checks every captured snapshot and reports which ones went stale", () => {
		const fromDir = fromPackageDir();
		const staleDepPath = writeDependency(join(fromDir, "node_modules"), "dep-a", "1.0.0");
		writeDependency(join(fromDir, "node_modules"), "dep-b", "2.0.0");
		const snapshots = captureLoadedModules(fromDir, ["dep-a", "dep-b"]);

		writeFileSync(staleDepPath, JSON.stringify({ name: "dep-a", version: "1.1.0" }));
		const future = new Date(Date.now() + 5_000);
		utimesSync(staleDepPath, future, future);

		const diagnostics = checkModuleFreshnessAll(snapshots);
		expect(diagnostics.find((d) => d.name === "dep-a")?.stale).toBe(true);
		expect(diagnostics.find((d) => d.name === "dep-b")?.stale).toBe(false);
	});
});

describe("ownRuntimeDependencyNames", () => {
	it("returns exactly the dependencies field's keys, never devDependencies/peerDependencies", () => {
		const dir = track(mkdtempSync(join(tmpdir(), "packed-module-freshness-pkg-")));
		const packageJsonPath = join(dir, "package.json");
		writeFileSync(
			packageJsonPath,
			JSON.stringify({
				name: "pkg",
				dependencies: { "runtime-a": "^1.0.0", "runtime-b": "^2.0.0" },
				devDependencies: { "dev-only": "^1.0.0" },
				peerDependencies: { "peer-only": "*" },
			}),
		);

		expect(ownRuntimeDependencyNames(packageJsonPath)).toEqual(["runtime-a", "runtime-b"]);
	});

	it("returns an empty array, never throws, for a missing or malformed package.json", () => {
		expect(ownRuntimeDependencyNames("/nonexistent/package.json")).toEqual([]);
	});

	it("returns an empty array when dependencies is absent", () => {
		const dir = track(mkdtempSync(join(tmpdir(), "packed-module-freshness-pkg-")));
		const packageJsonPath = join(dir, "package.json");
		writeFileSync(packageJsonPath, JSON.stringify({ name: "pkg" }));

		expect(ownRuntimeDependencyNames(packageJsonPath)).toEqual([]);
	});
});
