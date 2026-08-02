/**
 * db.ts — the local registry index (SQLite), the pkgng/YUM model.
 * Master-index role: sync_meta (source, time, count, payload checksum —
 * the APT Release / repomd.xml analog). Payload: packages + FTS5 mirror.
 */
// Runtime-detected SQLite backend: bun:sqlite under Bun (CLI, daemon),
// node:sqlite under Node ≥22.5 (pi's extension host — jiti runs on Node).
// Both share the better-sqlite3 API shape; transactions are done manually
// because node:sqlite has no .transaction() helper.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const backend = IS_BUN
	? (require_("bun:sqlite") as typeof import("bun:sqlite"))
	: (require_("node:sqlite") as unknown as typeof import("bun:sqlite"));

// Constructor + options differ: bun:sqlite exports Database({create}),
// node:sqlite exports DatabaseSync (creates by default).
const DatabaseCtor = ("DatabaseSync" in backend ? (backend as { DatabaseSync: unknown }).DatabaseSync : backend.Database) as new (
	path: string,
	opts?: { create?: boolean },
) => Db;

export interface DbStatement {
	run(...params: unknown[]): { lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface Db {
	exec(sql: string): unknown;
	prepare(sql: string): DbStatement;
	close(): void;
}

function inTransaction<T>(db: Db, fn: () => T): T {
	db.exec("BEGIN");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}

import { createHash } from "node:crypto";
import { join } from "node:path";
import { DB_FILE } from "../shared/constants.ts";
import type { Pkg } from "./package.ts";

export interface SyncMeta {
	source: string;
	fetchedAt: string;
	packageCount: number;
	sha256: string;
}

export function dbPath(dir: string): string {
	return join(dir, DB_FILE);
}

export function openDb(path: string): Db {
	if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
	const db = IS_BUN ? new DatabaseCtor(path, { create: true }) : new DatabaseCtor(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS packages (
		name TEXT PRIMARY KEY,
		version TEXT NOT NULL DEFAULT '',
		description TEXT,
		date TEXT
	)`);
	ensureColumn(db, "packages", "shape", "TEXT NOT NULL DEFAULT 'keyword-only'");
	ensureColumn(db, "packages", "verified", "INTEGER NOT NULL DEFAULT 0");
	ensureColumn(db, "packages", "evidence", "TEXT NOT NULL DEFAULT '[]'");
	ensureColumn(db, "packages", "provenance_url", "TEXT");
	ensureColumn(db, "packages", "trusted_publisher", "TEXT NOT NULL DEFAULT 'unknown'");
	db.exec(`CREATE TABLE IF NOT EXISTS sync_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		source TEXT NOT NULL,
		fetched_at TEXT NOT NULL,
		package_count INTEGER NOT NULL,
		sha256 TEXT NOT NULL
	)`);
	// FTS5 mirror; rebuilt wholesale on each sync.
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(name, description)`);
	return db;
}

function ensureColumn(db: Db, table: string, column: string, declaration: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/** Canonical checksum over the payload — the Release-file analog: cheap
 * change detection between syncs and integrity for the local mirror. */
function payloadHash(pkgs: Pkg[]): string {
	const h = createHash("sha256");
	for (const p of pkgs)
		h.update(
			`${p.name}@${p.version}:${p.packageEvidence?.shape ?? "keyword-only"}:${p.packageEvidence?.verified === true ? 1 : 0}:${p.publication?.provenanceUrl ?? ""}\n`,
		);
	return h.digest("hex");
}

/** Atomic full-catalog replace (the mirror write side of `apt update`). */
export function replaceAll(db: Db, pkgs: Pkg[], source: string): SyncMeta {
	const meta: SyncMeta = {
		source,
		fetchedAt: new Date().toISOString(),
		packageCount: pkgs.length,
		sha256: payloadHash(pkgs),
	};
	// INSERT OR REPLACE: npm pagination is unstable — rankings shift between
	// pages and a package can appear twice in one sync (rowid reuse is fine).
	const insert = db.prepare(
		"INSERT OR REPLACE INTO packages (name, version, description, date, shape, verified, evidence, provenance_url, trusted_publisher) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertFts = db.prepare("INSERT INTO packages_fts (rowid, name, description) VALUES (?, ?, ?)");
	inTransaction(db, () => {
		db.exec("DELETE FROM packages");
		db.exec("DELETE FROM packages_fts");
		for (const p of pkgs) {
			const { lastInsertRowid } = insert.run(
				p.name,
				p.version,
				p.description ?? null,
				p.date ?? null,
				p.packageEvidence?.shape ?? "keyword-only",
				p.packageEvidence?.verified === true ? 1 : 0,
				JSON.stringify(p.packageEvidence?.evidence ?? []),
				p.publication?.provenanceUrl ?? null,
				p.publication?.trustedPublisher ?? "unknown",
			);
			insertFts.run(Number(lastInsertRowid), p.name, p.description ?? "");
		}
		db.prepare(
			"INSERT INTO sync_meta (id, source, fetched_at, package_count, sha256) VALUES (1, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET source=excluded.source, fetched_at=excluded.fetched_at, " +
				"package_count=excluded.package_count, sha256=excluded.sha256",
		).run(meta.source, meta.fetchedAt, meta.packageCount, meta.sha256);
	});
	return meta;
}

export function getSyncMeta(db: Db): SyncMeta | undefined {
	return db.prepare("SELECT source, fetched_at AS fetchedAt, package_count AS packageCount, sha256 FROM sync_meta WHERE id = 1").get() as
		| SyncMeta
		| undefined;
}

export function catalogList(db: Db, limit = 0, offset = 0): Pkg[] {
	const sql =
		"SELECT name, version, description, date, shape, verified, evidence, provenance_url AS provenanceUrl, trusted_publisher AS trustedPublisher FROM packages ORDER BY name" +
		(limit > 0 ? ` LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)}` : "");
	return mapPackageRows(db.prepare(sql).all());
}

/** FTS5 over the mirror (the `apt-cache search` analog). Sanitizes user
 * input into AND-joined quoted terms; falls back to LIKE for hostile input. */
export function searchLocal(db: Db, q: string, limit = 50): Pkg[] {
	const terms = q.trim().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];
	try {
		const match = terms.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
		return mapPackageRows(
			db
				.prepare(
					`SELECT p.name, p.version, p.description, p.date, p.shape, p.verified, p.evidence,
				        p.provenance_url AS provenanceUrl, p.trusted_publisher AS trustedPublisher
				 FROM packages_fts f JOIN packages p ON p.rowid = f.rowid
				 WHERE packages_fts MATCH ? ORDER BY p.verified DESC, rank LIMIT ?`,
				)
				.all(match, limit),
		);
	} catch {
		// FTS syntax hostility → substring fallback
		const like = `%${q}%`;
		return mapPackageRows(
			db
				.prepare(
					"SELECT name, version, description, date, shape, verified, evidence, provenance_url AS provenanceUrl, trusted_publisher AS trustedPublisher FROM packages WHERE name LIKE ? OR description LIKE ? ORDER BY verified DESC, name LIMIT ?",
				)
				.all(like, like, limit),
		);
	}
}

function mapPackageRows(rows: unknown[]): Pkg[] {
	return (rows as Array<Record<string, unknown>>).map((row) => ({
		name: String(row.name),
		version: String(row.version ?? ""),
		description: typeof row.description === "string" ? row.description : undefined,
		date: typeof row.date === "string" ? row.date : undefined,
		packageEvidence: {
			shape: row.shape === "manifest" || row.shape === "conventional" ? row.shape : "keyword-only",
			verified: row.verified === 1 || row.verified === true,
			evidence: parseEvidence(row.evidence),
		},
		publication: {
			provenanceUrl: typeof row.provenanceUrl === "string" ? row.provenanceUrl : undefined,
			trustedPublisher: row.trustedPublisher === "verified" || row.trustedPublisher === "not-verified" ? row.trustedPublisher : "unknown",
		},
	}));
}

function parseEvidence(value: unknown): string[] {
	try {
		const parsed = JSON.parse(typeof value === "string" ? value : "[]") as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
	} catch {
		return [];
	}
}

/** Latest mirrored version of one package (watcher's lookup). */
export function latestVersion(db: Db, name: string): string | undefined {
	const row = db.prepare("SELECT version FROM packages WHERE name = ?").get(name) as { version: string } | null;
	return row?.version;
}
