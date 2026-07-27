import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearchQuery, clampLimit } from "../src/ports.ts";
import { TTLCache } from "../src/cache.ts";
import { envMs } from "../src/state.ts";
import { HttpRegistry } from "../src/registry.ts";
import type { Server } from "bun";

describe("buildSearchQuery", () => {
	it("scopes to pi packages", () => {
		expect(buildSearchQuery("lsp")).toBe("keywords:pi-package lsp");
		expect(buildSearchQuery("  telegram  ")).toBe("keywords:pi-package telegram");
		expect(buildSearchQuery("")).toBe("keywords:pi-package");
		expect(buildSearchQuery("keywords:pi-package lsp")).toBe("keywords:pi-package lsp");
	});
});

describe("clampLimit", () => {
	it("defaults and clamps", () => {
		expect(clampLimit(0, 10, 50)).toBe(10);
		expect(clampLimit(999, 10, 50)).toBe(50);
		expect(clampLimit(7, 10, 50)).toBe(7);
	});
});

describe("TTLCache", () => {
	it("stores and expires", async () => {
		const c = new TTLCache(20); // ms
		c.set("k", "v");
		expect(c.get("k")).toBe("v");
		await Bun.sleep(30);
		expect(c.get("k")).toBeUndefined();
	});
});

// Real HTTP adapter against a fake npm upstream (Bun.serve).
describe("HttpRegistry", () => {
	let server: Server<undefined>;
	let registry: HttpRegistry;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/-/v1/search") {
					const from = Number(url.searchParams.get("from") ?? 0);
					const size = Number(url.searchParams.get("size") ?? 10);
					if (url.searchParams.get("text") !== "keywords:pi-package lsp") {
						return Response.json({ error: "bad query" }, { status: 400 });
					}
					const all = [
						{ name: "pi-lsp", version: "0.3.0", description: "LSP", date: "2026-06-01" },
						{ name: "@narumitw/pi-lsp", version: "0.9.1", description: "another" },
						{ name: "pi-lsp-lite", version: "1.0.0", description: "lite" },
					];
					const page = all.slice(from, from + size);
					return Response.json({ total: all.length, objects: page.map((p) => ({ package: p })) });
				}
				if (url.pathname === "/downloads/point/last-week/pi-lsp") return Response.json({ downloads: 12 });
				if (url.pathname === "/downloads/point/last-month/pi-lsp") return Response.json({ downloads: 34 });
				if (url.pathname === "/pi-lsp/latest") {
					return Response.json({
						name: "pi-lsp", version: "0.3.0", description: "LSP for pi", homepage: "https://example.com",
						repository: { type: "git", url: "git+https://github.com/x/pi-lsp.git" }, license: "MIT",
						keywords: ["pi-package", "lsp"], pi: { extensions: ["./src/index.ts"] },
						dist: { unpackedSize: 12345, integrity: "sha512-test", attestations: { url: "https://registry.example/provenance", provenance: { predicateType: "slsa" } } },
					});
				}
				return new Response("nf", { status: 404 });
			},
		});
		registry = new HttpRegistry(`http://127.0.0.1:${server.port}`, 2, 100, 1_000, `http://127.0.0.1:${server.port}`); // tiny page size
	});
	afterAll(() => server.stop(true));

	it("search maps lean results", async () => {
		const { results, total } = await registry.search("keywords:pi-package lsp", 2);
		expect(total).toBe(3);
		expect(results[0]).toMatchObject({ name: "pi-lsp", version: "0.3.0", packageEvidence: { shape: "keyword-only", verified: false } });
	});

	it("searchAll paginates", async () => {
		const all = await registry.searchAll("keywords:pi-package lsp");
		expect(all.map((p) => p.name)).toEqual(["pi-lsp", "@narumitw/pi-lsp", "pi-lsp-lite"]);
	});

	it("info maps latest version fields", async () => {
		const info = await registry.info("pi-lsp");
		expect(info).toMatchObject({
			name: "pi-lsp",
			version: "0.3.0",
			description: "LSP for pi",
			repository: "git+https://github.com/x/pi-lsp.git",
			license: "MIT",
			unpackedSize: 12345,
			readmeAvailable: false,
		});
		expect(info.pi?.extensions).toBeDefined();
		expect(info.packageEvidence).toMatchObject({ shape: "manifest", verified: false });
		expect(info.publication).toEqual({ integrity: "sha512-test", provenanceUrl: "https://registry.example/provenance", trustedPublisher: "unknown" });
		expect(await registry.downloads("pi-lsp")).toMatchObject({ weekly: 12, monthly: 34 });
	});

	it("upstream errors surface", async () => {
		expect(registry.info("missing-pkg")).rejects.toThrow(/404/);
	});
});

describe("envMs (service lifecycle knob)", () => {
	it("default when unset or garbage", () => {
		delete process.env["PI_PACKED_TEST_MS"];
		expect(envMs("PI_PACKED_TEST_MS", 5000)).toBe(5000);
		process.env["PI_PACKED_TEST_MS"] = "banana";
		expect(envMs("PI_PACKED_TEST_MS", 5000)).toBe(5000);
	});
	it("seconds → ms when set", () => {
		process.env["PI_PACKED_TEST_MS"] = "30";
		expect(envMs("PI_PACKED_TEST_MS", 5000)).toBe(30_000);
	});
	it("zero disables (systemd owns the lifecycle)", () => {
		process.env["PI_PACKED_TEST_MS"] = "0";
		expect(envMs("PI_PACKED_TEST_MS", 5000)).toBe(0);
	});
});

describe("upstream etiquette (429 handling)", () => {
	it("retries on 429 honoring Retry-After, then succeeds", async () => {
		let attempts = 0;
		await using server = Bun.serve({
			port: 0,
			fetch() {
				attempts++;
				if (attempts <= 2) {
					return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
				}
				return Response.json({ total: 0, objects: [] });
			},
		});
		const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1);
		const { total } = await reg.search("keywords:pi-package x", 10);
		expect(total).toBe(0);
		expect(attempts).toBe(3);
	});

	it("gives up after max attempts", async () => {
		let attempts = 0;
		await using server = Bun.serve({
			port: 0,
			fetch() {
				attempts++;
				return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
			},
		});
		const reg = new HttpRegistry(`http://127.0.0.1:${server.port}`, 250, 0, 1);
		expect(reg.search("keywords:pi-package x", 10)).rejects.toThrow(/429/);
		expect(attempts).toBeGreaterThanOrEqual(3);
	});

	it("searchAll pauses between pages", async () => {
		const reg = new HttpRegistry("http://unused", 250, 40);
		const t0 = Date.now();
		// monkey-patch searchPage to avoid network
		reg.searchPage = async (_q: string, from: number) =>
			from === 0 ? { results: [{ name: "a", version: "1" }], total: 2 } : { results: [{ name: "b", version: "1" }], total: 2 };
		await reg.searchAll("keywords:pi-package");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
	});
});
