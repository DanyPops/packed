import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { HttpRegistry } from "../src/registry/registry.ts";
import { openDb, replaceAll, dbPath } from "../src/packages/db.ts";
import { buildIndex, writeIndex, readIndex, indexStatus, generateIndex, indexPath } from "../src/index/build-index.ts";

// Real HTTP adapter against a fake npm upstream (Bun.serve) -- same pattern
// core.test.ts's HttpRegistry suite uses. No mocked fetch, no fake
// registry class: buildIndex runs against the real HttpRegistry.
describe("buildIndex", () => {
	let server: Server<undefined>;
	let registry: HttpRegistry;
	let catalogDir: string;
	let fetchedUrls: string[];

	beforeAll(() => {
		catalogDir = mkdtempSync(join(tmpdir(), "packed-index-catalog-"));
		const db = openDb(dbPath(catalogDir));
		replaceAll(db, [
			{ name: "pi-alpha", version: "1.0.0" },
			{ name: "pi-beta", version: "2.0.0" },
			{ name: "pi-missing", version: "0.0.1" }, // 404s -- must be skipped, not fatal
		], "npm:keywords:pi-package");
		db.close();

		const infoDocs: Record<string, unknown> = {
			"pi-alpha": {
				name: "pi-alpha", version: "1.0.0", description: "alpha package for pi", license: "MIT",
				repository: { type: "git", url: "git+https://github.com/x/pi-alpha.git" },
				keywords: ["pi-package"], pi: { extensions: ["./src/index.ts"] },
				dist: { integrity: "sha512-a" },
			},
			"pi-beta": {
				name: "pi-beta", version: "2.0.0", description: "beta package for pi", license: "MIT",
				keywords: ["pi-package"],
			},
		};
		const modifiedDocs: Record<string, string> = {
			"pi-alpha": "2026-01-01T00:00:00.000Z",
			"pi-beta": "2026-02-01T00:00:00.000Z",
			"@earendil-works/pi-coding-agent": "2026-03-01T00:00:00.000Z",
		};

		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				const name = decodeURIComponent(url.pathname.replace(/^\//, "").replace(/\/latest$/, ""));
				if (url.pathname.endsWith("/latest")) {
					const doc = infoDocs[name];
					return doc ? Response.json(doc) : new Response("not found", { status: 404 });
				}
				if (url.pathname.startsWith("/downloads/point/")) {
					return Response.json({ downloads: 5 });
				}
				const modified = modifiedDocs[name];
				return modified ? Response.json({ modified }) : new Response("not found", { status: 404 });
			},
		});
		registry = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
	});

	afterAll(() => server.stop(true));

	it("builds one entry per cataloged package, skipping a lookup failure rather than failing the whole run", async () => {
		const index = await buildIndex(registry, catalogDir, { delayMs: 0, currentPiVersion: async () => "0.83.0" });
		expect(index.packages.map((p) => p.name).sort()).toEqual(["pi-alpha", "pi-beta"]); // pi-missing skipped
		expect(typeof index.generatedAt).toBe("string");
		const alpha = index.packages.find((p) => p.name === "pi-alpha")!;
		expect(alpha.dimensions.trust.status).not.toBe("unknown");
		expect(alpha.dimensions.discoverability.evidence).toContain("pi-package keyword");
	});

	it("never calls GitHub, even for a candidate declaring a github.com repository -- freshness always falls back to the npm publish-date proxy", async () => {
		const realFetch = globalThis.fetch;
		fetchedUrls = [];
		// @ts-expect-error -- test-only global fetch wrap to observe every outbound host, restored in finally
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			fetchedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return realFetch(input, init);
		}) as typeof fetch;
		try {
			const index = await buildIndex(registry, catalogDir, { delayMs: 0, currentPiVersion: async () => "0.83.0" });
			expect(fetchedUrls.some((u) => u.includes("github"))).toBe(false);
			const alpha = index.packages.find((p) => p.name === "pi-alpha")!;
			// pi-alpha declares a real github.com repository, yet freshness must
			// still be sourced from the npm publish-date proxy, never a commit.
			expect(alpha.dimensions.freshness.evidence.some((e) => e.includes("npm publish date"))).toBe(true);
			expect(alpha.dimensions.freshness.evidence.some((e) => e.includes("last real commit"))).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("buildIndex bounds", () => {
	it("never calls downloads() -- confirmed live to trigger npm's 429s at real catalog scale -- and truncates past maxPackages, marking the result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-bounds-"));
		const db = openDb(dbPath(dir));
		replaceAll(db, [
			{ name: "pi-one", version: "1.0.0" },
			{ name: "pi-two", version: "1.0.0" },
			{ name: "pi-three", version: "1.0.0" },
		], "test");
		db.close();
		let downloadsCalled = false;
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.startsWith("/downloads/")) { downloadsCalled = true; return Response.json({ downloads: 1 }); }
				if (url.pathname.endsWith("/latest")) return Response.json({ name: url.pathname.split("/")[1], version: "1.0.0" });
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
			const index = await buildIndex(reg, dir, { delayMs: 0, maxPackages: 2 });
			expect(index.packages).toHaveLength(2); // 3 cataloged, bounded to 2
			expect(index.truncated).toBe(true);
			expect(downloadsCalled).toBe(false);
		} finally {
			server.stop(true);
		}
	});
});

describe("index persistence", () => {
	it("writes, reads, and reports staleness", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-store-"));
		const path = indexPath(dir);
		expect(readIndex(path)).toBeUndefined();
		expect(indexStatus(path, 1_000).stale).toBe(true);

		const index = { generatedAt: new Date().toISOString(), packages: [{ name: "pi-alpha", version: "1.0.0", dimensions: {} as never }], truncated: false };
		writeIndex(path, index);
		expect(readIndex(path)).toEqual(index);
		expect(indexStatus(path, 60_000)).toMatchObject({ stale: false, packageCount: 1 });

		const old = { generatedAt: new Date(Date.now() - 100_000).toISOString(), packages: [], truncated: false };
		writeIndex(path, old);
		expect(indexStatus(path, 1_000).stale).toBe(true);
	});

	it("generateIndex builds and writes in one call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-generate-"));
		const db = openDb(dbPath(dir));
		replaceAll(db, [{ name: "pi-alpha", version: "1.0.0" }], "npm:keywords:pi-package");
		db.close();
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/pi-alpha/latest") return Response.json({ name: "pi-alpha", version: "1.0.0" });
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
			const index = await generateIndex(reg, dir, indexPath(dir), { delayMs: 0 });
			expect(readIndex(indexPath(dir))).toEqual(index);
		} finally {
			server.stop(true);
		}
	});
});
