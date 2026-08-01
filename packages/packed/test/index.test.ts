import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { buildIndex, generateIndex, indexPath, indexStatus, readIndex, writeIndex } from "../src/index/build-index.ts";
import { dbPath, openDb, replaceAll } from "../src/packages/db.ts";
import { HttpRegistry } from "../src/registry/registry.ts";

// Guards the "never bulk GitHub calls" constraint against regression: a
// future edit could easily start threading a GitHub-commit fetcher through
// buildIndex the same way scoreTarget does. A source-level check catches
// that before it ships, independent of whatever fixture happens to be
// running in the behavioral tests below.
describe("index/build-index.ts never touches GitHub", () => {
	it("does not import commit-freshness.ts's GitHub-facing exports", () => {
		const source = readFileSync(new URL("../src/index/build-index.ts", import.meta.url), "utf8");
		// Matches a real import specifier or a real call, not prose mentioning
		// the file/function names in a comment (this file's own doc comment
		// legitimately explains *why* it avoids commit-freshness.ts).
		expect(source).not.toMatch(/from\s+["'][^"']*commit-freshness(?:\.ts)?["']|\b(?:githubLastCommitAt|createGithubLastCommitAt)\s*\(/);
	});
});

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
		replaceAll(
			db,
			[
				{ name: "pi-alpha", version: "1.0.0" },
				{ name: "pi-beta", version: "2.0.0" },
				{ name: "pi-missing", version: "0.0.1" }, // 404s -- must be skipped, not fatal
			],
			"npm:keywords:pi-package",
		);
		db.close();

		const infoDocs: Record<string, unknown> = {
			"pi-alpha": {
				name: "pi-alpha",
				version: "1.0.0",
				description: "alpha package for pi",
				license: "MIT",
				repository: { type: "git", url: "git+https://github.com/x/pi-alpha.git" },
				keywords: ["pi-package"],
				pi: { extensions: ["./src/index.ts"] },
				dist: { integrity: "sha512-a" },
			},
			"pi-beta": {
				name: "pi-beta",
				version: "2.0.0",
				description: "beta package for pi",
				license: "MIT",
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
		replaceAll(
			db,
			[
				{ name: "pi-one", version: "1.0.0" },
				{ name: "pi-two", version: "1.0.0" },
				{ name: "pi-three", version: "1.0.0" },
			],
			"test",
		);
		db.close();
		let downloadsCalled = false;
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.startsWith("/downloads/")) {
					downloadsCalled = true;
					return Response.json({ downloads: 1 });
				}
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

	it("collapses two concurrent callers into one run -- confirmed live to matter: the daemon's own maintenance tick and an on-demand CLI build overlapping compounded into a shutdown the daemon's SIGTERM grace period couldn't outlast", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-concurrent-"));
		const db = openDb(dbPath(dir));
		replaceAll(db, [{ name: "pi-one", version: "1.0.0" }], "test");
		db.close();
		let infoCalls = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith("/latest")) {
					infoCalls++;
					await Bun.sleep(30);
					return Response.json({ name: "pi-one", version: "1.0.0" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
			const [a, b] = await Promise.all([buildIndex(reg, dir, { delayMs: 0 }), buildIndex(reg, dir, { delayMs: 0 })]);
			expect(a).toBe(b); // the very same result object -- one real run, not two
			expect(infoCalls).toBe(1); // never doubled
		} finally {
			server.stop(true);
		}
	});
});

describe("buildIndex incremental delta scanning", () => {
	it("partitions the catalog into New/Changed/Unchanged against the prior index -- Unchanged makes zero live registry calls, New and Changed do", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-delta-"));
		const db = openDb(dbPath(dir));
		replaceAll(
			db,
			[
				{ name: "pi-new", version: "1.0.0", date: "2026-03-01T00:00:00.000Z" }, // absent from prior index
				{ name: "pi-changed", version: "2.0.0", date: "2026-04-01T00:00:00.000Z" }, // date advanced since last scan
				{ name: "pi-unchanged", version: "1.5.0", date: "2026-01-01T00:00:00.000Z" }, // date identical to last scan
			],
			"test",
		);
		db.close();

		const priorIndex = {
			generatedAt: "2026-02-01T00:00:00.000Z",
			packages: [
				{
					name: "pi-changed",
					version: "1.9.0",
					date: "2026-01-01T00:00:00.000Z",
					dimensions: { discoverability: { status: "ready" as const, met: 1, total: 1, evidence: ["stale"], actions: [] } } as never,
				},
				{
					name: "pi-unchanged",
					version: "1.5.0",
					date: "2026-01-01T00:00:00.000Z",
					dimensions: {
						discoverability: { status: "ready" as const, met: 1, total: 1, evidence: ["carried forward"], actions: [] },
					} as never,
				},
			],
			truncated: false,
		};
		await writeIndex(indexPath(dir), priorIndex);

		const calledInfo: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith("/latest")) {
					const name = decodeURIComponent(url.pathname.replace(/^\//, "").replace(/\/latest$/, ""));
					calledInfo.push(name);
					return Response.json({ name, version: name === "pi-changed" ? "2.0.0" : "1.0.0", description: "real fixture" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
			const index = await buildIndex(reg, dir, { delayMs: 0 });

			// Unchanged never triggered a live info() call, and its prior
			// dimensions/date are preserved verbatim.
			expect(calledInfo.sort()).toEqual(["pi-changed", "pi-new"]);
			const unchanged = index.packages.find((p) => p.name === "pi-unchanged")!;
			expect(unchanged.dimensions.discoverability.evidence).toEqual(["carried forward"]);
			expect(unchanged.date).toBe("2026-01-01T00:00:00.000Z");

			// Changed and New both got a real, fresh score.
			const changed = index.packages.find((p) => p.name === "pi-changed")!;
			expect(changed.version).toBe("2.0.0");
			expect(changed.date).toBe("2026-04-01T00:00:00.000Z");
			const fresh = index.packages.find((p) => p.name === "pi-new")!;
			expect(fresh.date).toBe("2026-03-01T00:00:00.000Z");
			expect(index.packages).toHaveLength(3);
		} finally {
			server.stop(true);
		}
	});

	it("maxPackages bounds only the New+Changed live-call queue -- Unchanged entries beyond that count still complete", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-delta-bound-"));
		const db = openDb(dbPath(dir));
		// 5 unchanged entries alone already exceed maxPackages: 1 below.
		replaceAll(
			db,
			[
				{ name: "pi-a", version: "1.0.0", date: "2026-01-01T00:00:00.000Z" },
				{ name: "pi-b", version: "1.0.0", date: "2026-01-01T00:00:00.000Z" },
				{ name: "pi-c", version: "1.0.0", date: "2026-01-01T00:00:00.000Z" },
				{ name: "pi-d", version: "1.0.0", date: "2026-01-01T00:00:00.000Z" },
				{ name: "pi-e", version: "1.0.0", date: "2026-01-01T00:00:00.000Z" },
			],
			"test",
		);
		db.close();
		const priorIndex = {
			generatedAt: "2026-01-01T00:00:00.000Z",
			packages: ["pi-a", "pi-b", "pi-c", "pi-d", "pi-e"].map((name) => ({
				name,
				version: "1.0.0",
				date: "2026-01-01T00:00:00.000Z",
				dimensions: {} as never,
			})),
			truncated: false,
		};
		await writeIndex(indexPath(dir), priorIndex);
		let liveCalls = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				liveCalls++;
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1, `http://127.0.0.1:${server.port}`);
			const index = await buildIndex(reg, dir, { delayMs: 0, maxPackages: 1 });
			expect(index.packages).toHaveLength(5); // all 5 Unchanged carried forward despite maxPackages: 1
			expect(index.truncated).toBe(false); // nothing needed live scoring, so nothing was truncated
			expect(liveCalls).toBe(0);
		} finally {
			server.stop(true);
		}
	});
});

describe("index persistence", () => {
	it("writes, reads, and reports staleness", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-index-store-"));
		const path = indexPath(dir);
		expect(readIndex(path)).toBeUndefined();
		expect(indexStatus(path, 1_000).stale).toBe(true);

		const index = {
			generatedAt: new Date().toISOString(),
			packages: [{ name: "pi-alpha", version: "1.0.0", dimensions: {} as never }],
			truncated: false,
		};
		await writeIndex(path, index);
		expect(readIndex(path)).toEqual(index);
		expect(indexStatus(path, 60_000)).toMatchObject({ stale: false, packageCount: 1 });

		const old = { generatedAt: new Date(Date.now() - 100_000).toISOString(), packages: [], truncated: false };
		await writeIndex(path, old);
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
