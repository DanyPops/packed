/**
 * duplicate-dependency-doctor.test.ts — the general form of the bug class
 * this session hit four separate times: a stale dependency floor forcing
 * a private nested copy instead of deduping to the shared hoisted one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDuplicateDependencyVersions } from "../src/adoption/duplicate-dependency-doctor.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function piHome(): string {
	return track(mkdtempSync(join(tmpdir(), "packed-dup-deps-")));
}

function writePackage(dir: string, name: string, version: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("findDuplicateDependencyVersions", () => {
	it("returns nothing for a clean tree with no @danypops packages at all", () => {
		const home = piHome();
		expect(findDuplicateDependencyVersions(home)).toEqual([]);
	});

	it("returns nothing when every @danypops package resolves to exactly one version, even across several packages", () => {
		const home = piHome();
		const nodeModules = join(home, "npm", "node_modules");
		writePackage(join(nodeModules, "@danypops", "armada"), "@danypops/armada", "0.4.7");
		writePackage(join(nodeModules, "@danypops", "jittor"), "@danypops/jittor", "0.18.1");

		expect(findDuplicateDependencyVersions(home)).toEqual([]);
	});

	it("reports the real jittor incident shape: a stale nested copy alongside the correctly-versioned hoisted one", () => {
		const home = piHome();
		const nodeModules = join(home, "npm", "node_modules");
		const hoistedDir = join(nodeModules, "@danypops", "jittor");
		writePackage(hoistedDir, "@danypops/jittor", "0.18.1");
		const nestedDir = join(nodeModules, "@danypops", "pi-papyrus", "node_modules", "@danypops", "jittor");
		writePackage(nestedDir, "@danypops/jittor", "0.14.0");
		writePackage(join(nodeModules, "@danypops", "pi-papyrus"), "@danypops/pi-papyrus", "1.0.0");

		const diagnostics = findDuplicateDependencyVersions(home);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.name).toBe("@danypops/jittor");
		const versions = diagnostics[0]!.locations.map((location) => location.version).sort();
		expect(versions).toEqual(["0.14.0", "0.18.1"]);
		const paths = diagnostics[0]!.locations.map((location) => location.path).sort();
		expect(paths).toEqual([hoistedDir, nestedDir].sort());
	});

	it("does NOT report two locations at the exact same version -- npm simply didn't need to hoist further, not a real split", () => {
		const home = piHome();
		const nodeModules = join(home, "npm", "node_modules");
		writePackage(join(nodeModules, "@danypops", "vehicle-core"), "@danypops/vehicle-core", "0.17.0");
		writePackage(
			join(nodeModules, "@danypops", "pi-tickets", "node_modules", "@danypops", "vehicle-core"),
			"@danypops/vehicle-core",
			"0.17.0",
		);
		writePackage(join(nodeModules, "@danypops", "pi-tickets"), "@danypops/pi-tickets", "1.0.0");

		expect(findDuplicateDependencyVersions(home)).toEqual([]);
	});

	it("never descends into a nested copy's OWN node_modules -- one level of nesting is the real, confirmed shape; deeper is npm's own dedup problem", () => {
		const home = piHome();
		const nodeModules = join(home, "npm", "node_modules");
		writePackage(join(nodeModules, "@danypops", "vehicle-server"), "@danypops/vehicle-server", "0.24.1");
		const oneLevelDir = join(nodeModules, "@danypops", "pi-packed", "node_modules", "@danypops", "vehicle-server");
		writePackage(oneLevelDir, "@danypops/vehicle-server", "0.24.1");
		writePackage(join(nodeModules, "@danypops", "pi-packed"), "@danypops/pi-packed", "1.0.0");
		// Two levels deep -- must never be reached.
		writePackage(
			join(oneLevelDir, "node_modules", "@danypops", "vehicle-core"),
			"@danypops/vehicle-core",
			"9.9.9",
		);
		writePackage(join(nodeModules, "@danypops", "vehicle-core"), "@danypops/vehicle-core", "0.17.0");

		expect(findDuplicateDependencyVersions(home)).toEqual([]);
	});

	it("sorts multiple diagnostics by package name for stable output", () => {
		const home = piHome();
		const nodeModules = join(home, "npm", "node_modules");
		writePackage(join(nodeModules, "@danypops", "web-spider-daemon"), "@danypops/web-spider-daemon", "0.24.2");
		writePackage(
			join(nodeModules, "@danypops", "pi-web-spider", "node_modules", "@danypops", "web-spider-daemon"),
			"@danypops/web-spider-daemon",
			"0.24.0",
		);
		writePackage(join(nodeModules, "@danypops", "pi-web-spider"), "@danypops/pi-web-spider", "1.0.0");
		writePackage(join(nodeModules, "@danypops", "armada"), "@danypops/armada", "0.4.7");
		writePackage(
			join(nodeModules, "@danypops", "pi-packed", "node_modules", "@danypops", "armada"),
			"@danypops/armada",
			"0.4.3",
		);
		writePackage(join(nodeModules, "@danypops", "pi-packed"), "@danypops/pi-packed", "1.0.0");

		const diagnostics = findDuplicateDependencyVersions(home);

		expect(diagnostics.map((diagnostic) => diagnostic.name)).toEqual(["@danypops/armada", "@danypops/web-spider-daemon"]);
	});

	it("returns [] rather than throwing when piHome/npm/node_modules doesn't exist yet", () => {
		const home = piHome();
		expect(findDuplicateDependencyVersions(home)).toEqual([]);
	});
});
