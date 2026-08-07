/**
 * package.ts — the Pkg entity and its two driven ports (Registry, Installer)
 * that decouple callers (the HTTP service, the CLI, the watcher, tests) from
 * concrete implementations (registry/registry.ts talks to npm; install.ts
 * shells out to pi).
 */

// InstallValidationResult is a plain, adapter-neutral DTO (ok/source/extensions/message) --
// imported type-only (erased at compile time) from the one adapter that currently produces it
// (HeadlessInstallValidator) rather than duplicating its shape here and risking drift. Installer
// itself stays a pure port: nothing here creates a runtime dependency on install-validation.ts's
// own npm-pack/tar/subprocess machinery.
import type { InstallValidationResult } from "../adoption/install-validation.ts";

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
	/** From npm's own search API response (each hit already carries this inline -- no extra
	 * request per result, unlike PkgInfo.downloads, which needs its own dedicated fetch for a
	 * single already-known package). See HttpRegistry.searchPage(). */
	downloads?: DownloadObservations;
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
	/** Declared npm lifecycle scripts (preinstall/install/postinstall/etc.) --
	 * these execute on install, a top supply-chain attack vector. Presence is
	 * surfaced as trust-dimension evidence, never treated as a failure. */
	scripts?: Record<string, string>;
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
	/**
	 * Optional batch-oriented split of install(), for a caller installing several packages
	 * together (see SetupManager.apply()) -- a single ad hoc install() still does all three
	 * steps itself and needs none of this; every existing Installer implementation that omits
	 * these three keeps compiling and behaving exactly as before.
	 *
	 * validate() is safe to run CONCURRENTLY across many sources: each call stages into its own
	 * throwaway temp directory (see HeadlessInstallValidator) with zero shared state between
	 * packages. installOnly() does the real `pi install` mutation WITHOUT install()'s own
	 * trailing full-tree reresolve, so a batch caller can defer that to
	 * reresolveDependencyTree(), called ONCE after every package in the batch instead of once
	 * per package.
	 *
	 * installOnly() itself must stay SEQUENTIAL across a batch, never fanned out the way
	 * validate() can be: `pi install` does its own non-atomic read-modify-write of both
	 * settings.json and the npm project's package.json/package-lock.json in the single shared
	 * piHome, with no locking on either side (confirmed empirically -- three concurrent `pi
	 * install` calls against one piHome silently lost two of three entries from settings.json
	 * and npm/package.json, while all three packages' node_modules ended up physically present
	 * but untracked, exactly the state a later reresolveDependencyTree() would then prune).
	 */
	validate?(source: string): Promise<InstallValidationResult>;
	installOnly?(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string>;
	reresolveDependencyTree?(): Promise<string>;
}

export interface InstalledPkg {
	name: string;
	pinned?: string;
	installed?: string;
	scope?: "global" | "project";
}

export interface UpdateEntry {
	name: string;
	installed: string;
	latest: string;
	detectedAt?: string;
	scope?: "global" | "project";
}

export interface UpdatesSnapshot {
	checkedAt: string;
	updates: UpdateEntry[];
}

/** Scope every query to pi packages unless the caller already qualified it. */
import { PI_PACKAGE_KEYWORD } from "../shared/constants.ts";

export function buildSearchQuery(q: string): string {
	const t = q.trim();
	if (t.includes("keywords:")) return t;
	return t === "" ? PI_PACKAGE_KEYWORD : `${PI_PACKAGE_KEYWORD} ${t}`;
}

export function clampLimit(v: number, def: number, max: number): number {
	if (!Number.isFinite(v) || v <= 0) return def;
	return Math.min(v, max);
}
