import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeDaemonHandle } from "@danypops/vehicle-server/paths";
import type { Server } from "bun";
import { type CliDeps, cliRun } from "../src/cli/cli.ts";
import {
	DaemonRegistry,
	PackageDaemonClient,
	PackageDaemonInstaller,
	type PackageDaemonPort,
	probe,
	resolveRegistry,
} from "../src/daemon/client.ts";
import { createApp } from "../src/daemon/service.ts";
import { catalogList, dbPath, openDb, replaceAll } from "../src/packages/db.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/packages/package.ts";
import { HttpRegistry } from "../src/registry/registry.ts";
import { type PackedPaths, resolvePackedPaths } from "../src/shared/paths.ts";
import { VERSION } from "../src/shared/version.ts";

class FakeRegistry implements Registry {
	constructor(
		private results: Pkg[] = [],
		private versions: Record<string, string> = {},
	) {}
	async search(_q: string, _limit: number): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchAll(): Promise<import("../src/packages/package.ts").Pkg[]> {
		return this.results;
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: this.versions[name] ?? "1.0.0", description: "desc" };
	}
}

class FakeInstaller implements Installer {
	gotSource = "";
	removed = "";
	updated = "";
	fail = false;
	approved = false;
	/** Override per-test to exercise the alreadyUpToDate/pinned reporting paths. */
	updateOutcome: Partial<UpdateOutcome> = {};
	async install(source: string, options?: { approved?: boolean }): Promise<string> {
		this.gotSource = source;
		this.approved = options?.approved === true;
		if (this.fail) throw new Error("installer failed");
		return `Installed ${source}`;
	}
	async remove(source: string, options?: { approved?: boolean }): Promise<string> {
		this.removed = source;
		this.approved = options?.approved === true;
		return `Removed ${source}`;
	}
	gotTarget: string | undefined;
	async update(source: string, options?: { approved?: boolean; target?: string }): Promise<UpdateOutcome> {
		this.updated = source;
		this.approved = options?.approved === true;
		this.gotTarget = options?.target;
		return {
			output: `Updated ${source}`,
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
			...this.updateOutcome,
		};
	}
}

class FakeDaemonServiceInstaller {
	gotSource = "";
	approved = false;
	fail = false;
	restartGotSource = "";
	restartApproved = false;
	restartFail = false;
	reconcileGotApproved: boolean | undefined;
	reconcileGotProjectRoot: string | undefined;
	reconcileFail = false;
	async install(source: string, approved?: boolean) {
		this.gotSource = source;
		this.approved = approved === true;
		if (this.fail) throw new Error("install-service failed");
		return {
			output: `installed a persistent service for ${source}`,
			spec: {
				name: "probe",
				version: "1.0.0",
				binPath: "/opt/probe/cli.js",
				handlePath: "/tmp/probe.handle.json",
			},
		};
	}
	async restart(source: string, approved?: boolean) {
		this.restartGotSource = source;
		this.restartApproved = approved === true;
		if (this.restartFail) throw new Error("restart-service failed");
		return {
			output: `restarted the persistent service for ${source}`,
			restarted: true,
			spec: {
				name: "probe",
				version: "1.0.0",
				binPath: "/opt/probe/cli.js",
				handlePath: "/tmp/probe.handle.json",
			},
		};
	}
	async reconcileAll(approved?: boolean, projectRoot?: string) {
		this.reconcileGotApproved = approved;
		this.reconcileGotProjectRoot = projectRoot;
		if (this.reconcileFail) throw new Error("reconcile-services failed");
		return {
			ok: true,
			output: "reconciled 1 Vehicle(s), skipped 0 non-daemon package(s)",
			reconciled: [{ packageName: "@danypops/probe", vehicleName: "probe", installed: true }],
			skipped: 0,
			failed: [],
			pruned: [],
			pruneFailed: [],
		};
	}
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function deps(over: Partial<CliDeps> = {}): CliDeps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		daemonService: new FakeDaemonServiceInstaller(),
		security: {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async setMutationApproval(mutationApproval) {
				return { mutationApproval };
			},
		},
		stateDir: track(mkdtempSync(join(tmpdir(), "packed-"))),
		piHome: track(mkdtempSync(join(tmpdir(), "packed-pihome-"))),
		...over,
	};
}

describe("CLI", () => {
	it("publishes an executable packed binary", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { bin?: Record<string, string> };
		expect(manifest.bin).toEqual({ packed: "service/src/cli/cli.ts" });
		expect(readFileSync(new URL("../src/cli/cli.ts", import.meta.url), "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
	});

	it("security reads and writes stable JSON through the daemon port", async () => {
		let mutationApproval: "always" | "never" = "always";
		const d = deps({
			security: {
				async security() {
					return { mutationApproval };
				},
				async setMutationApproval(value, options) {
					expect(options?.approved).toBe(true);
					mutationApproval = value;
					return { mutationApproval };
				},
			},
		});
		expect((await cliRun(["security", "--json"], d)).out).toBe('{"mutationApproval":"always"}\n');
		expect((await cliRun(["security", "never", "--approve", "--json"], d)).out).toBe('{"mutationApproval":"never"}\n');
	});

	it("runs static check standalone without consulting daemon security state", async () => {
		const d = deps({
			security: {
				async security(): Promise<never> {
					throw new Error("daemon unavailable");
				},
				async setMutationApproval(): Promise<never> {
					throw new Error("daemon unavailable");
				},
			},
		});
		const root = new URL("fixtures/install-validation/no-manifest-package", import.meta.url).pathname;
		const result = await cliRun(["check", root, "--json"], d);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.out).diagnostics.some((item: { code: string }) => item.code === "PI_NO_RESOURCES")).toBe(true);
		expect(JSON.parse(result.out).root).toBe(root.replace(/\/$/, ""));
	});

	it("packs and scores standalone through bounded application ports", async () => {
		const empty = { status: "unknown" as const, met: 0, total: 0, evidence: [], actions: [] };
		const d = deps({
			packer: {
				async verify(path) {
					return {
						root: path,
						ok: true,
						command: ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
						files: [],
						shape: { kind: "manifest", verified: true, evidence: ["pi.extensions"] },
						diagnostics: [],
						truncated: false,
					};
				},
			},
			scorer: {
				async score(target) {
					return {
						target,
						source: "registry" as const,
						package: { name: target, version: "1" },
						dimensions: {
							discoverability: empty,
							firstRun: empty,
							trust: empty,
							maintenance: empty,
							traction: empty,
							compatibility: empty,
							freshness: empty,
						},
					};
				},
			},
		});
		expect(JSON.parse((await cliRun(["pack", ".", "--json"], d)).out).shape.verified).toBe(true);
		expect(JSON.parse((await cliRun(["score", "pi-demo", "--json"], d)).out).target).toBe("pi-demo");
	});

	it("generates and checks staged-publish workflows without agent-callable publishing", async () => {
		const calls: string[] = [];
		const d = deps({
			publisher: {
				async setup(path, options) {
					calls.push(`setup:${path}:${options?.force}`);
					return {
						root: path,
						ok: true,
						wrote: true,
						workflowPath: `${path}/.github/workflows/packed-stage-publish.yml`,
						packageName: "pi-demo",
						repository: "example/pi-demo",
						diagnostics: [],
					};
				},
				async status(path) {
					calls.push(`status:${path}`);
					return {
						root: path,
						ready: true,
						workflowPath: `${path}/.github/workflows/packed-stage-publish.yml`,
						checks: {
							packageExists: true,
							repository: true,
							workflow: true,
							lockfile: true,
							node: true,
							npm: true,
							trustedPublisher: "unknown",
							coreFirst: true,
							loggedIn: true,
						},
						diagnostics: [],
						nextSteps: [],
					};
				},
			},
		});
		const root = resolve(".");
		expect(JSON.parse((await cliRun(["publish", "setup", ".", "--force", "--json"], d)).out).wrote).toBe(true);
		expect(JSON.parse((await cliRun(["publish", "status", ".", "--json"], d)).out).ready).toBe(true);
		expect(calls).toEqual([`setup:${root}:true`, `status:${root}`]);
		expect((await cliRun(["publish", "approve"], d)).code).toBe(2);
	});

	it("exports, plans, and approval-gates setup apply standalone", async () => {
		const calls: string[] = [];
		const d = deps({
			setup: {
				async export(projectRoot, options) {
					calls.push(`export:${projectRoot}:${options?.force}`);
					return {
						ok: true,
						path: `${projectRoot}/pi-setup.json`,
						manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
						diagnostics: [],
						wrote: true,
					};
				},
				async update(manifestPath) {
					calls.push(`update:${manifestPath}`);
					return {
						ok: true,
						path: manifestPath,
						manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
						diagnostics: [],
						wrote: true,
						updated: 0,
					};
				},
				async plan(manifestPath) {
					calls.push(`plan:${manifestPath}`);
					return { ok: true, manifestPath, operations: [], diagnostics: [] };
				},
				async apply(manifestPath) {
					calls.push(`apply:${manifestPath}`);
					return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] };
				},
			},
		});
		const root = resolve(".");
		expect((await cliRun(["setup", "export", ".", "--force", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "update", ".", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "plan", ".", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "apply", ".", "--json"], d)).code).toBe(1);
		expect((await cliRun(["setup", "apply", ".", "--approve", "--json"], d)).code).toBe(0);
		expect(calls).toEqual([`export:${root}:true`, `update:${root}`, `plan:${root}`, `apply:${root}`]);
	});

	it("setup plan/apply --ecosystem resolves the bundled @danypops starter manifest, not the cwd", async () => {
		const calls: string[] = [];
		const d = deps({
			setup: {
				async export() {
					throw new Error("not exercised");
				},
				async update() {
					throw new Error("not exercised");
				},
				async plan(manifestPath) {
					calls.push(`plan:${manifestPath}`);
					return { ok: true, manifestPath, operations: [], diagnostics: [] };
				},
				async apply(manifestPath) {
					calls.push(`apply:${manifestPath}`);
					return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] };
				},
			},
		});
		expect((await cliRun(["setup", "plan", "--ecosystem", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "apply", "--ecosystem", "--approve", "--json"], d)).code).toBe(0);
		expect(calls[0]).toContain("setup/danypops-ecosystem.pi-setup.json");
		expect(calls[1]).toContain("setup/danypops-ecosystem.pi-setup.json");
	});

	it("search --json", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]) });
		const { code, out } = await cliRun(["search", "lsp", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
	});

	it("search human", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0", description: "LSP" }]) });
		const { code, out } = await cliRun(["search", "lsp"], d);
		expect(code).toBe(0);
		expect(out).toContain("pi-lsp@0.3.0");
		expect(out).toContain("LSP");
	});

	it("info --json", async () => {
		const { code, out } = await cliRun(["info", "pi-lsp", "--json"], deps());
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
	});

	it("installed --json (string and object settings forms)", async () => {
		const d = deps();
		writeFileSync(
			join(d.piHome, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2", { source: "npm:obj@2.0.0" }] }),
		);
		const { code, out } = await cliRun(["installed", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-extension-manager"');
		expect(out).toContain('"pinned":"0.8.2"');
	});

	it("installed --json also surfaces a real Vehicle-shaped daemon dependency that has no pi: manifest of its own, standalone without a daemon -- packed-package-update-restart-service-cant-manage", async () => {
		const d = deps();
		writeFileSync(join(d.piHome, "settings.json"), JSON.stringify({ packages: ["npm:@danypops/pi-lector@0.12.7"] }));
		const piLectorDir = join(d.piHome, "npm", "node_modules", "@danypops", "pi-lector");
		mkdirSync(piLectorDir, { recursive: true });
		writeFileSync(
			join(piLectorDir, "package.json"),
			JSON.stringify({ name: "@danypops/pi-lector", version: "0.12.7", dependencies: { "@danypops/lector": "^0.18.0" } }),
		);
		const lectorDir = join(d.piHome, "npm", "node_modules", "@danypops", "lector");
		mkdirSync(lectorDir, { recursive: true });
		writeFileSync(
			join(lectorDir, "package.json"),
			JSON.stringify({
				name: "@danypops/lector",
				version: "0.18.9",
				bin: { lector: "src/cli.ts" },
				dependencies: { "@danypops/vehicle-server": "^0.18.2" },
			}),
		);
		const { code, out } = await cliRun(["installed", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"@danypops/lector"');
		expect(out).toContain('"kind":"daemon-dependency"');
	});

	it("installed (human-readable) tags a daemon-dependency row distinctly from a plain pi: extension row", async () => {
		const d = deps();
		writeFileSync(join(d.piHome, "settings.json"), JSON.stringify({ packages: ["npm:@danypops/pi-lector@0.12.7"] }));
		const piLectorDir = join(d.piHome, "npm", "node_modules", "@danypops", "pi-lector");
		mkdirSync(piLectorDir, { recursive: true });
		writeFileSync(
			join(piLectorDir, "package.json"),
			JSON.stringify({ name: "@danypops/pi-lector", version: "0.12.7", dependencies: { "@danypops/lector": "^0.18.0" } }),
		);
		const lectorDir = join(d.piHome, "npm", "node_modules", "@danypops", "lector");
		mkdirSync(lectorDir, { recursive: true });
		writeFileSync(
			join(lectorDir, "package.json"),
			JSON.stringify({
				name: "@danypops/lector",
				version: "0.18.9",
				bin: { lector: "src/cli.ts" },
				dependencies: { "@danypops/vehicle-server": "^0.18.2" },
			}),
		);
		const { code, out } = await cliRun(["installed"], d);
		expect(code).toBe(0);
		expect(out).toBe("  @danypops/pi-lector@0.12.7\n  @danypops/lector@0.18.9 [daemon-dependency]\n");
	});

	it("updates computes drift from the local mirror", async () => {
		const d = deps();
		writeFileSync(join(d.piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2"] }));
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-extension-manager", version: "0.9.0" }], "test");
		db.close();
		const { code, out } = await cliRun(["updates", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"latest":"0.9.0"');
	});

	it("updates --project also checks a project's own .pi/settings.json pins -- global-only misses them entirely", async () => {
		const d = deps();
		writeFileSync(join(d.piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-global@1.0.0"] }));
		const projectRoot = track(mkdtempSync(join(tmpdir(), "packed-project-")));
		const projectHome = join(projectRoot, ".pi");
		mkdirSync(projectHome, { recursive: true });
		writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:papyrus@0.21.2"] }));
		const db = openDb(dbPath(d.stateDir));
		replaceAll(
			db,
			[
				{ name: "pi-global", version: "1.0.0" },
				{ name: "papyrus", version: "0.38.1" },
			],
			"test",
		);
		db.close();

		const globalOnly = await cliRun(["updates", "--json"], d);
		expect(JSON.parse(globalOnly.out).updates).toEqual([]);

		const withProject = await cliRun(["updates", "--project", projectRoot, "--json"], d);
		const updates = JSON.parse(withProject.out).updates;
		expect(updates).toEqual([
			{ name: "papyrus", installed: "0.21.2", latest: "0.38.1", detectedAt: updates[0].detectedAt, scope: "project" },
		]);
		const human = await cliRun(["updates", "--project", projectRoot], d);
		expect(human.out).toContain("papyrus [project]");
	});

	it("catalog reads the SQLite mirror", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "a", version: "1" }], "test");
		db.close();
		const { code, out } = await cliRun(["catalog", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"a"');
		expect(out).toContain('"sha256"');
	});

	it("search --offline queries the mirror only", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-lsp", version: "1", description: "LSP tools" }], "test");
		db.close();
		const { code, out } = await cliRun(["search", "lsp", "--offline", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"name":"pi-lsp"');
		expect(out).toContain('"offline":true');
	});

	it("mirror syncs upstream into the local index", async () => {
		const d = deps({ reg: new FakeRegistry([{ name: "pi-lsp", version: "1" }]) });
		const { code, out } = await cliRun(["mirror", "--json"], d);
		expect(code).toBe(0);
		expect(out).toContain('"synced":1');
		const db = openDb(dbPath(d.stateDir));
		expect(catalogList(db)).toHaveLength(1);
		db.close();
	});

	it("index build generates a local snapshot from the SQLite mirror standalone, and index status reads it back", async () => {
		const d = deps({ reg: new FakeRegistry([], { "pi-lsp": "1.0.0" }) });
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-lsp", version: "1.0.0" }], "test");
		db.close();
		expect((await cliRun(["index", "status", "--json"], d)).out).toContain("null"); // nothing built yet
		const built = await cliRun(["index", "build", "--json"], d);
		expect(built.code).toBe(0);
		expect(JSON.parse(built.out).packages[0]).toMatchObject({ name: "pi-lsp", version: "1.0.0" });
		const status = await cliRun(["index", "status", "--json"], d);
		expect(JSON.parse(status.out).packages).toHaveLength(1);
		expect((await cliRun(["index", "status"], d)).out).toContain("1 packages");
		expect((await cliRun(["index", "bogus"], d)).code).toBe(2);
	});

	it("install validates source", async () => {
		const d = deps();
		const { code } = await cliRun(["install", "foo; rm -rf ~"], d);
		expect(code).toBe(2);
		expect((d.inst as FakeInstaller).gotSource).toBe("");
	});

	it("install runs with stable human and JSON output", async () => {
		const d = deps();
		expect((await cliRun(["install", "npm:foo"], d)).code).toBe(1);
		const human = await cliRun(["install", "npm:foo", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("Installed npm:foo");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["install", "npm:foo", "--approve", "--json"], d);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)).toEqual({ ok: true, source: "npm:foo", output: "Installed npm:foo" });
	});


	it("install-service validates source", async () => {
		const d = deps();
		const { code } = await cliRun(["install-service", "foo; rm -rf ~"], d);
		expect(code).toBe(2);
		expect((d.daemonService as FakeDaemonServiceInstaller).gotSource).toBe("");
	});

	it("install-service requires approval, then runs with stable human and JSON output", async () => {
		const d = deps();
		expect((await cliRun(["install-service", "npm:foo"], d)).code).toBe(1);
		const human = await cliRun(["install-service", "npm:foo", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("installed a persistent service for npm:foo");
		expect((d.daemonService as FakeDaemonServiceInstaller).approved).toBe(true);
		const json = await cliRun(["install-service", "npm:foo", "--approve", "--json"], d);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)).toEqual({
			ok: true,
			source: "npm:foo",
			output: "installed a persistent service for npm:foo",
			spec: {
				name: "probe",
				version: "1.0.0",
				binPath: "/opt/probe/cli.js",
				handlePath: "/tmp/probe.handle.json",
			},
		});
	});

	it("install-service reports a resolver/installer failure in-band with exit code 1", async () => {
		const d = deps();
		(d.daemonService as FakeDaemonServiceInstaller).fail = true;
		const { code, out } = await cliRun(["install-service", "npm:foo", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("install-service failed");
	});

	it("install-service fails closed without a running daemon", async () => {
		const d = deps({ daemonService: undefined });
		const { code, out } = await cliRun(["install-service", "npm:foo", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("requires a running packed daemon");
	});

	it("reconcile-services requires approval, then sweeps every installed package with stable human and JSON output", async () => {
		const d = deps();
		expect((await cliRun(["reconcile-services"], d)).code).toBe(1);
		const human = await cliRun(["reconcile-services", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("reconciled 1 Vehicle(s)");
		expect((d.daemonService as FakeDaemonServiceInstaller).reconcileGotApproved).toBe(true);
		const json = await cliRun(["reconcile-services", "--approve", "--json"], d);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.out)).toEqual({
			ok: true,
			output: "reconciled 1 Vehicle(s), skipped 0 non-daemon package(s)",
			reconciled: [{ packageName: "@danypops/probe", vehicleName: "probe", installed: true }],
			skipped: 0,
			failed: [],
			pruned: [],
			pruneFailed: [],
		});
	});

	it("reconcile-services threads --project through to the sweep", async () => {
		const d = deps();
		await cliRun(["reconcile-services", "--approve", "--project", "/repo"], d);
		expect((d.daemonService as FakeDaemonServiceInstaller).reconcileGotProjectRoot).toBe("/repo");
	});

	it("reconcile-services reports a sweep failure in-band with exit code 1", async () => {
		const d = deps();
		(d.daemonService as FakeDaemonServiceInstaller).reconcileFail = true;
		const { code, out } = await cliRun(["reconcile-services", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("reconcile-services failed");
	});

	it("reconcile-services fails closed without a running daemon", async () => {
		const d = deps({ daemonService: undefined });
		const { code, out } = await cliRun(["reconcile-services", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("requires a running packed daemon");
	});

	it("update delegates one configured source with stable output and approval", async () => {
		const d = deps();
		expect((await cliRun(["update", "npm:foo"], d)).code).toBe(1);
		const human = await cliRun(["update", "npm:foo", "--approve"], d);
		expect(human.out).toContain("Updated npm:foo");
		expect((d.inst as FakeInstaller).updated).toBe("npm:foo");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["update", "npm:foo", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({
			ok: true,
			source: "npm:foo",
			output: "Updated npm:foo",
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
		});
	});

	it("update --to threads the replacement target through to the installer and reports it in both human and JSON output", async () => {
		const d = deps({
			inst: (() => {
				const fake = new FakeInstaller();
				fake.updateOutcome = {
					replaced: true,
					before: { source: "npm:@scope/pkg@1.0.0", version: "1.0.0" },
					after: { source: "npm:@scope/pkg@2.0.0", version: "2.0.0" },
				};
				return fake;
			})(),
		});

		const human = await cliRun(["update", "npm:@scope/pkg@1.0.0", "--to", "npm:@scope/pkg@2.0.0", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("replaced npm:@scope/pkg@1.0.0 with npm:@scope/pkg@2.0.0");
		expect((d.inst as FakeInstaller).gotTarget).toBe("npm:@scope/pkg@2.0.0");

		const json = await cliRun(["update", "npm:@scope/pkg@1.0.0", "--to", "npm:@scope/pkg@2.0.0", "--approve", "--json"], d);
		const parsed = JSON.parse(json.out);
		expect(parsed.replaced).toBe(true);
		expect(parsed.before).toEqual({ source: "npm:@scope/pkg@1.0.0", version: "1.0.0" });
		expect(parsed.after).toEqual({ source: "npm:@scope/pkg@2.0.0", version: "2.0.0" });
	});

	it("update --to rejects an invalid target source with a usage error, before ever calling the installer", async () => {
		const d = deps();
		const result = await cliRun(["update", "npm:@scope/pkg@1.0.0", "--to", "not a valid source!", "--approve"], d);
		expect(result.code).toBe(2);
		expect((d.inst as FakeInstaller).updated).toBe("");
	});

	it("reports pinnedSourceRequiresTarget and mentions --to in the human-readable pinned message", async () => {
		const d = deps({
			inst: (() => {
				const fake = new FakeInstaller();
				fake.updateOutcome = { alreadyUpToDate: true, reloadRequired: false, pinned: true, pinnedSourceRequiresTarget: true };
				return fake;
			})(),
		});

		const human = await cliRun(["update", "npm:@scope/pkg@1.0.0", "--approve"], d);
		expect(human.out).toContain("--to");
		const json = await cliRun(["update", "npm:@scope/pkg@1.0.0", "--approve", "--json"], d);
		expect(JSON.parse(json.out).pinnedSourceRequiresTarget).toBe(true);
	});

	it("update --self requires approval under the guarded default, same as every other mutation", async () => {
		const d = deps({
			selfUpdater: {
				async run() {
					throw new Error("must never run without approval");
				},
			},
		});
		const { code, out } = await cliRun(["update", "--self"], d);
		expect(code).toBe(1);
		expect(out).toContain("approval required");
	});

	it("update --self delegates to the injected selfUpdater once approved, reporting the version transition", async () => {
		const d = deps({
			selfUpdater: {
				async run() {
					return {
						ok: true,
						previousVersion: "0.1.1",
						latestVersion: "0.2.0",
						updated: true,
						restarted: true,
						message: "updated via npm and restarted the pi-packed service",
					};
				},
			},
		});
		const human = await cliRun(["update", "--self", "--approve"], d);
		expect(human.code).toBe(0);
		expect(human.out).toContain("updated via npm and restarted the pi-packed service");
		expect(human.out).toContain("(0.1.1 \u2192 0.2.0)");
		const json = await cliRun(["update", "--self", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({
			ok: true,
			previousVersion: "0.1.1",
			latestVersion: "0.2.0",
			updated: true,
			restarted: true,
			message: "updated via npm and restarted the pi-packed service",
		});
	});

	it("update --self reports failure with exit code 1 when the selfUpdater itself reports not ok", async () => {
		const d = deps({
			selfUpdater: {
				async run() {
					return {
						ok: false,
						previousVersion: "0.1.1",
						updated: false,
						restarted: false,
						message: "npm install --global @danypops/pi-packed@latest failed (exit 1)",
					};
				},
			},
		});
		const { code, out } = await cliRun(["update", "--self", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("npm install --global");
	});

	it("update --self fails closed without a running daemon, matching install-service", async () => {
		const d = deps({ selfUpdater: undefined });
		const { code, out } = await cliRun(["update", "--self", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("requires a running packed daemon");
	});

	it("update reports honestly when pi update is a no-op (pinned or already latest)", async () => {
		const d = deps();
		(d.inst as FakeInstaller).updateOutcome = {
			alreadyUpToDate: true,
			reloadRequired: false,
			pinned: true,
			previousVersion: "1.2.3",
			currentVersion: "1.2.3",
		};
		const human = await cliRun(["update", "npm:foo@1.2.3", "--approve"], d);
		expect(human.out).toContain("pinned to 1.2.3");
		expect(human.out).not.toContain("Reload Pi");
		const json = await cliRun(["update", "npm:foo@1.2.3", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({
			ok: true,
			source: "npm:foo@1.2.3",
			output: "Updated npm:foo@1.2.3",
			reloadRequired: false,
			alreadyUpToDate: true,
			pinned: true,
			previousVersion: "1.2.3",
			currentVersion: "1.2.3",
		});
	});

	/** A PackageDaemonPort stub that throws "unexpected call" for anything the test doesn't
	 * explicitly override -- update --all only ever calls updateAll(), so nothing else should
	 * ever be invoked; a Proxy avoids hand-writing 25+ unused method stubs. */
	function baseDaemonPort(): PackageDaemonPort {
		return new Proxy(
			{},
			{
				get: (_target, prop) => async () => {
					throw new Error(`unexpected call: ${String(prop)}`);
				},
			},
		) as PackageDaemonPort;
	}

	it("update --all fails closed without a running daemon", async () => {
		const d = deps({ daemon: undefined });
		const { code, out } = await cliRun(["update", "--all", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("requires a running packed daemon");
	});

	it("update --all delegates to the daemon's batch endpoint and reports a per-package summary", async () => {
		const calls: Array<[string[] | undefined, boolean | undefined]> = [];
		const daemon = {
			...baseDaemonPort(),
			async updateAll(sources?: string[], approved?: boolean) {
				calls.push([sources, approved]);
				return {
					ok: true,
					output: "updated 1/2 package(s)",
					results: [
						{ source: "npm:pi-lsp", ok: true, output: "Updated npm:pi-lsp", previousVersion: "1.0.0", currentVersion: "1.1.0" },
						{ source: "npm:pi-tickets", ok: true, output: "Updated npm:pi-tickets", alreadyUpToDate: true },
					],
				};
			},
		};
		const d = deps({ daemon });
		const { code, out } = await cliRun(["update", "--all", "--approve"], d);
		expect(code).toBe(0);
		expect(calls).toEqual([[undefined, true]]);
		expect(out).toContain("npm:pi-lsp  updated (1.0.0 \u2192 1.1.0)");
		expect(out).toContain("npm:pi-tickets  already up to date");
		expect(out).toContain("Reload Pi with /reload to activate the updated packages.");
		const json = await cliRun(["update", "--all", "--approve", "--json"], d);
		expect(JSON.parse(json.out).results).toHaveLength(2);
	});

	it("update --all reports failures inline with exit code 1, without hiding the packages that did succeed", async () => {
		const daemon = {
			...baseDaemonPort(),
			async updateAll() {
				return {
					ok: false,
					output: "updated 0/1 package(s)",
					results: [{ source: "npm:broken", ok: false, output: "No matching package found" }],
				};
			},
		};
		const d = deps({ daemon });
		const { code, out } = await cliRun(["update", "--all", "--approve"], d);
		expect(code).toBe(1);
		expect(out).toContain("npm:broken  FAILED: No matching package found");
	});

	it("remove wants a bare name and has stable JSON output", async () => {
		const d = deps();
		expect((await cliRun(["remove", "npm:foo"], d)).code).toBe(2);
		const { code } = await cliRun(["remove", "pi-lsp", "--approve"], d);
		expect(code).toBe(0);
		expect((d.inst as FakeInstaller).removed).toBe("npm:pi-lsp");
		expect((d.inst as FakeInstaller).approved).toBe(true);
		const json = await cliRun(["remove", "pi-lsp", "--approve", "--json"], d);
		expect(JSON.parse(json.out)).toEqual({ ok: true, name: "pi-lsp", output: "Removed npm:pi-lsp" });
	});

	it("routes daemon-owned catalog reads and refresh through the authenticated client", async () => {
		const calls: string[] = [];
		const daemon: PackageDaemonPort = {
			async search(query, _limit, offline) {
				calls.push(`search:${offline}`);
				return { query, total: 1, results: [{ name: "pi-daemon", version: "1.0.0" }] };
			},
			async info(name) {
				return { name, version: "1.0.0" };
			},
			async installed() {
				calls.push("installed");
				return [{ name: "pi-daemon", pinned: "1.0.0" }];
			},
			async catalog() {
				calls.push("catalog");
				return { fetchedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64), packages: [{ name: "pi-daemon", version: "1.0.0" }] };
			},
			async mirror() {
				calls.push("mirror");
				return 1;
			},
			async index() {
				calls.push("index");
				return {
					generatedAt: "2026-01-01T00:00:00.000Z",
					packages: [{ name: "pi-daemon", version: "1.0.0", dimensions: {} as never }],
					truncated: false,
				};
			},
			async indexBuild() {
				calls.push("indexBuild");
				return {
					generatedAt: "2026-01-01T00:00:00.000Z",
					packages: [{ name: "pi-daemon", version: "1.0.0", dimensions: {} as never }],
					truncated: false,
				};
			},
			async updates() {
				calls.push("updates");
				return [{ name: "pi-daemon", installed: "1.0.0", latest: "1.1.0", detectedAt: "2026-01-01T00:00:00.000Z" }];
			},
			async check(path, smoke) {
				calls.push(`check:${path}:${smoke}`);
				return { root: path, ok: true, diagnostics: [], summary: { errors: 0, warnings: 0, info: 0 }, checkedFiles: 1, truncated: false };
			},
			async pack(path) {
				calls.push(`pack:${path}`);
				return {
					root: path,
					ok: true,
					command: ["npm", "pack"],
					files: [],
					shape: { kind: "manifest", verified: true, evidence: [] },
					diagnostics: [],
					truncated: false,
				};
			},
			async score(target) {
				calls.push(`score:${target}`);
				return {
					target,
					source: "registry",
					package: { name: target, version: "1" },
					dimensions: {
						discoverability: { status: "ready", met: 1, total: 1, evidence: [], actions: [] },
						firstRun: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
						trust: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
						maintenance: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
						traction: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
						compatibility: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
						freshness: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] },
					},
				};
			},
			async setupExport(projectRoot, force) {
				calls.push(`setupExport:${projectRoot}:${force}`);
				return {
					ok: true,
					path: `${projectRoot}/pi-setup.json`,
					manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
					diagnostics: [],
					wrote: true,
				};
			},
			async setupUpdate(manifestPath) {
				calls.push(`setupUpdate:${manifestPath}`);
				return {
					ok: true,
					path: manifestPath,
					manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
					diagnostics: [],
					wrote: true,
					updated: 0,
				};
			},
			async setupPlan(manifestPath) {
				calls.push(`setupPlan:${manifestPath}`);
				return { ok: true, manifestPath, operations: [], diagnostics: [] };
			},
			async setupApply(manifestPath, approved) {
				calls.push(`setupApply:${manifestPath}:${approved}`);
				return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] };
			},
			async security() {
				return { mutationApproval: "always" };
			},
			async setMutationApproval(mutationApproval) {
				return { mutationApproval };
			},
			async install(source) {
				return source;
			},
			async installService(source) {
				calls.push(`installService:${source}`);
				return {
					output: source,
					spec: {
						name: "probe",
						version: "1.0.0",
						binPath: "/opt/probe/cli.js",
						handlePath: "/tmp/probe.handle.json",
					},
				};
			},
			async restartService(source) {
				calls.push(`restartService:${source}`);
				return {
					output: source,
					restarted: true,
					spec: {
						name: "probe",
						version: "1.0.0",
						binPath: "/opt/probe/cli.js",
						handlePath: "/tmp/probe.handle.json",
					},
				};
			},
			async remove(name) {
				return name;
			},
			async reconcileServices(approved, projectRoot) {
				calls.push(`reconcileServices:${approved}:${projectRoot}`);
				return {
					ok: true,
					output: "reconciled 0 Vehicle(s), skipped 0 non-daemon package(s)",
					reconciled: [],
					skipped: 0,
					failed: [],
					pruned: [],
					pruneFailed: [],
				};
			},
			async update(source) {
				return { output: source, reloadRequired: false, alreadyUpToDate: true, pinned: false };
			},
			async updateAll(sources) {
				calls.push(`updateAll:${sources?.join(",")}`);
				return { ok: true, output: "updated 0/0 package(s)", results: [] };
			},
			async piStatus() {
				calls.push("piStatus");
				return { current: "0.82.1", latest: "0.83.0", upToDate: false };
			},
			async resourcesList(projectRoot) {
				calls.push(`resourcesList:${projectRoot}`);
				return {
					global: [
						{
							source: "npm:pi-daemon",
							name: "pi-daemon",
							scope: "global" as const,
							extensions: [{ path: "extensions/index.ts", enabled: true }],
							skills: [],
							prompts: [],
							themes: [],
						},
					],
					project: [],
				};
			},
			async resourcesToggle(source, field, path, enabled) {
				calls.push(`resourcesToggle:${source}:${field}:${path}:${enabled}`);
				return `${enabled ? "enabled" : "disabled"} ${path}`;
			},
			async advisoriesScan(name) {
				calls.push(`advisoriesScan:${name}`);
				return { scanned: 1, findings: [], diagnostics: [], truncated: false };
			},
			async doctor(projectRoot) {
				calls.push(`doctor:${projectRoot}`);
				return { ok: true, conflicts: [], extensions: [], scanned: 0, truncated: false, serviceUnits: [], duplicateDependencies: [] };
			},
			async updatesForProject(projectRoot) {
				calls.push(`updatesForProject:${projectRoot}`);
				return [];
			},
		};
		const d = deps({ daemon });
		expect(JSON.parse((await cliRun(["search", "daemon", "--offline", "--json"], d)).out).results[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["installed", "--json"], d)).out)[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["updates", "--json"], d)).out).updates[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["catalog", "--json"], d)).out).packages[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["mirror", "--json"], d)).out).synced).toBe(1);
		expect(JSON.parse((await cliRun(["index", "status", "--json"], d)).out).packages[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["index", "build", "--json"], d)).out).packages[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["check", "/tmp/package", "--smoke", "--json"], d)).out).root).toBe("/tmp/package");
		expect(JSON.parse((await cliRun(["pack", "/tmp/package", "--json"], d)).out).shape.verified).toBe(true);
		expect(JSON.parse((await cliRun(["score", "pi-daemon", "--json"], d)).out).target).toBe("pi-daemon");
		expect((await cliRun(["setup", "export", "/tmp/project", "--force", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "update", "/tmp/project/pi-setup.json", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "plan", "/tmp/project/pi-setup.json", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "apply", "/tmp/project/pi-setup.json", "--approve", "--json"], d)).code).toBe(0);
		expect(JSON.parse((await cliRun(["pi", "status", "--json"], d)).out)).toEqual({ current: "0.82.1", latest: "0.83.0", upToDate: false });
		expect(JSON.parse((await cliRun(["resources", "list", "--json"], d)).out).global[0].name).toBe("pi-daemon");
		expect(
			JSON.parse(
				(await cliRun(["resources", "toggle", "npm:pi-daemon", "extensions", "extensions/index.ts", "off", "--approve", "--json"], d)).out,
			),
		).toMatchObject({ ok: true, enabled: false });
		expect(JSON.parse((await cliRun(["advisories", "--json"], d)).out)).toEqual({
			scanned: 1,
			findings: [],
			diagnostics: [],
			truncated: false,
		});
		expect(JSON.parse((await cliRun(["doctor", "--json"], d)).out)).toEqual({
			ok: true,
			conflicts: [],
			extensions: [],
			scanned: 0,
			truncated: false,
			serviceUnits: [],
			duplicateDependencies: [],
		});
		expect(JSON.parse((await cliRun(["updates", "--project", "/tmp/project", "--json"], d)).out).updates).toEqual([]);
		expect(calls).toEqual([
			"search:true",
			"installed",
			"updates",
			"catalog",
			"mirror",
			"index",
			"indexBuild",
			"check:/tmp/package:true",
			"pack:/tmp/package",
			"score:pi-daemon",
			"setupExport:/tmp/project:true",
			"setupUpdate:/tmp/project/pi-setup.json",
			"setupPlan:/tmp/project/pi-setup.json",
			"setupApply:/tmp/project/pi-setup.json:true",
			"piStatus",
			"resourcesList:undefined",
			"resourcesToggle:npm:pi-daemon:extensions:extensions/index.ts:false",
			"advisoriesScan:undefined",
			"doctor:undefined",
			"updatesForProject:/tmp/project",
		]);
	});

	it("verify-deploy runs standalone without a daemon, reporting stale/missing/shadow locations for a real on-disk layout", async () => {
		const piHome = track(mkdtempSync(join(tmpdir(), "packed-verify-deploy-cli-")));
		const pkgDir = join(piHome, "npm", "node_modules", "@scope", "pkg");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.2.3" }));
		const d = deps({ piHome });

		const jsonResult = await cliRun(["verify-deploy", "@scope/pkg", "--json"], d);
		expect(jsonResult.code).toBe(0);
		const parsed = JSON.parse(jsonResult.out);
		expect(parsed.ok).toBe(true);
		expect(parsed.packageName).toBe("@scope/pkg");
		expect(parsed.expectedVersion).toBe("1.2.3");

		const human = await cliRun(["verify-deploy", "@scope/pkg"], d);
		expect(human.out).toContain("PASS");
		expect(human.code).toBe(0);

		const stale = await cliRun(["verify-deploy", "@scope/pkg", "--version", "9.9.9"], d);
		expect(stale.code).toBe(1);
		expect(stale.out).toContain("FAIL");
		expect(stale.out).toContain("STALE (1.2.3)");

		expect((await cliRun(["verify-deploy", "not a valid name!"], d)).code).toBe(2);
	});

	it("advisories runs standalone without a daemon and degrades to zero findings, never a real network call, when nothing is installed", async () => {
		const d = deps({ piHome: track(mkdtempSync(join(tmpdir(), "packed-advisories-cli-"))) });
		const result = await cliRun(["advisories", "--json"], d);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toEqual({ scanned: 0, findings: [], diagnostics: [], truncated: false });
	});

	it("pi status runs standalone without a daemon, through an injectable check -- never a real subprocess/network call in tests", async () => {
		const d = deps({ piVersion: { check: async () => ({ current: "0.82.1", latest: "0.83.0", upToDate: false }) } });
		const { code, out } = await cliRun(["pi", "status", "--json"], d);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual({ current: "0.82.1", latest: "0.83.0", upToDate: false });
		const human = await cliRun(["pi", "status"], d);
		expect(human.out).toContain("pi 0.82.1 (latest 0.83.0)");
		expect(human.out).toContain("pi update --self");
		expect((await cliRun(["pi", "bogus"], d)).code).toBe(2);
	});

	it("resources list and toggle run standalone without a daemon (CLI parity for the daemon-only resources.list/toggle operations)", async () => {
		const piHome = track(mkdtempSync(join(tmpdir(), "packed-resources-cli-")));
		writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-demo"] }));
		const pkgDir = join(piHome, "npm", "node_modules", "pi-demo");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "pi-demo", version: "1.0.0", pi: { extensions: ["extensions/index.ts"] } }),
		);
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function () {}");
		const d = deps({ piHome });

		const list = await cliRun(["resources", "list", "--json"], d);
		expect(list.code).toBe(0);
		const parsed = JSON.parse(list.out);
		expect(parsed.global[0].extensions).toEqual([{ path: "extensions/index.ts", enabled: true }]);
		const human = await cliRun(["resources", "list"], d);
		expect(human.out).toContain("pi-demo");
		expect(human.out).toContain("extensions/index.ts");

		expect((await cliRun(["resources", "toggle", "npm:pi-demo", "extensions", "extensions/index.ts", "off"], d)).code).toBe(1); // approval required
		const toggled = await cliRun(
			["resources", "toggle", "npm:pi-demo", "extensions", "extensions/index.ts", "off", "--approve", "--json"],
			d,
		);
		expect(JSON.parse(toggled.out)).toMatchObject({ ok: true, enabled: false });
		const after = JSON.parse((await cliRun(["resources", "list", "--json"], d)).out);
		expect(after.global[0].extensions).toEqual([{ path: "extensions/index.ts", enabled: false }]);

		expect((await cliRun(["resources", "toggle", "npm:pi-demo", "bogus-field", "x", "on"], d)).code).toBe(2);
		expect((await cliRun(["resources", "bogus"], d)).code).toBe(2);
	});

	// Same sandbox-availability probe as smoke.test.ts/doctor.test.ts: binary
	// presence alone doesn't prove bwrap actually works under this host's
	// user namespaces.
	const bwrapUsable =
		existsSync("/usr/bin/bwrap") &&
		spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { timeout: 5_000 }).status === 0;
	(bwrapUsable ? it : it.skip)(
		"doctor runs standalone without a daemon and reproduces the jittor incident through the real CLI (CLI parity for the daemon-only doctor.run operation)",
		async () => {
			const piHome = track(mkdtempSync(join(tmpdir(), "packed-doctor-cli-")));
			writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-papyrus"] }));
			const globalPkg = join(piHome, "npm", "node_modules", "pi-papyrus");
			mkdirSync(join(globalPkg, "extension"), { recursive: true });
			writeFileSync(
				join(globalPkg, "package.json"),
				JSON.stringify({ name: "pi-papyrus", version: "1.0.0", pi: { extensions: ["extension/index.ts"] } }),
			);
			writeFileSync(join(globalPkg, "extension", "index.ts"), 'export default function (pi: any) { pi.registerTool({ name: "tasks" }); }');
			const projectRoot = track(mkdtempSync(join(tmpdir(), "packed-doctor-cli-project-")));
			const projectHome = join(projectRoot, ".pi");
			mkdirSync(projectHome, { recursive: true });
			writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:papyrus"] }));
			const projectPkg = join(projectHome, "npm", "node_modules", "papyrus");
			mkdirSync(join(projectPkg, "extension"), { recursive: true });
			writeFileSync(
				join(projectPkg, "package.json"),
				JSON.stringify({ name: "papyrus", version: "1.0.0", pi: { extensions: ["extension/index.ts"] } }),
			);
			writeFileSync(join(projectPkg, "extension", "index.ts"), 'export default function (pi: any) { pi.registerTool({ name: "tasks" }); }');
			const d = deps({ piHome });

			const clean = await cliRun(["doctor", "--json"], d);
			expect(clean.code, clean.out).toBe(0);
			expect(JSON.parse(clean.out)).toMatchObject({ ok: true, conflicts: [] });

			const withProject = await cliRun(["doctor", "--project", projectRoot, "--json"], d);
			expect(withProject.code).toBe(1);
			const report = JSON.parse(withProject.out);
			expect(report.ok).toBe(false);
			expect(report.conflicts).toHaveLength(1);
			expect(report.conflicts[0]).toMatchObject({ kind: "tool", name: "tasks" });
			const human = await cliRun(["doctor", "--project", projectRoot], d);
			expect(human.out).toContain('CONFLICT tool "tasks"');
		},
	);

	it("version reports just the installed version when no daemon is reachable", async () => {
		const { code, out } = await cliRun(["version", "--json"], deps({ daemonVersionCheck: async () => undefined }));
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual({ installed: VERSION });
	});

	it("version reports a matching daemon as up to date", async () => {
		const { out } = await cliRun(["version", "--json"], deps({ daemonVersionCheck: async () => VERSION }));
		expect(JSON.parse(out)).toEqual({ installed: VERSION, daemon: { version: VERSION, stale: false } });
	});

	it("version flags a stale daemon clearly, with a concrete restart suggestion, human-readable", async () => {
		const { out } = await cliRun(["version"], deps({ daemonVersionCheck: async () => "0.0.1" }));
		expect(out).toContain("STALE");
		expect(out).toContain("0.0.1");
		expect(out).toContain("systemctl --user restart pi-packed.service");
	});

	it("unknown command → usage, code 2", async () => {
		const { code, out } = await cliRun(["frobnicate"], deps());
		expect(code).toBe(2);
		expect(out).toContain("usage");
	});
});

describe("daemon client", () => {
	let server: Server<undefined>;
	let daemonDir: string;
	let daemonPiHome: string;
	let daemonPaths: PackedPaths;
	let daemonInstaller: FakeInstaller;
	const daemonToken = "d".repeat(64);

	beforeAll(async () => {
		daemonDir = mkdtempSync(join(tmpdir(), "packed-daemon-"));
		daemonPiHome = mkdtempSync(join(tmpdir(), "packed-daemon-pi-"));
		daemonPaths = resolvePackedPaths({ env: { PI_PACKED_HOME: daemonDir } });
		writeFileSync(daemonPaths.token, `${daemonToken}\n`);
		daemonInstaller = new FakeInstaller();
		const app = createApp({
			reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]),
			inst: daemonInstaller,
			daemonServiceInstaller: {
				async install() {
					return {
						ok: true,
						result: { installed: true },
						spec: { name: "pi-lsp", version: "1.0.0", binPath: "/opt/pi-lsp/cli.js", handlePath: "/tmp/pi-lsp.handle.json" },
					};
				},
				async remove() {
					return {
						ok: true,
						result: { installed: true },
						spec: { name: "pi-lsp", version: "1.0.0", binPath: "/opt/pi-lsp/cli.js", handlePath: "/tmp/pi-lsp.handle.json" },
					};
				},
				async restart() {
					return {
						ok: true,
						restarted: true,
						spec: { name: "pi-lsp", version: "1.0.0", binPath: "/opt/pi-lsp/cli.js", handlePath: "/tmp/pi-lsp.handle.json" },
					};
				},
				async listRegisteredVehicles() {
					return [];
				},
				async unregisterVehicleByName() {
					return { ok: true, manifestHash: "hash" as never, applied: [], diagnostics: [] };
				},
			},
			token: daemonToken,
			stateDir: daemonDir,
			piHome: daemonPiHome,
			packer: {
				async verify(path) {
					return {
						root: path,
						ok: true,
						command: ["npm", "pack"],
						files: [],
						shape: { kind: "manifest", verified: true, evidence: ["pi.extensions"] },
						diagnostics: [],
						truncated: false,
					};
				},
			},
			scorer: {
				async score(target) {
					const empty = { status: "unknown" as const, met: 0, total: 0, evidence: [], actions: [] };
					return {
						target,
						source: "registry" as const,
						package: { name: target, version: "1" },
						dimensions: {
							discoverability: empty,
							firstRun: empty,
							trust: empty,
							maintenance: empty,
							traction: empty,
							compatibility: empty,
							freshness: empty,
						},
					};
				},
			},
			setup: {
				async export(projectRoot) {
					return {
						ok: true,
						path: `${projectRoot}/pi-setup.json`,
						manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
						diagnostics: [],
						wrote: true,
					};
				},
				async update(manifestPath) {
					return {
						ok: true,
						path: manifestPath,
						manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} },
						diagnostics: [],
						wrote: true,
						updated: 0,
					};
				},
				async plan(manifestPath) {
					return { ok: true, manifestPath, operations: [], diagnostics: [] };
				},
				async apply(manifestPath) {
					return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] };
				},
			},
			piVersion: {
				async check() {
					return { current: "0.82.1", latest: "0.83.0", upToDate: false };
				},
			},
		});
		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
		writeDaemonHandle(daemonPaths.handle, { host: "127.0.0.1", port: server.port!, pid: process.pid });
	});
	afterAll(() => {
		server.stop(true);
		rmSync(daemonDir, { recursive: true, force: true });
		rmSync(daemonPiHome, { recursive: true, force: true });
	});

	it("probe finds a live daemon", async () => {
		const found = await probe(daemonPaths);
		expect(found).toBeDefined();
		expect(found?.token).toBe(daemonToken);
	});

	// Real bug, diagnosed live: a daemon process can run for hours holding
	// stale in-memory code while its own source/package.json moves on --
	// ps+git-log correlation was the only way to notice. probe() surfacing
	// the daemon's own live-reported version (from its real /health
	// endpoint, not a guess) is the durable, scriptable replacement for that.
	it("probe reports the live daemon's own real version from its /health endpoint", async () => {
		const found = await probe(daemonPaths);
		expect(found?.version).toBe(VERSION); // this test daemon runs the current on-disk code
	});

	it("probe rejects dead state", async () => {
		const directory = track(mkdtempSync(join(tmpdir(), "packed-")));
		expect(await probe(resolvePackedPaths({ env: { PI_PACKED_HOME: directory } }))).toBeUndefined();
	});

	it("DaemonRegistry proxies search/info over HTTP with auth", async () => {
		const found = (await probe(daemonPaths))!;
		const reg = new DaemonRegistry(found.base, found.token);
		const { results } = await reg.search("keywords:pi-package lsp", 10);
		expect(results[0]?.name).toBe("pi-lsp");
		const info = await reg.info("pi-lsp");
		expect(info.name).toBe("pi-lsp");
	});

	it("PackageDaemonClient exposes authenticated install, remove, and package reads", async () => {
		const found = (await probe(daemonPaths))!;
		const client = new PackageDaemonClient(found.base, found.token);
		expect((await client.search("lsp", 10)).results[0]?.name).toBe("pi-lsp");
		expect((await client.info("pi-lsp")).version).toBe("1.0.0");
		expect(await client.installed()).toEqual([]);
		expect((await client.catalog()).packages).toEqual([]);
		expect(await client.index()).toBeUndefined(); // nothing generated yet
		const built = await client.indexBuild();
		expect(built.packages).toEqual([]); // empty catalog in this fixture daemon -- proves the RPC round-trips a real PackageIndex shape
		expect(typeof built.generatedAt).toBe("string");
		expect(await client.index()).toEqual(built); // now persisted, readable back through the same RPC
		expect(await client.updates()).toEqual([]);
		const checkRoot = new URL("../..", import.meta.url).pathname;
		expect((await client.check(checkRoot)).root).toBe(checkRoot.replace(/\/$/, ""));
		expect((await client.check(checkRoot, true)).smoke?.extensions.length).toBeGreaterThan(0);
		expect((await client.pack(checkRoot)).shape.verified).toBe(true);
		expect((await client.score("pi-lsp")).target).toBe("pi-lsp");
		expect((await client.setupExport(checkRoot)).wrote).toBe(true);
		expect((await client.setupUpdate(`${checkRoot}/pi-setup.json`)).updated).toBe(0);
		expect((await client.setupPlan(`${checkRoot}/pi-setup.json`)).ok).toBe(true);
		await expect(client.setupApply(`${checkRoot}/pi-setup.json`)).rejects.toThrow("approval required");
		expect((await client.setupApply(`${checkRoot}/pi-setup.json`, true)).ok).toBe(true);
		expect(await client.security()).toEqual({ mutationApproval: "always" });
		await expect(client.install("npm:pi-lsp")).rejects.toThrow("approval required");
		expect(await client.install("npm:pi-lsp", true)).toBe("Installed npm:pi-lsp\ninstalled persistent Vehicle pi-lsp");
		await expect(client.installService("npm:pi-lsp")).rejects.toThrow("approval required");
		expect(await client.installService("npm:pi-lsp", true)).toEqual({
			output: "installed a persistent service for pi-lsp",
			spec: { name: "pi-lsp", binPath: "/opt/pi-lsp/cli.js" },
		});
		expect(await client.remove("pi-lsp", true)).toBe("Removed npm:pi-lsp");
		expect(await client.piStatus()).toEqual({ current: "0.82.1", latest: "0.83.0", upToDate: false });
		expect(await client.update("npm:pi-lsp", true)).toEqual({
			output: "Updated npm:pi-lsp",
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
			previousVersion: undefined,
			currentVersion: undefined,
		});
		const installer = new PackageDaemonInstaller(client);
		expect(await installer.install("npm:pi-lsp@1.0.0", { approved: true })).toBe(
			"Installed npm:pi-lsp@1.0.0\ninstalled persistent Vehicle pi-lsp",
		);
		expect(await installer.remove("npm:pi-lsp", { approved: true })).toBe("Removed npm:pi-lsp");
		expect((await installer.update("npm:pi-lsp", { approved: true })).output).toBe("Updated npm:pi-lsp");
		expect(await client.setMutationApproval("never", true)).toEqual({ mutationApproval: "never" });
		expect(daemonInstaller.gotSource).toBe("npm:pi-lsp@1.0.0");
		expect(daemonInstaller.removed).toBe("npm:pi-lsp");

		daemonInstaller.fail = true;
		await expect(client.install("npm:missing")).rejects.toThrow("installer failed");
		daemonInstaller.fail = false;
	});

	it("resolveRegistry prefers daemon, falls back direct", async () => {
		const viaDaemon = await resolveRegistry(daemonPaths, "https://registry.npmjs.org");
		expect(viaDaemon).toBeInstanceOf(DaemonRegistry);
		const directory = track(mkdtempSync(join(tmpdir(), "packed-")));
		const direct = await resolveRegistry(resolvePackedPaths({ env: { PI_PACKED_HOME: directory } }), "https://registry.npmjs.org");
		expect(direct).toBeInstanceOf(HttpRegistry);
	});
});

describe("packed service (systemd unit)", () => {
	// Delegates to vehicle-server's shared generateSystemdUnit (see cli.ts's renderUnit) --
	// ExecStart is now shell-quoted per argument, and Restart=on-failure became Restart=always
	// (vehicle-server's restartOnFailure only supports "always" -- an intentional, documented
	// tightening: Packed's own client never auto-spawns, so systemd is its only recovery path
	// regardless of whether the prior exit was clean or a crash).
	it("renders a user unit with runtime paths and idle disabled", async () => {
		const d = deps({ execPath: "/usr/bin/bun", cliPath: "/opt/pi-packed/src/cli.ts", piBin: "/home/x/.cache/.bun/bin/pi" });
		const { code, out } = await cliRun(["service"], d);
		expect(code).toBe(0);
		expect(out).toContain("[Service]");
		expect(out).toContain('ExecStart="/usr/bin/bun" "/opt/pi-packed/src/cli.ts" "serve"');
		expect(out).toContain("Restart=always");
		expect(out).toContain("RestartSec=2");
		expect(out).toContain("NoNewPrivileges=true");
		expect(out).toContain('Environment="PI_PACKED_IDLE_SECS=0"');
		expect(out).toContain('Environment="PI_BIN=/home/x/.cache/.bun/bin/pi"');
		expect(out).toContain("WantedBy=default.target");
	});
});
