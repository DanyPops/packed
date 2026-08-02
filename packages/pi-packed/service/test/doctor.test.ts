import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { runDoctor } from "../src/adoption/doctor.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage } from "../src/packages/package.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
			stateDir: mkdtempSync(join(tmpdir(), "packed-doctor-state-")),
			dataDir: mkdtempSync(join(tmpdir(), "packed-doctor-data-")),
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
