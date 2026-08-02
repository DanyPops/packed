import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import type { Server } from "bun";
import { fetchBulkAdvisories, PATCHED_VERSION_FRESH_DAYS, scanInstalledPackages } from "../src/adoption/advisories.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/packages/package.ts";

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
	async update(): Promise<UpdateOutcome> {
		return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false };
	}
}

let server: Server<undefined> | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("fetchBulkAdvisories", () => {
	it("parses a real bulk-endpoint response shape (confirmed against npm/cli's own fixture)", async () => {
		server = Bun.serve({
			port: 0,
			fetch: (req) => {
				if (req.method === "POST" && new URL(req.url).pathname === "/-/npm/v1/security/advisories/bulk") {
					return Response.json({
						handlebars: [
							{
								id: 755,
								url: "https://npmjs.com/advisories/755",
								title: "Prototype Pollution",
								severity: "critical",
								vulnerable_versions: "<=4.0.13 || >=4.1.0 <4.1.2",
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		const result = await fetchBulkAdvisories({ handlebars: ["4.0.5"] }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(result).toEqual({
			handlebars: [
				{
					id: 755,
					url: "https://npmjs.com/advisories/755",
					title: "Prototype Pollution",
					severity: "critical",
					vulnerableVersions: "<=4.0.13 || >=4.1.0 <4.1.2",
				},
			],
		});
	});

	it("never makes a network call for an empty package set", async () => {
		server = Bun.serve({
			port: 0,
			fetch: () => {
				throw new Error("must never be called");
			},
		});
		expect(await fetchBulkAdvisories({}, { registryBase: `http://127.0.0.1:${server.port}` })).toEqual({});
	});

	it("resolves to {} on a non-2xx response, never throws", async () => {
		server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
		expect(await fetchBulkAdvisories({ foo: ["1.0.0"] }, { registryBase: `http://127.0.0.1:${server.port}` })).toEqual({});
	});

	it("resolves to {} on a malformed body, never throws", async () => {
		server = Bun.serve({ port: 0, fetch: () => new Response("not json") });
		expect(await fetchBulkAdvisories({ foo: ["1.0.0"] }, { registryBase: `http://127.0.0.1:${server.port}` })).toEqual({});
	});

	it("resolves to {} on an unreachable host, never throws or hangs", async () => {
		expect(await fetchBulkAdvisories({ foo: ["1.0.0"] }, { registryBase: "http://127.0.0.1:1", timeoutMs: 500 })).toEqual({});
	});

	it("defaults an unrecognized severity to high rather than dropping the advisory", async () => {
		server = Bun.serve({ port: 0, fetch: () => Response.json({ foo: [{ id: 1, url: "u", title: "t", vulnerable_versions: "*" }] }) });
		const result = await fetchBulkAdvisories({ foo: ["1.0.0"] }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(result.foo?.[0]?.severity).toBe("high");
	});
});

describe("scanInstalledPackages", () => {
	function fixtureServer(handlers: { bulk?: unknown; packument?: (name: string) => unknown }): Server<undefined> {
		return Bun.serve({
			port: 0,
			fetch: (req) => {
				const url = new URL(req.url);
				if (req.method === "POST" && url.pathname === "/-/npm/v1/security/advisories/bulk") return Response.json(handlers.bulk ?? {});
				const name = decodeURIComponent(url.pathname.slice(1));
				if (handlers.packument) return Response.json(handlers.packument(name));
				return new Response("not found", { status: 404 });
			},
		});
	}

	it("computes patched-version-age as a fresh signal for a very recently published fix", async () => {
		server = fixtureServer({
			bulk: {
				"pi-demo": [
					{ id: 1, url: "https://example.test/1", title: "Prototype Pollution", severity: "high", vulnerable_versions: "<2.0.0" },
				],
			},
			packument: () => ({
				versions: { "1.0.0": {}, "2.0.0": {}, "2.0.1": {} },
				time: { "1.0.0": daysAgo(400), "2.0.0": daysAgo(2), "2.0.1": daysAgo(1) },
			}),
		});
		const report = await scanInstalledPackages({ "pi-demo": "1.0.0" }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(report.findings).toHaveLength(1);
		const finding = report.findings[0]!;
		expect(finding.patchedVersionAge?.version).toBe("2.0.0"); // smallest version outside the vulnerable range
		expect(finding.patchedVersionAge?.fresh).toBe(true);
		expect(finding.patchedVersionAge?.ageDays).toBeLessThan(PATCHED_VERSION_FRESH_DAYS);
	});

	it("reports fresh:false for a fix that has aged past the threshold", async () => {
		// computed once, reused in both the fixture and the assertion -- a
		// wall-clock ISO string recomputed on each side of an async boundary
		// can differ by a millisecond and make an exact-equality assertion
		// flaky under real scheduling, independent of the implementation.
		const publishedAt = daysAgo(365);
		server = fixtureServer({
			bulk: { "pi-demo": [{ id: 1, url: "u", title: "t", severity: "high", vulnerable_versions: "<2.0.0" }] },
			packument: () => ({ versions: { "1.0.0": {}, "2.0.0": {} }, time: { "1.0.0": daysAgo(400), "2.0.0": publishedAt } }),
		});
		const report = await scanInstalledPackages({ "pi-demo": "1.0.0" }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(report.findings[0]!.patchedVersionAge).toEqual({ version: "2.0.0", publishedAt, ageDays: 365, fresh: false });
	});

	it("never guesses a patched version when nothing published escapes the vulnerable range", async () => {
		server = fixtureServer({
			bulk: { "pi-demo": [{ id: 1, url: "u", title: "t", severity: "high", vulnerable_versions: "*" }] },
			packument: () => ({ versions: { "1.0.0": {} }, time: { "1.0.0": daysAgo(10) } }),
		});
		const report = await scanInstalledPackages({ "pi-demo": "1.0.0" }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(report.findings[0]!.patchedVersionAge).toBeUndefined();
		expect(report.diagnostics[0]!.fix).toBeUndefined();
	});

	it("maps advisory severity to diagnostic severity independent of patched-version freshness -- never folds one into the other", async () => {
		server = fixtureServer({
			bulk: {
				"fresh-critical": [{ id: 1, url: "u", title: "t", severity: "critical", vulnerable_versions: "<2.0.0" }],
				"old-critical": [{ id: 2, url: "u", title: "t", severity: "critical", vulnerable_versions: "<2.0.0" }],
			},
			packument: (name) =>
				name === "fresh-critical"
					? { versions: { "1.0.0": {}, "2.0.0": {} }, time: { "1.0.0": daysAgo(400), "2.0.0": daysAgo(1) } }
					: { versions: { "1.0.0": {}, "2.0.0": {} }, time: { "1.0.0": daysAgo(400), "2.0.0": daysAgo(900) } },
		});
		const report = await scanInstalledPackages(
			{ "fresh-critical": "1.0.0", "old-critical": "1.0.0" },
			{ registryBase: `http://127.0.0.1:${server.port}` },
		);
		const fresh = report.diagnostics.find((d) => d.path === "fresh-critical")!;
		const old = report.diagnostics.find((d) => d.path === "old-critical")!;
		expect(fresh.severity).toBe("error");
		expect(old.severity).toBe("error"); // same severity as fresh -- freshness never changes it
		expect(fresh.message).toContain("weaker signal");
		expect(old.message).not.toContain("weaker signal");
	});

	it("maps moderate to warning and low to info", async () => {
		server = fixtureServer({
			bulk: {
				pkga: [{ id: 1, url: "u", title: "t", severity: "moderate", vulnerable_versions: "*" }],
				pkgb: [{ id: 2, url: "u", title: "t", severity: "low", vulnerable_versions: "*" }],
			},
		});
		const report = await scanInstalledPackages({ pkga: "1.0.0", pkgb: "1.0.0" }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(report.diagnostics.find((d) => d.path === "pkga")!.severity).toBe("warning");
		expect(report.diagnostics.find((d) => d.path === "pkgb")!.severity).toBe("info");
	});

	it("reports zero findings for a package with no advisories", async () => {
		server = fixtureServer({ bulk: {} });
		const report = await scanInstalledPackages({ "pi-demo": "1.0.0" }, { registryBase: `http://127.0.0.1:${server.port}` });
		expect(report.findings).toEqual([]);
		expect(report.diagnostics).toEqual([]);
		expect(report.scanned).toBe(1);
	});

	it("never executes package code -- scanning is pure metadata comparison", async () => {
		// no eval/require/child_process anywhere in the module; structural
		// guarantee, not just an assertion about this one test run
		const source = await Bun.file(new URL("../src/adoption/advisories.ts", import.meta.url)).text();
		expect(source).not.toMatch(/\brequire\(|child_process|Bun\.spawn|eval\(/);
	});
});

describe("advisories.scan operation (real daemon route)", () => {
	it("resolves real installed npm packages' on-disk versions and routes through the authenticated operation registry", async () => {
		const piHome = mkdtempSync(join(tmpdir(), "packed-advisories-daemon-"));
		writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-vuln"] }));
		const pkgDir = join(piHome, "npm", "node_modules", "pi-vuln");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pi-vuln", version: "1.0.0" }));

		let receivedInstalled: Record<string, string> | undefined;
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: mkdtempSync(join(tmpdir(), "packed-advisories-state-")),
			dataDir: mkdtempSync(join(tmpdir(), "packed-advisories-data-")),
			piHome,
			// injected exactly like pi.status's piVersion seam -- never a real
			// network call to the live npm registry from an automated test.
			advisories: {
				async scan(installed) {
					receivedInstalled = installed;
					return { scanned: Object.keys(installed).length, findings: [], diagnostics: [], truncated: false };
				},
			},
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});
		expect(await client.operations()).toContain("advisories.scan");
		const report = await client.call("advisories.scan", {});
		expect(report.scanned).toBe(1);
		expect(receivedInstalled).toEqual({ "pi-vuln": "1.0.0" }); // real on-disk resolution, not a guess
	});

	it("is unguarded read access -- never requires approval", async () => {
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: mkdtempSync(join(tmpdir(), "packed-advisories-state-")),
			dataDir: mkdtempSync(join(tmpdir(), "packed-advisories-data-")),
			piHome: mkdtempSync(join(tmpdir(), "packed-advisories-pihome-")),
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});
		expect(await client.call("advisories.scan", {})).toEqual({ scanned: 0, findings: [], diagnostics: [], truncated: false });
	});

	it("rejects an oversized name argument rather than passing it through", async () => {
		const app = createApp({
			reg: new NoopRegistry(),
			inst: new NoopInstaller(),
			token: "test-token",
			stateDir: mkdtempSync(join(tmpdir(), "packed-advisories-state-")),
			dataDir: mkdtempSync(join(tmpdir(), "packed-advisories-data-")),
			piHome: mkdtempSync(join(tmpdir(), "packed-advisories-pihome-")),
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});
		await expect(client.call("advisories.scan", { name: "x".repeat(300) })).rejects.toThrow();
	});
});
