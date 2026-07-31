import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPinnedNpmSource, npmPackageName, readInstalledPackages, readInstalledPackagesAcrossScopes, readResolvedVersion, splitNpmSource } from "../src/packages/installed.ts";
import { checkUpdates, saveUpdates, loadUpdates, startWatcher } from "../src/daemon/watcher.ts";
import { catalogStatus } from "../src/packages/catalog.ts";
import { openDb, replaceAll, dbPath } from "../src/packages/db.ts";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/shared/ports.ts";

class FakeRegistry implements Registry {
	infoCalls = 0;
	constructor(
		private versions: Record<string, string> = {},
		private pages: Record<number, SearchPage> = {},
	) {}
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(_q: string, from: number, _size?: number): Promise<SearchPage> {
		return this.pages[from] ?? { results: [], total: 0 };
	}
	async searchAll(q: string): Promise<import("../src/shared/ports.ts").Pkg[]> {
		const out: import("../src/shared/ports.ts").Pkg[] = [];
		let from = 0;
		for (;;) {
			const { results, total } = await this.searchPage(q, from, 0);
			out.push(...results);
			from += results.length;
			if (results.length === 0 || from >= total) return out;
		}
	}
	async info(name: string): Promise<PkgInfo> {
		this.infoCalls++;
		const v = this.versions[name];
		if (!v) throw new Error(`404 ${name}`);
		return { name, version: v };
	}
}

function writePiHome(settings: unknown, nodeModules: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "packed-pihome-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	for (const [name, version] of Object.entries(nodeModules)) {
		const pkgDir = join(dir, "npm", "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
	}
	return dir;
}

describe("splitNpmSource", () => {
	it("splits on last non-scope @", () => {
		expect(splitNpmSource("foo@1.2.3")).toEqual(["foo", "1.2.3"]);
		expect(splitNpmSource("@scope/pkg@1.0.0")).toEqual(["@scope/pkg", "1.0.0"]);
		expect(splitNpmSource("foo")).toEqual(["foo", ""]);
		expect(splitNpmSource("@scope/pkg")).toEqual(["@scope/pkg", ""]);
	});
});

describe("isPinnedNpmSource", () => {
	it("true only for an npm: source with an exact version suffix", () => {
		expect(isPinnedNpmSource("npm:foo@1.2.3")).toBe(true);
		expect(isPinnedNpmSource("npm:@scope/pkg@1.2.3")).toBe(true);
		expect(isPinnedNpmSource("npm:foo")).toBe(false);
		expect(isPinnedNpmSource("npm:@scope/pkg")).toBe(false);
		expect(isPinnedNpmSource("git:github.com/u/r@main")).toBe(false);
		expect(isPinnedNpmSource("https://example.com/pkg.tgz")).toBe(false);
	});
});

describe("npmPackageName", () => {
	it("extracts the bare name for npm: sources, pinned or not", () => {
		expect(npmPackageName("npm:foo@1.2.3")).toBe("foo");
		expect(npmPackageName("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(npmPackageName("npm:@scope/pkg")).toBe("@scope/pkg");
	});

	it("undefined for non-npm sources", () => {
		expect(npmPackageName("git:github.com/u/r@main")).toBeUndefined();
		expect(npmPackageName("https://example.com/pkg.tgz")).toBeUndefined();
	});
});

describe("readResolvedVersion", () => {
	it("reads the real on-disk version regardless of pinning", () => {
		const home = writePiHome({ packages: [] }, { "@scope/pkg": "3.4.5", plain: "1.0.0" });
		expect(readResolvedVersion(home, "npm:@scope/pkg@9.9.9")).toBe("3.4.5");
		expect(readResolvedVersion(home, "npm:@scope/pkg")).toBe("3.4.5");
		expect(readResolvedVersion(home, "npm:plain")).toBe("1.0.0");
	});

	it("undefined for a non-npm source or a package missing from node_modules", () => {
		const home = writePiHome({ packages: [] });
		expect(readResolvedVersion(home, "git:github.com/u/r@main")).toBeUndefined();
		expect(readResolvedVersion(home, "npm:never-installed")).toBeUndefined();
	});
});

describe("readInstalledPackages", () => {
	it("parses string and object forms, resolves unpinned from node_modules", () => {
		const home = writePiHome(
			{
				packages: [
					"npm:pi-extension-manager@0.8.2",
					"npm:@scope/pinned@1.0.0",
					"npm:unpinned",
					"git:github.com/u/r",
					{ source: "npm:obj-form@2.0.0" },
				],
			},
			{ unpinned: "0.5.0" },
		);
		expect(readInstalledPackages(home)).toEqual([
			{ name: "pi-extension-manager", pinned: "0.8.2", installed: undefined },
			{ name: "@scope/pinned", pinned: "1.0.0", installed: undefined },
			{ name: "unpinned", pinned: undefined, installed: "0.5.0" },
			{ name: "obj-form", pinned: "2.0.0", installed: undefined },
		]);
	});

	it("missing settings → empty", () => {
		expect(readInstalledPackages(mkdtempSync(join(tmpdir(), "packed-")))).toEqual([]);
	});
});

describe("readInstalledPackagesAcrossScopes", () => {
	it("tags every entry with its scope and is global-only without a projectRoot", () => {
		const home = writePiHome({ packages: ["npm:pi-global@1.0.0"] });
		expect(readInstalledPackagesAcrossScopes(home)).toEqual([{ name: "pi-global", pinned: "1.0.0", installed: undefined, scope: "global" }]);
	});

	it("reproduces the real jittor gap: a stale project-scoped pin is invisible to a global-only read, visible once project scope is included", () => {
		const home = writePiHome({ packages: ["npm:pi-global@1.0.0"] });
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-project-"));
		const projectHome = join(projectRoot, ".pi");
		mkdirSync(projectHome, { recursive: true });
		writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:papyrus@0.21.2"] }));

		expect(readInstalledPackages(home).map((pkg) => pkg.name)).not.toContain("papyrus");
		const merged = readInstalledPackagesAcrossScopes(home, projectRoot);
		expect(merged).toEqual([
			{ name: "pi-global", pinned: "1.0.0", installed: undefined, scope: "global" },
			{ name: "papyrus", pinned: "0.21.2", installed: undefined, scope: "project" },
		]);
	});

	it("is unaffected by a missing project settings file", () => {
		const home = writePiHome({ packages: ["npm:pi-global@1.0.0"] });
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-project-"));
		expect(readInstalledPackagesAcrossScopes(home, projectRoot)).toEqual([{ name: "pi-global", pinned: "1.0.0", installed: undefined, scope: "global" }]);
	});
});

describe("checkUpdates (mirror-based)", () => {
	it("flags drift only", () => {
		const latest = (name: string) => ({ "pi-extension-manager": "0.9.0", "pi-lsp": "1.0.0" })[name];
		const updates = checkUpdates(latest, [
			{ name: "pi-extension-manager", pinned: "0.8.2" },
			{ name: "pi-lsp", installed: "1.0.0" },
		]);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ name: "pi-extension-manager", installed: "0.8.2", latest: "0.9.0" });
	});

	it("packages missing from the mirror are skipped", () => {
		const updates = checkUpdates(() => undefined, [{ name: "gone", pinned: "1.0.0" }]);
		expect(updates).toEqual([]);
	});

	it("carries scope through so a project-scoped drift entry is distinguishable from a global one", () => {
		const latest = (name: string) => ({ papyrus: "0.38.1" })[name];
		const updates = checkUpdates(latest, [{ name: "papyrus", pinned: "0.21.2", scope: "project" }]);
		expect(updates).toEqual([{ name: "papyrus", installed: "0.21.2", latest: "0.38.1", detectedAt: updates[0]!.detectedAt, scope: "project" }]);
	});

	// Real, screenshot-confirmed bug: the mirror's own "latest" can lag
	// behind what's actually installed (a stale sync, or the installed
	// package genuinely jumped ahead). A plain !== check can't tell that
	// apart from real drift and flags a permanent, un-clearable "update"
	// pointing at an OLDER version than what's already installed.
	it("never flags a package whose installed version is already ahead of the mirrored latest", () => {
		const latest = (name: string) => ({ "pi-papyrus": "0.38.4" })[name];
		const updates = checkUpdates(latest, [{ name: "pi-papyrus", installed: "0.41.0" }]);
		expect(updates).toEqual([]);
	});

	it("still flags a genuine downgrade-to-latest scenario correctly using real semver ordering, not string equality", () => {
		// 0.9.0 vs 0.10.0 -- string comparison would call these "different"
		// either way, but semver must recognize 0.10.0 as newer, not just "not equal".
		const latest = (name: string) => ({ "pi-lsp": "0.10.0" })[name];
		const updates = checkUpdates(latest, [{ name: "pi-lsp", installed: "0.9.0" }]);
		expect(updates).toEqual([{ name: "pi-lsp", installed: "0.9.0", latest: "0.10.0", detectedAt: updates[0]!.detectedAt }]);
	});

	it("falls back to inequality for non-semver values (a git ref or a literal dist-tag) since they aren't comparable at all", () => {
		const latest = (name: string) => ({ "pi-git-pkg": "latest" })[name];
		const updates = checkUpdates(latest, [{ name: "pi-git-pkg", installed: "latest" }]);
		expect(updates).toEqual([]); // same non-semver string -- not different, not flagged
	});
});

class NoopRegistry implements Registry {
	async search(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchPage(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchAll() { return []; }
	async info(name: string): Promise<PkgInfo> { return { name, version: "1.0.0" }; }
}

class NoopInstaller implements Installer {
	async install() { return "ok"; }
	async remove() { return "ok"; }
	async update(): Promise<UpdateOutcome> { return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false }; }
}

describe("package.updates.project (daemon RPC wiring)", () => {
	it("computes a live, cross-scope drift check on demand, distinct from package.updates' own persisted global-only snapshot", async () => {
		const home = mkdtempSync(join(tmpdir(), "packed-updates-project-"));
		writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: ["npm:pi-global@1.0.0"] }));
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-updates-project-root-"));
		const projectHome = join(projectRoot, ".pi");
		mkdirSync(projectHome, { recursive: true });
		writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:papyrus@0.21.2"] }));
		const stateDir = mkdtempSync(join(tmpdir(), "packed-updates-project-state-"));
		const db = openDb(dbPath(stateDir));
		replaceAll(db, [{ name: "pi-global", version: "1.0.0" }, { name: "papyrus", version: "0.38.1" }], "test");
		db.close();
		const app = createApp({ reg: new NoopRegistry(), inst: new NoopInstaller(), token: "test-token", stateDir, piHome: home });
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", { label: "Packed", transport: (request) => app.fetch(request) });

		const globalSnapshot = await client.call("package.updates", {});
		expect(globalSnapshot.updates).toEqual([]);

		const result = await client.call("package.updates.project", { projectRoot });
		expect(result.updates).toEqual([{ name: "papyrus", installed: "0.21.2", latest: "0.38.1", detectedAt: result.updates[0]!.detectedAt, scope: "project" }]);
	});
});

describe("updates store", () => {
	it("roundtrips", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		const snap = { checkedAt: new Date().toISOString(), updates: [{ name: "a", installed: "1", latest: "2", detectedAt: "" }] };
		await saveUpdates(dir, snap);
		expect(await loadUpdates(dir)).toEqual(snap);
		expect(await loadUpdates(join(dir, "nope"))).toBeUndefined();
	});
});

describe("watcher producer", () => {
	it("writes a snapshot on tick", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		const stop = startWatcher(
			() => "0.9.0",
			dir,
			() => [{ name: "pi-extension-manager", pinned: "0.8.2" }],
			{ intervalMs: 60_000 },
		);
		const deadline = Date.now() + 2000;
		let snap;
		while (Date.now() < deadline) {
			snap = await loadUpdates(dir);
			if (snap?.updates.length) break;
			await Bun.sleep(25);
		}
		stop();
		expect(snap?.updates[0]?.latest).toBe("0.9.0");
	});
});

describe("catalog status", () => {
	it("stale when unsynced, fresh after sync", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		expect(catalogStatus(dir, 6 * 3_600_000).stale).toBe(true);
		const db = openDb(dir + "/packed.db");
		replaceAll(db, [{ name: "a", version: "1" }], "test");
		db.close();
		expect(catalogStatus(dir, 6 * 3_600_000).stale).toBe(false);
		expect(catalogStatus(dir, -1).stale).toBe(true);
	});
});
