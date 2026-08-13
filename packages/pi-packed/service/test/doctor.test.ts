import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { formatDoctorReport, runDoctor } from "../src/adoption/doctor.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage } from "../src/packages/package.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

// Same sandbox-availability probe as smoke.test.ts: binary presence alone
// doesn't prove bwrap actually works under this host's user namespaces.
function bwrapUsable(): boolean {
	if (!existsSync("/usr/bin/bwrap")) return false;
	const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { timeout: 5_000 });
	return probe.status === 0;
}
const describeIfSandboxed = bwrapUsable() ? describe : describe.skip;

function piHome(settingsPackages: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "packed-doctor-"));
	roots.push(root);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: settingsPackages }, null, 2));
	return root;
}

function installNpmPackage(home: string, name: string, pi: Record<string, unknown>, files: Record<string, string>): void {
	const dir = join(home, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi }, null, 2));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

describeIfSandboxed("runDoctor", () => {
	it("reports no conflicts when every package's tools are distinct", async () => {
		const home = piHome(["npm:pi-a", "npm:pi-b"]);
		installNpmPackage(
			home,
			"pi-a",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "alpha" }); }',
			},
		);
		installNpmPackage(
			home,
			"pi-b",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "beta" }); }',
			},
		);

		const report = await runDoctor(home);

		expect(report.ok).toBe(true);
		expect(report.conflicts).toEqual([]);
		expect(report.scanned).toBe(2);
	});

	it("reproduces the real jittor incident: a stale project-scoped package re-registering a globally-loaded package's tool names", async () => {
		const home = piHome(["npm:pi-papyrus"]);
		installNpmPackage(
			home,
			"pi-papyrus",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts":
					'export default function (pi: any) { pi.registerTool({ name: "tasks" }); pi.registerTool({ name: "docs" }); }',
			},
		);
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-doctor-project-"));
		roots.push(projectRoot);
		const projectHome = join(projectRoot, ".pi");
		mkdirSync(projectHome, { recursive: true });
		writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:papyrus"] }));
		installNpmPackage(
			projectHome,
			"papyrus",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "tasks" }); }',
			},
		);

		const report = await runDoctor(home, projectRoot);

		expect(report.ok).toBe(false);
		expect(report.conflicts).toHaveLength(1);
		const conflict = report.conflicts[0]!;
		expect(conflict).toMatchObject({ kind: "tool", name: "tasks" });
		expect(conflict.claimants).toHaveLength(2);
		expect(conflict.claimants.map((c) => c.scope).sort()).toEqual(["global", "project"]);
		expect(conflict.claimants.map((c) => c.name).sort()).toEqual(["papyrus", "pi-papyrus"]);
	});

	it("never treats a disabled extension as a claimant", async () => {
		const home = piHome([{ source: "npm:pi-a", extensions: [] }, "npm:pi-b"]);
		installNpmPackage(
			home,
			"pi-a",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "shared" }); }',
			},
		);
		installNpmPackage(
			home,
			"pi-b",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "shared" }); }',
			},
		);

		const report = await runDoctor(home);

		expect(report.ok).toBe(true);
		expect(report.conflicts).toEqual([]);
	});

	it("surfaces a genuinely crashing extension as a non-ok result without treating it as a conflict", async () => {
		const home = piHome(["npm:pi-broken"]);
		installNpmPackage(
			home,
			"pi-broken",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function () { throw new Error("boom"); }',
			},
		);

		const report = await runDoctor(home);

		expect(report.ok).toBe(false);
		expect(report.conflicts).toEqual([]);
		expect(report.extensions).toHaveLength(1);
		expect(report.extensions[0]?.status).toBe("crash");
	});

	it("is unaffected by a missing project settings file", async () => {
		const home = piHome(["npm:pi-a"]);
		installNpmPackage(
			home,
			"pi-a",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "alpha" }); }',
			},
		);
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-doctor-project-"));
		roots.push(projectRoot);

		const report = await runDoctor(home, projectRoot);

		expect(report.ok).toBe(true);
		expect(report.scanned).toBe(1);
	});

	it("surfaces a real duplicate @danypops/* dependency version without failing the overall report -- the same jittor-incident shape, caught proactively this time", async () => {
		const home = piHome(["npm:pi-a"]);
		installNpmPackage(
			home,
			"pi-a",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "alpha" }); }',
			},
		);
		const nodeModules = join(home, "npm", "node_modules");
		mkdirSync(join(nodeModules, "@danypops", "jittor"), { recursive: true });
		writeFileSync(
			join(nodeModules, "@danypops", "jittor", "package.json"),
			JSON.stringify({ name: "@danypops/jittor", version: "0.18.1" }),
		);
		mkdirSync(join(nodeModules, "@danypops", "pi-a", "node_modules", "@danypops", "jittor"), { recursive: true });
		writeFileSync(
			join(nodeModules, "@danypops", "pi-a", "node_modules", "@danypops", "jittor", "package.json"),
			JSON.stringify({ name: "@danypops/jittor", version: "0.14.0" }),
		);

		const report = await runDoctor(home);

		expect(report.duplicateDependencies).toHaveLength(1);
		expect(report.duplicateDependencies[0]?.name).toBe("@danypops/jittor");
		expect(report.ok).toBe(true); // informational only -- never fails the run by itself

		const text = formatDoctorReport(report, false);
		expect(text).toContain("DUPLICATE_DEPENDENCY_VERSION @danypops/jittor");
		expect(text).toContain("0.18.1");
		expect(text).toContain("0.14.0");
	});
});

class NoopRegistry implements Registry {
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchAll() {
		return [];
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1.0.0" };
	}
}

class NoopInstaller implements Installer {
	async install() {
		return "ok";
	}
	async remove() {
		return "ok";
	}
	async update() {
		return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false };
	}
}

describeIfSandboxed("doctor.run (daemon RPC wiring)", () => {
	it("reports the same conflict through the authenticated RPC operation as the pure domain function", async () => {
		const home = piHome(["npm:pi-a", "npm:pi-b"]);
		installNpmPackage(
			home,
			"pi-a",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "shared" }); }',
			},
		);
		installNpmPackage(
			home,
			"pi-b",
			{ extensions: ["extension/index.ts"] },
			{
				"extension/index.ts": 'export default function (pi: any) { pi.registerTool({ name: "shared" }); }',
			},
		);
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-state-"))),
			dataDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-data-"))),
			piHome: home,
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});

		const result = await client.call("doctor.run", {});

		expect(result).toEqual(await runDoctor(home));
		expect(result.ok).toBe(false);
		expect(result.conflicts).toHaveLength(1);
	});
});

describe("doctor.run — module freshness (a long-running daemon process's own stale in-memory dependency, see module-freshness.ts)", () => {
	it("merges in moduleFreshness and flips ok:false when the injected checker reports a stale dependency", async () => {
		const home = piHome([]);
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-state-"))),
			dataDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-data-"))),
			piHome: home,
			moduleFreshness: () => [
				{ name: "stale-dep", loadedVersion: "1.0.0", currentVersion: "2.0.0", stale: true },
				{ name: "fresh-dep", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false },
			],
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});

		const result = await client.call("doctor.run", {});

		expect(result.moduleFreshness).toEqual([
			{ name: "stale-dep", loadedVersion: "1.0.0", currentVersion: "2.0.0", stale: true },
			{ name: "fresh-dep", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false },
		]);
		// The base doctor report (no extensions installed) would otherwise be ok:true.
		expect(result.ok).toBe(false);
	});

	it("stays ok:true and reports no stale entries when the injected checker finds nothing stale", async () => {
		const home = piHome([]);
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-state-"))),
			dataDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-data-"))),
			piHome: home,
			moduleFreshness: () => [{ name: "fresh-dep", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false }],
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});

		const result = await client.call("doctor.run", {});

		expect(result.moduleFreshness).toEqual([{ name: "fresh-dep", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false }]);
		expect(result.ok).toBe(true);
	});

	it("omits moduleFreshness entirely when nothing injects it -- a standalone runDoctor() call has no snapshot to compare against", async () => {
		const home = piHome([]);
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-state-"))),
			dataDir: track(mkdtempSync(join(tmpdir(), "packed-doctor-data-"))),
			piHome: home,
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});

		const result = await client.call("doctor.run", {});

		expect(result.moduleFreshness).toBeUndefined();
		expect(result.ok).toBe(true);
	});
});

describe("formatDoctorReport — module freshness rendering", () => {
	const base = { ok: true, conflicts: [], extensions: [], scanned: 0, truncated: false, serviceUnits: [], duplicateDependencies: [] };

	it("prints a STALE_MODULE_CACHE line with an actionable restart hint for each stale entry, and nothing for a fresh one", () => {
		const text = formatDoctorReport(
			{
				...base,
				ok: false,
				moduleFreshness: [
					{ name: "stale-dep", loadedVersion: "1.0.0", currentVersion: "2.0.0", stale: true },
					{ name: "fresh-dep", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false },
				],
			},
			false,
		);

		expect(text).toContain("STALE_MODULE_CACHE stale-dep");
		expect(text).toContain("loaded 1.0.0 at startup");
		expect(text).toContain("2.0.0 is now on disk");
		expect(text).toContain("systemctl --user restart pi-packed.service");
		expect(text).not.toContain("fresh-dep");
	});

	it("prints nothing extra when moduleFreshness is absent or empty", () => {
		expect(formatDoctorReport(base, false)).not.toContain("STALE_MODULE_CACHE");
		expect(formatDoctorReport({ ...base, moduleFreshness: [] }, false)).not.toContain("STALE_MODULE_CACHE");
	});
});
