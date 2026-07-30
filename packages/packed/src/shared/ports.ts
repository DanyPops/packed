/**
 * ports.ts — shared interfaces (ports) and lean domain types that decouple
 * callers (the HTTP service, the CLI, the watcher, tests) from concrete
 * implementations (registry/registry.ts talks to npm; packages/install.ts
 * shells out to pi).
 */

export type PackageVerification = "keyword-only" | "manifest" | "conventional";

export interface PackageEvidence {
	shape: PackageVerification;
	verified: boolean;
	evidence: string[];
}

export interface PublicationEvidence {
	integrity?: string;
	provenanceUrl?: string;
	trustedPublisher: "verified" | "not-verified" | "unknown";
}

export interface DownloadObservations {
	weekly?: number;
	monthly?: number;
	observedAt: string;
}

export interface Pkg {
	name: string;
	version: string;
	description?: string;
	date?: string;
	packageEvidence?: PackageEvidence;
	publication?: PublicationEvidence;
}

export interface PkgInfo {
	name: string;
	version: string;
	description?: string;
	homepage?: string;
	repository?: string;
	/** Monorepo subdirectory the package lives in, from repository.directory
	 * -- scopes a real commit-history lookup to the package's own path. */
	repositoryDirectory?: string;
	license?: string;
	keywords?: string[];
	pi?: Record<string, unknown>;
	modified?: string;
	unpackedSize?: number;
	readme?: string;
	readmeAvailable?: boolean;
	bugs?: string;
	peerDependencies?: Record<string, string>;
	packageEvidence?: PackageEvidence;
	publication?: PublicationEvidence;
	downloads?: DownloadObservations;
}

export interface SearchPage {
	results: Pkg[];
	total: number;
}

/** Driven port: package metadata source (npm registry, or the daemon proxy). */
export interface Registry {
	search(query: string, limit: number): Promise<SearchPage>;
	searchPage(query: string, from: number, size: number): Promise<SearchPage>;
	searchAll(query: string): Promise<Pkg[]>;
	info(name: string): Promise<PkgInfo>;
	downloads?(name: string): Promise<DownloadObservations>;
	/** Last npm publish date across any version, from the abbreviated
	 * multi-version doc -- the `/latest` endpoint `info()` uses carries no
	 * `time`/`modified` field at all. Optional, like `downloads`; undefined
	 * on any failure, never thrown. */
	modifiedAt?(name: string): Promise<string | undefined>;
}

/**
 * `pi update --extension <source>` exits 0 and prints "Updated <source>"
 * whether or not anything actually changed -- verified empirically against
 * both a pinned, already-current source and an unpinned, already-latest
 * one. reloadRequired/alreadyUpToDate are ground truth (on-disk resolved
 * version, before vs. after), not that text. previousVersion/currentVersion
 * are omitted when unknown (git:/https: sources, or no node_modules entry
 * to read) -- reloadRequired then conservatively stays true rather than
 * guessing.
 */
export interface UpdateOutcome {
	output: string;
	reloadRequired: boolean;
	alreadyUpToDate: boolean;
	pinned: boolean;
	previousVersion?: string;
	currentVersion?: string;
}

/** Driven port: pi CLI mutations. */
export interface Installer {
	install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string>;
	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string>;
	update(source: string, options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome>;
}

export interface InstalledPkg {
	name: string;
	pinned?: string;
	installed?: string;
}

export interface UpdateEntry {
	name: string;
	installed: string;
	latest: string;
	detectedAt?: string;
}

export interface UpdatesSnapshot {
	checkedAt: string;
	updates: UpdateEntry[];
}

/** Scope every query to pi packages unless the caller already qualified it. */
import { PI_PACKAGE_KEYWORD } from "./constants.ts";

export function buildSearchQuery(q: string): string {
	const t = q.trim();
	if (t.includes("keywords:")) return t;
	return t === "" ? PI_PACKAGE_KEYWORD : `${PI_PACKAGE_KEYWORD} ${t}`;
}

export function clampLimit(v: number, def: number, max: number): number {
	if (!Number.isFinite(v) || v <= 0) return def;
	return Math.min(v, max);
}
