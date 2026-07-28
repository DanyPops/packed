import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { checkPiVersion, createFetchLatestPiRelease, type PiReleaseInfo } from "../src/pi-version.ts";
import type { VersionCommand } from "../src/publish.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage } from "../src/ports.ts";

class NoopRegistry implements Registry {
	async search(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchPage(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchAll() { return []; }
	async info(name: string): Promise<PkgInfo> { return { name, version: "1.0.0" }; }
}

class NoopInstaller implements Installer {
	async install() { return "ok"; }
	async remove() { return "ok"; }
	async update() { return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false }; }
}

const okVersion: VersionCommand = async () => ({ code: 0, stdout: "0.82.1\n", stderr: "" });
const noPi: VersionCommand = async () => ({ code: 127, stdout: "", stderr: "command not found: pi" });
const garbled: VersionCommand = async () => ({ code: 0, stdout: "not-a-version\n", stderr: "" });

function fakeLatest(release: PiReleaseInfo | undefined) {
	return async () => release;
}

describe("checkPiVersion", () => {
	it("reports up to date when current already satisfies the latest release", async () => {
		const report = await checkPiVersion({ versionCommand: okVersion, fetchLatest: fakeLatest({ version: "0.82.1" }) });
		expect(report).toEqual({ current: "0.82.1", latest: "0.82.1", upToDate: true });
	});

	it("reports behind when current is older than the latest release", async () => {
		const report = await checkPiVersion({ versionCommand: okVersion, fetchLatest: fakeLatest({ version: "0.83.0" }) });
		expect(report).toEqual({ current: "0.82.1", latest: "0.83.0", upToDate: false });
	});

	it("never guesses upToDate when the current version is unknown", async () => {
		const report = await checkPiVersion({ versionCommand: noPi, fetchLatest: fakeLatest({ version: "0.83.0" }) });
		expect(report).toEqual({ latest: "0.83.0" });
		expect(report.upToDate).toBeUndefined();
	});

	it("never guesses upToDate when the latest-version check fails", async () => {
		const report = await checkPiVersion({ versionCommand: okVersion, fetchLatest: fakeLatest(undefined) });
		expect(report).toEqual({ current: "0.82.1" });
		expect(report.upToDate).toBeUndefined();
	});

	it("treats unparseable version-command output the same as pi being absent", async () => {
		const report = await checkPiVersion({ versionCommand: garbled, fetchLatest: fakeLatest({ version: "0.83.0" }) });
		expect(report.current).toBeUndefined();
	});

	it("never reports a rename when packageName merely echoes the current package (confirmed live: the real API always includes this field)", async () => {
		const report = await checkPiVersion({
			versionCommand: okVersion,
			fetchLatest: fakeLatest({ version: "0.83.0", packageName: "@earendil-works/pi-coding-agent" }),
		});
		expect(report.packageName).toBeUndefined();
	});

	it("passes through packageName (rename migration signal) and note (release message)", async () => {
		const report = await checkPiVersion({
			versionCommand: okVersion,
			fetchLatest: fakeLatest({ version: "0.83.0", packageName: "@earendil-works/pi", note: "Requires a fresh login." }),
		});
		expect(report.packageName).toBe("@earendil-works/pi");
		expect(report.note).toBe("Requires a fresh login.");
	});

	it("never throws when the version command itself throws", async () => {
		const throwing: VersionCommand = async () => { throw new Error("spawn failed"); };
		const report = await checkPiVersion({ versionCommand: throwing, fetchLatest: fakeLatest({ version: "0.83.0" }) });
		expect(report.current).toBeUndefined();
		expect(report.latest).toBe("0.83.0");
	});
});

// Real HTTP adapter against a fake pi.dev upstream (Bun.serve), matching
// this codebase's existing HttpRegistry test convention -- never mocks
// global fetch, never touches the real pi.dev/api/latest-version endpoint.
describe("createFetchLatestPiRelease", () => {
	let server: Server<undefined> | undefined;

	afterEach(() => {
		server?.stop(true);
		server = undefined;
		delete process.env.PI_SKIP_VERSION_CHECK;
		delete process.env.PI_OFFLINE;
	});

	it("parses a real successful response", async () => {
		server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "0.83.0" }) });
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toEqual({ version: "0.83.0" });
	});

	it("includes packageName and note only when present and non-empty", async () => {
		server = Bun.serve({ port: 0, fetch: () => Response.json({ version: "0.83.0", packageName: "  ", note: "Read the changelog." }) });
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toEqual({ version: "0.83.0", note: "Read the changelog." });
	});

	it("resolves to undefined on a non-2xx response, never throws", async () => {
		server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toBeUndefined();
	});

	it("resolves to undefined on a malformed body, never throws", async () => {
		server = Bun.serve({ port: 0, fetch: () => new Response("not json", { status: 200 }) });
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toBeUndefined();
	});

	it("resolves to undefined on an unreachable host, never throws or hangs", async () => {
		const fetchLatest = createFetchLatestPiRelease("http://127.0.0.1:1");
		expect(await fetchLatest({ timeoutMs: 500 })).toBeUndefined();
	});

	it("PI_SKIP_VERSION_CHECK short-circuits before any network call", async () => {
		server = Bun.serve({ port: 0, fetch: () => { throw new Error("must never be called"); } });
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toBeUndefined();
	});

	it("PI_OFFLINE short-circuits before any network call", async () => {
		server = Bun.serve({ port: 0, fetch: () => { throw new Error("must never be called"); } });
		process.env.PI_OFFLINE = "1";
		const fetchLatest = createFetchLatestPiRelease(`http://127.0.0.1:${server.port}`);
		expect(await fetchLatest()).toBeUndefined();
	});
});

describe("pi.status operation", () => {
	it("routes through the daemon's authenticated operation registry", async () => {
		const app = createApp({
			reg: new NoopRegistry(), inst: new NoopInstaller(), token: "test-token",
			stateDir: mkdtempSync(join(tmpdir(), "packed-pi-version-state-")), dataDir: mkdtempSync(join(tmpdir(), "packed-pi-version-data-")),
			piVersion: { check: async () => ({ current: "0.82.1", latest: "0.83.0", upToDate: false }) },
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", { label: "Packed", transport: (request) => app.fetch(request) });
		expect(await client.operations()).toContain("pi.status");
		expect(await client.call("pi.status", {})).toEqual({ current: "0.82.1", latest: "0.83.0", upToDate: false });
	});

	it("is unguarded read access -- never requires approval", async () => {
		const app = createApp({
			reg: new NoopRegistry(), inst: new NoopInstaller(), token: "test-token",
			stateDir: mkdtempSync(join(tmpdir(), "packed-pi-version-state-")), dataDir: mkdtempSync(join(tmpdir(), "packed-pi-version-data-")),
			piVersion: { check: async () => ({}) },
		});
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", { label: "Packed", transport: (request) => app.fetch(request) });
		expect(await client.call("pi.status", {})).toEqual({});
	});
});
