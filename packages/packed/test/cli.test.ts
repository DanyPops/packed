import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliRun, type CliDeps } from "../src/cli.ts";
import { DaemonRegistry, PackageDaemonClient, PackageDaemonInstaller, probe, resolveRegistry, type PackageDaemonPort } from "../src/client.ts";
import { writeDaemonHandle } from "@danypops/daemon-kit/paths";
import { resolvePackedPaths, type PackedPaths } from "../src/paths.ts";
import { createApp } from "../src/service.ts";
import { saveUpdates } from "../src/watcher.ts";
import { openDb, replaceAll, dbPath, catalogList } from "../src/db.ts";
import { HttpRegistry } from "../src/registry.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/ports.ts";
import type { Server } from "bun";

class FakeRegistry implements Registry {
	constructor(private results: Pkg[] = [], private versions: Record<string, string> = {}) {}
	async search(_q: string, _limit: number): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.results.length };
	}
	async searchAll(): Promise<import("../src/ports.ts").Pkg[]> {
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
	async update(source: string, options?: { approved?: boolean }): Promise<UpdateOutcome> {
		this.updated = source;
		this.approved = options?.approved === true;
		return {
			output: `Updated ${source}`,
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
			...this.updateOutcome,
		};
	}
}

function deps(over: Partial<CliDeps> = {}): CliDeps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		security: {
			async security() { return { mutationApproval: "always" as const }; },
			async setMutationApproval(mutationApproval) { return { mutationApproval }; },
		},
		stateDir: mkdtempSync(join(tmpdir(), "packed-")),
		piHome: mkdtempSync(join(tmpdir(), "packed-pihome-")),
		...over,
	};
}

describe("CLI", () => {
	it("publishes an executable packed binary", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin?: Record<string, string> };
		expect(manifest.bin).toEqual({ packed: "src/cli.ts" });
		expect(readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
	});

	it("security reads and writes stable JSON through the daemon port", async () => {
		let mutationApproval: "always" | "never" = "always";
		const d = deps({
			security: {
				async security() { return { mutationApproval }; },
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
				async security(): Promise<never> { throw new Error("daemon unavailable"); },
				async setMutationApproval(): Promise<never> { throw new Error("daemon unavailable"); },
			},
		});
		const root = new URL("..", import.meta.url).pathname;
		const result = await cliRun(["check", root, "--json"], d);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.out).diagnostics.some((item: { code: string }) => item.code === "PI_NO_RESOURCES")).toBe(true);
		expect(JSON.parse(result.out).root).toBe(root.replace(/\/$/, ""));
	});

	it("packs and scores standalone through bounded application ports", async () => {
		const empty = { status: "unknown" as const, met: 0, total: 0, evidence: [], actions: [] };
		const d = deps({
			packer: { async verify(path) { return { root: path, ok: true, command: ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], files: [], shape: { kind: "manifest", verified: true, evidence: ["pi.extensions"] }, diagnostics: [], truncated: false }; } },
			scorer: { async score(target) { return { target, source: "registry" as const, package: { name: target, version: "1" }, dimensions: { discoverability: empty, firstRun: empty, trust: empty, maintenance: empty, traction: empty } }; } },
		});
		expect(JSON.parse((await cliRun(["pack", ".", "--json"], d)).out).shape.verified).toBe(true);
		expect(JSON.parse((await cliRun(["score", "pi-demo", "--json"], d)).out).target).toBe("pi-demo");
	});

	it("generates and checks staged-publish workflows without agent-callable publishing", async () => {
		const calls: string[] = [];
		const d = deps({ publisher: {
			async setup(path, options) { calls.push(`setup:${path}:${options?.force}`); return { root: path, ok: true, wrote: true, workflowPath: `${path}/.github/workflows/packed-stage-publish.yml`, packageName: "pi-demo", repository: "example/pi-demo", diagnostics: [] }; },
			async status(path) { calls.push(`status:${path}`); return { root: path, ready: true, workflowPath: `${path}/.github/workflows/packed-stage-publish.yml`, checks: { packageExists: true, repository: true, workflow: true, lockfile: true, node: true, npm: true, trustedPublisher: "unknown", coreFirst: true }, diagnostics: [], nextSteps: [] }; },
		} });
		const root = resolve(".");
		expect(JSON.parse((await cliRun(["publish", "setup", ".", "--force", "--json"], d)).out).wrote).toBe(true);
		expect(JSON.parse((await cliRun(["publish", "status", ".", "--json"], d)).out).ready).toBe(true);
		expect(calls).toEqual([`setup:${root}:true`, `status:${root}`]);
		expect((await cliRun(["publish", "approve"], d)).code).toBe(2);
	});

	it("exports, plans, and approval-gates setup apply standalone", async () => {
		const calls: string[] = [];
		const d = deps({ setup: {
			async export(projectRoot, options) { calls.push(`export:${projectRoot}:${options?.force}`); return { ok: true, path: `${projectRoot}/pi-setup.json`, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true }; },
			async update(manifestPath) { calls.push(`update:${manifestPath}`); return { ok: true, path: manifestPath, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true, updated: 0 }; },
			async plan(manifestPath) { calls.push(`plan:${manifestPath}`); return { ok: true, manifestPath, operations: [], diagnostics: [] }; },
			async apply(manifestPath) { calls.push(`apply:${manifestPath}`); return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] }; },
		} });
		const root = resolve(".");
		expect((await cliRun(["setup", "export", ".", "--force", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "update", ".", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "plan", ".", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "apply", ".", "--json"], d)).code).toBe(1);
		expect((await cliRun(["setup", "apply", ".", "--approve", "--json"], d)).code).toBe(0);
		expect(calls).toEqual([`export:${root}:true`, `update:${root}`, `plan:${root}`, `apply:${root}`]);
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
			async search(query, _limit, offline) { calls.push(`search:${offline}`); return { query, total: 1, results: [{ name: "pi-daemon", version: "1.0.0" }] }; },
			async info(name) { return { name, version: "1.0.0" }; },
			async installed() { calls.push("installed"); return [{ name: "pi-daemon", pinned: "1.0.0" }]; },
			async catalog() { calls.push("catalog"); return { fetchedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64), packages: [{ name: "pi-daemon", version: "1.0.0" }] }; },
			async mirror() { calls.push("mirror"); return 1; },
			async updates() { calls.push("updates"); return [{ name: "pi-daemon", installed: "1.0.0", latest: "1.1.0", detectedAt: "2026-01-01T00:00:00.000Z" }]; },
			async check(path, smoke) { calls.push(`check:${path}:${smoke}`); return { root: path, ok: true, diagnostics: [], summary: { errors: 0, warnings: 0, info: 0 }, checkedFiles: 1, truncated: false }; },
			async pack(path) { calls.push(`pack:${path}`); return { root: path, ok: true, command: ["npm", "pack"], files: [], shape: { kind: "manifest", verified: true, evidence: [] }, diagnostics: [], truncated: false }; },
			async score(target) { calls.push(`score:${target}`); return { target, source: "registry", package: { name: target, version: "1" }, dimensions: { discoverability: { status: "ready", met: 1, total: 1, evidence: [], actions: [] }, firstRun: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] }, trust: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] }, maintenance: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] }, traction: { status: "unknown", met: 0, total: 0, evidence: [], actions: [] } } }; },
			async setupExport(projectRoot, force) { calls.push(`setupExport:${projectRoot}:${force}`); return { ok: true, path: `${projectRoot}/pi-setup.json`, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true }; },
			async setupUpdate(manifestPath) { calls.push(`setupUpdate:${manifestPath}`); return { ok: true, path: manifestPath, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true, updated: 0 }; },
			async setupPlan(manifestPath) { calls.push(`setupPlan:${manifestPath}`); return { ok: true, manifestPath, operations: [], diagnostics: [] }; },
			async setupApply(manifestPath, approved) { calls.push(`setupApply:${manifestPath}:${approved}`); return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] }; },
			async security() { return { mutationApproval: "always" }; },
			async setMutationApproval(mutationApproval) { return { mutationApproval }; },
			async install(source) { return source; },
			async remove(name) { return name; },
			async update(source) { return { output: source, reloadRequired: false, alreadyUpToDate: true, pinned: false }; },
		};
		const d = deps({ daemon });
		expect(JSON.parse((await cliRun(["search", "daemon", "--offline", "--json"], d)).out).results[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["installed", "--json"], d)).out)[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["updates", "--json"], d)).out).updates[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["catalog", "--json"], d)).out).packages[0].name).toBe("pi-daemon");
		expect(JSON.parse((await cliRun(["mirror", "--json"], d)).out).synced).toBe(1);
		expect(JSON.parse((await cliRun(["check", "/tmp/package", "--smoke", "--json"], d)).out).root).toBe("/tmp/package");
		expect(JSON.parse((await cliRun(["pack", "/tmp/package", "--json"], d)).out).shape.verified).toBe(true);
		expect(JSON.parse((await cliRun(["score", "pi-daemon", "--json"], d)).out).target).toBe("pi-daemon");
		expect((await cliRun(["setup", "export", "/tmp/project", "--force", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "update", "/tmp/project/pi-setup.json", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "plan", "/tmp/project/pi-setup.json", "--json"], d)).code).toBe(0);
		expect((await cliRun(["setup", "apply", "/tmp/project/pi-setup.json", "--approve", "--json"], d)).code).toBe(0);
		expect(calls).toEqual(["search:true", "installed", "updates", "catalog", "mirror", "check:/tmp/package:true", "pack:/tmp/package", "score:pi-daemon", "setupExport:/tmp/project:true", "setupUpdate:/tmp/project/pi-setup.json", "setupPlan:/tmp/project/pi-setup.json", "setupApply:/tmp/project/pi-setup.json:true"]);
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
	let daemonPaths: PackedPaths;
	let daemonInstaller: FakeInstaller;
	const daemonToken = "d".repeat(64);

	beforeAll(async () => {
		daemonDir = mkdtempSync(join(tmpdir(), "packed-daemon-"));
		daemonPaths = resolvePackedPaths({ env: { PI_PACKED_HOME: daemonDir } });
		writeFileSync(daemonPaths.token, `${daemonToken}\n`);
		daemonInstaller = new FakeInstaller();
		const app = createApp({
			reg: new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }]),
			inst: daemonInstaller,
			token: daemonToken,
			stateDir: daemonDir,
			piHome: mkdtempSync(join(tmpdir(), "packed-daemon-pi-")),
			packer: { async verify(path) { return { root: path, ok: true, command: ["npm", "pack"], files: [], shape: { kind: "manifest", verified: true, evidence: ["pi.extensions"] }, diagnostics: [], truncated: false }; } },
			scorer: { async score(target) { const empty = { status: "unknown" as const, met: 0, total: 0, evidence: [], actions: [] }; return { target, source: "registry" as const, package: { name: target, version: "1" }, dimensions: { discoverability: empty, firstRun: empty, trust: empty, maintenance: empty, traction: empty } }; } },
			setup: {
				async export(projectRoot) { return { ok: true, path: `${projectRoot}/pi-setup.json`, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true }; },
				async update(manifestPath) { return { ok: true, path: manifestPath, manifest: { $schema: "./schema/pi-setup-v1.schema.json", schemaVersion: 1, packages: [], profiles: {} }, diagnostics: [], wrote: true, updated: 0 }; },
				async plan(manifestPath) { return { ok: true, manifestPath, operations: [], diagnostics: [] }; },
				async apply(manifestPath) { return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] }; },
			},
		});
		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
		writeDaemonHandle(daemonPaths.handle, { host: "127.0.0.1", port: server.port!, pid: process.pid });
	});
	afterAll(() => server.stop(true));

	it("probe finds a live daemon", async () => {
		const found = await probe(daemonPaths);
		expect(found).toBeDefined();
		expect(found?.token).toBe(daemonToken);
	});

	it("probe rejects dead state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "packed-"));
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
		expect(await client.updates()).toEqual([]);
		const checkRoot = new URL("..", import.meta.url).pathname;
		expect((await client.check(checkRoot)).root).toBe(checkRoot.replace(/\/$/, ""));
		expect((await client.check(checkRoot, true)).smoke?.extensions).toEqual([]);
		expect((await client.pack(checkRoot)).shape.verified).toBe(true);
		expect((await client.score("pi-lsp")).target).toBe("pi-lsp");
		expect((await client.setupExport(checkRoot)).wrote).toBe(true);
		expect((await client.setupUpdate(`${checkRoot}/pi-setup.json`)).updated).toBe(0);
		expect((await client.setupPlan(`${checkRoot}/pi-setup.json`)).ok).toBe(true);
		await expect(client.setupApply(`${checkRoot}/pi-setup.json`)).rejects.toThrow("approval required");
		expect((await client.setupApply(`${checkRoot}/pi-setup.json`, true)).ok).toBe(true);
		expect(await client.security()).toEqual({ mutationApproval: "always" });
		await expect(client.install("npm:pi-lsp")).rejects.toThrow("approval required");
		expect(await client.install("npm:pi-lsp", true)).toBe("Installed npm:pi-lsp");
		expect(await client.remove("pi-lsp", true)).toBe("Removed npm:pi-lsp");
		expect(await client.update("npm:pi-lsp", true)).toEqual({
			output: "Updated npm:pi-lsp",
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
			previousVersion: undefined,
			currentVersion: undefined,
		});
		const installer = new PackageDaemonInstaller(client);
		expect(await installer.install("npm:pi-lsp@1.0.0", { approved: true })).toBe("Installed npm:pi-lsp@1.0.0");
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
		const directory = mkdtempSync(join(tmpdir(), "packed-"));
		const direct = await resolveRegistry(resolvePackedPaths({ env: { PI_PACKED_HOME: directory } }), "https://registry.npmjs.org");
		expect(direct).toBeInstanceOf(HttpRegistry);
	});
});

describe("packed service (systemd unit)", () => {
	it("renders a user unit with runtime paths and idle disabled", async () => {
		const d = deps({ execPath: "/usr/bin/bun", cliPath: "/opt/pi-packed/src/cli.ts", piBin: "/home/x/.cache/.bun/bin/pi" });
		const { code, out } = await cliRun(["service"], d);
		expect(code).toBe(0);
		expect(out).toContain("[Service]");
		expect(out).toContain("ExecStart=/usr/bin/bun /opt/pi-packed/src/cli.ts serve");
		expect(out).toContain("Restart=on-failure");
		expect(out).toContain("PI_PACKED_IDLE_SECS=0");
		expect(out).toContain("Environment=PI_BIN=/home/x/.cache/.bun/bin/pi");
		expect(out).toContain("WantedBy=default.target");
	});
});
