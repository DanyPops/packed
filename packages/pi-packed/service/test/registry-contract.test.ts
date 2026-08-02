import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { DaemonRegistry } from "../src/daemon/client.ts";
import { createApp } from "../src/daemon/service.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/packages/package.ts";
import { HttpRegistry } from "../src/registry/registry.ts";

/**
 * Mitigates the SOLID audit's one real finding: `resolveRegistry()` swaps
 * transparently between `HttpRegistry` and `DaemonRegistry`, but nothing
 * proved the two honor the same contract. This exercises both real classes
 * against the same fixture data through two different transports (a real
 * `Bun.serve()` npm-mock, and a real mock daemon HTTP server) -- never a
 * hand-rolled fake standing in for either concrete class.
 */
const FIXTURE_PACKAGES = [
	{ name: "pi-lsp", version: "0.3.0", description: "LSP" },
	{ name: "@narumitw/pi-lsp", version: "0.9.1", description: "another" },
	{ name: "pi-lsp-lite", version: "1.0.0", description: "lite" },
];

/** Backs the mock daemon's own `reg` dependency -- an in-memory stand-in for
 * npm is fine here (matches this repo's existing daemon-fixture precedent in
 * cli.test.ts's FakeRegistry); the boundary under test is DaemonRegistry's
 * real HTTP+auth round trip, not what serves data on the other end of it. */
class InMemoryRegistry implements Registry {
	async search(query: string, limit: number): Promise<SearchPage> {
		return this.searchPage(query, 0, limit);
	}
	async searchPage(_query: string, from: number, size: number): Promise<SearchPage> {
		return { results: FIXTURE_PACKAGES.slice(from, from + size), total: FIXTURE_PACKAGES.length };
	}
	async searchAll(): Promise<Pkg[]> {
		return FIXTURE_PACKAGES;
	}
	async info(name: string): Promise<PkgInfo> {
		const match = FIXTURE_PACKAGES.find((p) => p.name === name);
		if (!match) throw new Error(`${name}: not found`);
		return { name: match.name, version: match.version, description: match.description };
	}
}

class NoopInstaller implements Installer {
	async install(): Promise<string> {
		throw new Error("not exercised by the registry contract");
	}
	async remove(): Promise<string> {
		throw new Error("not exercised by the registry contract");
	}
	async update(): Promise<UpdateOutcome> {
		throw new Error("not exercised by the registry contract");
	}
}

/** The shared contract: what `resolveRegistry()`'s real callers (CLI search,
 * `packed score`/`packed check`'s target resolution) actually rely on being
 * identical across both implementations -- `search()` and `info()`. */
function registryContract(label: string, makeRegistry: () => Registry) {
	describe(`Registry contract: ${label}`, () => {
		let registry: Registry;
		beforeAll(() => {
			registry = makeRegistry();
		});

		it("search returns the fixture's lean results and total", async () => {
			const { results, total } = await registry.search("keywords:pi-package lsp", 10);
			expect(total).toBe(3);
			expect(results.map((p) => p.name)).toEqual(["pi-lsp", "@narumitw/pi-lsp", "pi-lsp-lite"]);
		});

		it("info resolves a known package's shape", async () => {
			const info = await registry.info("pi-lsp");
			expect(info).toMatchObject({ name: "pi-lsp", version: "0.3.0" });
		});

		it("info rejects an unknown package rather than resolving a guess", async () => {
			expect(registry.info("does-not-exist")).rejects.toThrow();
		});
	});
}

describe("HttpRegistry vs DaemonRegistry", () => {
	let httpServer: Server<undefined>;
	let daemonServer: Server<undefined>;
	const daemonToken = "c".repeat(64);

	beforeAll(() => {
		httpServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/-/v1/search") {
					const from = Number(url.searchParams.get("from") ?? 0);
					const size = Number(url.searchParams.get("size") ?? 10);
					const page = FIXTURE_PACKAGES.slice(from, from + size);
					return Response.json({ total: FIXTURE_PACKAGES.length, objects: page.map((p) => ({ package: p })) });
				}
				const match = FIXTURE_PACKAGES.find((p) => url.pathname === `/${encodeURIComponent(p.name).replace("%2F", "/")}/latest`);
				return match ? Response.json(match) : new Response("nf", { status: 404 });
			},
		});
		daemonServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) =>
				createApp({
					reg: new InMemoryRegistry(),
					inst: new NoopInstaller(),
					token: daemonToken,
					stateDir: mkdtempSync(join(tmpdir(), "packed-registry-contract-")),
				}).fetch(req),
		});
	});
	afterAll(() => {
		httpServer.stop(true);
		daemonServer.stop(true);
	});

	registryContract("HttpRegistry (real Bun.serve npm-mock)", () => new HttpRegistry(`http://127.0.0.1:${httpServer.port}`, 2, 0, 1_000));
	registryContract(
		"DaemonRegistry (real mock daemon HTTP server)",
		() => new DaemonRegistry(`http://127.0.0.1:${daemonServer.port}`, daemonToken),
	);

	// Two confirmed, intentional divergences -- neither is a defect, since no
	// real caller ever relies on them: nothing pages through the daemon with
	// a nonzero offset, and searchAll() is only ever called against a direct
	// HttpRegistry (packages/catalog.ts's own mirror sync), never a daemon
	// proxy. Documented here so either becoming load-bearing later is a
	// deliberate contract change, not a silent behavior gap.
	describe("known Registry divergences (documented, not a defect)", () => {
		it("DaemonRegistry.searchAll is explicitly unsupported", () => {
			const registry = new DaemonRegistry(`http://127.0.0.1:${daemonServer.port}`, daemonToken);
			expect(registry.searchAll()).rejects.toThrow(/not supported via the daemon proxy/);
		});

		it("DaemonRegistry.searchPage ignores its offset -- package.search has no wire-level offset param", async () => {
			const registry = new DaemonRegistry(`http://127.0.0.1:${daemonServer.port}`, daemonToken);
			const page = await registry.searchPage("keywords:pi-package lsp", 2, 2);
			// HttpRegistry would return just ["pi-lsp-lite"] for from=2; the
			// daemon proxy has no offset to send, so it always returns page 0.
			expect(page.results.map((p) => p.name)).toEqual(["pi-lsp", "@narumitw/pi-lsp"]);
		});
	});
});
