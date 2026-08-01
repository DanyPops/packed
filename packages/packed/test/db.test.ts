import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../src/packages/catalog.ts";
import { catalogList, dbPath, getSyncMeta, openDb, replaceAll, searchLocal } from "../src/packages/db.ts";
import { HttpRegistry } from "../src/registry/registry.ts";
import type { Pkg, PkgInfo, Registry, SearchPage } from "../src/shared/ports.ts";

const PKGS = [
	{ name: "pi-lsp", version: "0.18.0", description: "LSP tools for pi" },
	{ name: "@llblab/pi-telegram", version: "0.23.1", description: "Telegram runtime adapter" },
	{ name: "pi-lsp-lite", version: "1.0.0", description: "lightweight LSP" },
];

describe("db (local registry index)", () => {
	it("creates schema and replaces the catalog atomically", () => {
		const db = openDb(":memory:");
		replaceAll(db, PKGS, "test-source");
		expect(catalogList(db)).toHaveLength(3);
		expect(catalogList(db)[0]?.packageEvidence).toMatchObject({ shape: "keyword-only", verified: false });
		// Second sync replaces, not appends
		replaceAll(db, [PKGS[0]!], "test-source");
		expect(catalogList(db)).toHaveLength(1);
		db.close();
	});

	it("roundtrips verified Pi shape and publication evidence", () => {
		const db = openDb(":memory:");
		replaceAll(
			db,
			[
				{
					name: "pi-verified",
					version: "1",
					packageEvidence: { shape: "conventional", verified: true, evidence: ["extensions"] },
					publication: { provenanceUrl: "https://registry.example/attestation", trustedPublisher: "verified" },
				},
			],
			"snapshot",
		);
		expect(catalogList(db)[0]).toMatchObject({
			packageEvidence: { shape: "conventional", verified: true, evidence: ["extensions"] },
			publication: { provenanceUrl: "https://registry.example/attestation", trustedPublisher: "verified" },
		});
		db.close();
	});

	it("searchLocal: FTS with AND semantics, scoped names, ranking", () => {
		const db = openDb(":memory:");
		replaceAll(db, PKGS, "test");
		expect(searchLocal(db, "lsp").map((p) => p.name)).toContain("pi-lsp");
		const and = searchLocal(db, "lsp lightweight");
		expect(and.map((p) => p.name)).toEqual(["pi-lsp-lite"]);
		expect(searchLocal(db, "telegram").map((p) => p.name)).toEqual(["@llblab/pi-telegram"]);
		expect(searchLocal(db, "nonexistent")).toEqual([]);
		db.close();
	});

	it("ranks verified Pi-shaped packages ahead of keyword-only candidates", () => {
		const db = openDb(":memory:");
		replaceAll(
			db,
			[
				{ name: "candidate", version: "1", description: "shared package" },
				{
					name: "verified",
					version: "1",
					description: "shared package",
					packageEvidence: { shape: "manifest", verified: true, evidence: ["pi.extensions"] },
				},
			],
			"snapshot",
		);
		expect(searchLocal(db, "shared").map((item) => item.name)).toEqual(["verified", "candidate"]);
		db.close();
	});

	it("searchLocal survives FTS-hostile input (LIKE fallback)", () => {
		const db = openDb(":memory:");
		replaceAll(db, PKGS, "test");
		expect(() => searchLocal(db, 'lsp "broken')).not.toThrow();
		expect(searchLocal(db, "lsp*")).toContainEqual(expect.objectContaining({ name: "pi-lsp" }));
		db.close();
	});

	it("sync meta carries source, time, count, and a payload checksum", () => {
		const db = openDb(":memory:");
		replaceAll(db, PKGS, "npm");
		const meta = getSyncMeta(db)!;
		expect(meta.source).toBe("npm");
		expect(meta.packageCount).toBe(3);
		expect(meta.fetchedAt).toBeTruthy();
		expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
		db.close();
	});

	it("dbPath lives in the state dir", () => {
		expect(dbPath("/tmp/x")).toBe(join("/tmp/x", "packed.db"));
	});
});

// The sync pipeline: paginated upstream → SQLite mirror (apt update analog).
class PagedRegistry implements Registry {
	constructor(
		private pages: Record<number, Pkg[]>,
		private total: number,
	) {}
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(_q: string, from: number, _size?: number): Promise<SearchPage> {
		return { results: this.pages[from] ?? [], total: this.total };
	}
	async searchAll(q: string): Promise<Pkg[]> {
		const out: Pkg[] = [];
		let from = 0;
		for (;;) {
			const { results, total } = await this.searchPage(q, from, 0);
			out.push(...results);
			from += results.length;
			if (results.length === 0 || from >= total) return out;
		}
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1" };
	}
}

describe("syncCatalog → SQLite", () => {
	it("accumulates pages into the DB and records sync meta", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-"));
		const reg = new PagedRegistry({ 0: PKGS.slice(0, 2), 2: PKGS.slice(2) }, 3);
		expect(await syncCatalog(reg, dir)).toBe(3);
		expect(existsSync(dbPath(dir))).toBe(true);

		const db = openDb(dbPath(dir));
		expect(catalogList(db).map((p) => p.name)).toEqual([...PKGS.map((p) => p.name)].sort());
		expect(getSyncMeta(db)!.packageCount).toBe(3);
		db.close();
	});
});

describe("unstable upstream pagination", () => {
	it("replaceAll tolerates duplicate names (INSERT OR REPLACE)", () => {
		const db = openDb(":memory:");
		const dupes = [
			{ name: "pi-lsp", version: "0.18.0" },
			{ name: "a", version: "1" },
			{ name: "pi-lsp", version: "0.19.0" }, // shifted onto a second page
		];
		expect(() => replaceAll(db, dupes, "test")).not.toThrow();
		expect(catalogList(db)).toHaveLength(2);
		db.close();
	});

	it("searchAll dedupes packages that shift across pages", async () => {
		const reg = new HttpRegistry("http://unused", 250, 0, 1);
		reg.searchPage = async (_q: string, from: number) =>
			from === 0
				? {
						results: [
							{ name: "a", version: "1" },
							{ name: "b", version: "1" },
						],
						total: 3,
					}
				: {
						results: [
							{ name: "b", version: "1" },
							{ name: "c", version: "1" },
						],
						total: 3,
					};
		const all = await reg.searchAll("keywords:pi-package");
		expect(all.map((p: Pkg) => p.name)).toEqual(["a", "b", "c"]);
	});
});
