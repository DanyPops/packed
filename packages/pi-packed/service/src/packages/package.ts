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
import { gt, valid } from "semver";

/**
 * True drift only: `latest` is a real semver step *ahead* of `have`, never
 * merely different from it. A plain !== check cannot distinguish "have is
 * behind latest" from "have is already ahead of a stale/wrong latest" --
 * confirmed live via the watcher's own version of this bug: an installed
 * package whose version had already passed the daemon's mirrored
 * dist-tags.latest kept showing a permanent, un-clearable "update
 * available" badge pointing at an *older* version. Falls back to the old
 * inequality only when either side isn't parseable semver (a git ref, a
 * literal "latest" tag, etc.) -- those aren't comparable at all, so
 * "different" is the only signal left. Lives here (not watcher.ts, its
 * original home) so both the daemon's watcher and ExecInstaller.update()'s
 * own out-of-range check share one implementation without packages/
 * reaching into daemon/ (the dependency already runs the other way).
 */
export function isNewer(latest: string, have: string): boolean {
	if (valid(latest, { loose: true }) && valid(have, { loose: true })) return gt(latest, have, { loose: true });
	return latest !== have;
}

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
	/**
	 * Set only when alreadyUpToDate is true AND a real registry version
	 * newer than currentVersion exists outside the source's own declared
	 * caret/range -- confirmed live: a 0.x package (e.g. ^0.9.8) that
	 * crossed its own minor boundary (0.10.0 published) reported a bare
	 * "already up to date" with no clue a newer version existed at all.
	 * `pi update --extension` is itself bound by the declared range, so
	 * "nothing changed" alone can't distinguish "genuinely current" from
	 * "current within a range that's now stale" -- this cross-checks
	 * against the same registry-mirror source of truth checkUpdates()
	 * already uses, independent of the declared range.
	 */
	outOfRangeUpdateAvailable?: string;
	/**
	 * True only when update() was called on an exact npm pin with no
	 * options.target -- `pi update --extension` intentionally leaves an
	 * exact pin unchanged (npm's own documented behavior for a versioned
	 * spec), so alreadyUpToDate/pinned above are already an honest,
	 * non-"false success" result. This is an additional stable,
	 * unambiguous machine-readable signal (kept alongside those existing
	 * fields for back-compat) that a caller wanting to actually MOVE the
	 * pin should retry with options.target set -- see replaced/before/
	 * after/rollback below.
	 */
	pinnedSourceRequiresTarget?: boolean;
	/**
	 * True when options.target was given and update() routed to the
	 * supervised replace workflow (remove the old exact source, install
	 * the new one, verify both configured and installed postconditions,
	 * attempt rollback on failure) instead of `pi update --extension`.
	 */
	replaced?: boolean;
	before?: { source: string; version?: string };
	after?: { source: string; version?: string };
	/** Present only on a replace failure -- whether restoring the original
	 * source was attempted and whether that restoration itself succeeded. */
	rollback?: { attempted: boolean; ok: boolean; message?: string };
}

/** Driven port: pi CLI mutations. */
export interface Installer {
	install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string>;
	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string>;
	/**
	 * `options.target`, when given, replaces `source` (an exact pin or not)
	 * with `target` through a supervised remove+install workflow instead of
	 * `pi update --extension` -- see ExecInstaller.update()'s own doc
	 * comment and the linked research doc
	 * (pinned-package-update-behavior-and-safe-replacement-research) for
	 * why a plain `pi update` can never move an exact pin by itself.
	 */
	update(source: string, options?: { approved?: boolean; local?: boolean; target?: string }): Promise<UpdateOutcome>;
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
	/**
	 * "extension" (a real pi:-manifested package, settings.json's own
	 * packages[]) vs. "daemon-dependency" (a Vehicle-shaped daemon Packed
	 * independently detects at piHome/npm's own top level -- e.g.
	 * @danypops/lector -- that is NOT itself pi:-configured). Undefined from
	 * every pre-existing reader (readInstalledPackages/
	 * readInstalledPackagesAcrossScopes); only daemon-service.ts's
	 * listManagedPackages() sets this on every row it returns. See
	 * packed-package-update-restart-service-cant-manage.
	 */
	kind?: "extension" | "daemon-dependency";
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
