/**
 * resources.ts — enable/disable individual extensions, skills, prompt
 * templates, and themes declared by installed Pi packages, through the
 * same documented settings.json packages[].{extensions,skills,prompts,
 * themes} filter arrays pi config itself writes (docs/packages.md,
 * "Enable and Disable Resources"). Packed owns this mutation the same way
 * it owns every other settings.json change -- atomically, through the
 * daemon -- without importing any of pi's own internal SettingsManager.
 *
 * Scope: npm: sources only for now. git:/local package resource discovery
 * needs a different on-disk resolution strategy and is a documented
 * follow-up; those entries are simply omitted from the list rather than
 * reported inaccurately.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverPackageResources, matchesPattern, type ResourceField, walk } from "../adoption/check.ts";
import { writeJsonAtomic } from "../shared/atomic-json.ts";

export type { ResourceField };

export const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceField[];

const MAX_PACKAGE_ENTRIES = 500;
const MAX_RESOURCE_FILES = 1_000;

export interface ResourceItem {
	path: string;
	enabled: boolean;
}

export type PackageResources = { source: string; name: string; scope: "global" | "project" } & Record<ResourceField, ResourceItem[]>;

interface PackageEntry {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(raw: unknown): PackageEntry | undefined {
	if (typeof raw === "string") return { source: raw };
	if (!isRecord(raw) || typeof raw.source !== "string") return undefined;
	const entry: PackageEntry = { source: raw.source };
	for (const field of RESOURCE_FIELDS) {
		const value = raw[field];
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) entry[field] = value as string[];
	}
	return entry;
}

function readSettingsPackages(settingsPath: string): PackageEntry[] {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown[] };
		return (settings.packages ?? [])
			.map(parseEntry)
			.filter((entry): entry is PackageEntry => entry !== undefined)
			.slice(0, MAX_PACKAGE_ENTRIES);
	} catch {
		return [];
	}
}

/** The bare npm package name for an npm: source, pinned or not. */
function npmName(source: string): string {
	const spec = source.slice("npm:".length);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

export function resolveInstalledDir(piHome: string, source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const dir = join(piHome, "npm", "node_modules", npmName(source));
	return existsSync(dir) ? dir : undefined;
}

/** Layers a settings-level filter over a package's own discovered resource
 * set, matching pi's own package-manager applyPatterns exactly (four
 * ordered steps: bare patterns select from everything when none are given,
 * then !excludes narrow, then +forceIncludes add back from the full base
 * set overriding excludes, then -forceExcludes always win last). An
 * omitted filter key loads everything; [] loads nothing. */
function applyFilter(baseFiles: string[], filter: string[] | undefined): Set<string> {
	if (filter === undefined) return new Set(baseFiles);
	if (filter.length === 0) return new Set(); // an explicit [] disables every resource of this type
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];
	for (const raw of filter) {
		if (raw.startsWith("+")) forceIncludes.push(raw.slice(1));
		else if (raw.startsWith("-")) forceExcludes.push(raw.slice(1));
		else if (raw.startsWith("!")) excludes.push(raw.slice(1));
		else includes.push(raw);
	}
	let result =
		includes.length === 0 ? [...baseFiles] : baseFiles.filter((file) => includes.some((pattern) => matchesPattern(file, pattern)));
	if (excludes.length > 0) result = result.filter((file) => !excludes.some((pattern) => matchesPattern(file, pattern)));
	if (forceIncludes.length > 0) {
		for (const file of baseFiles) {
			if (!result.includes(file) && forceIncludes.includes(file)) result.push(file);
		}
	}
	if (forceExcludes.length > 0) result = result.filter((file) => !forceExcludes.includes(file));
	return new Set(result);
}

function resourcesForEntry(entry: PackageEntry, piHome: string, scope: "global" | "project"): PackageResources | undefined {
	const dir = resolveInstalledDir(piHome, entry.source);
	if (!dir) return undefined;
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	const { files } = walk(dir, MAX_RESOURCE_FILES, []);
	const discovered = discoverPackageResources(dir, pkg, files);
	const result = { source: entry.source, name: npmName(entry.source), scope } as PackageResources;
	for (const field of RESOURCE_FIELDS) {
		const enabled = applyFilter(discovered[field], entry[field]);
		result[field] = discovered[field].map((path) => ({ path, enabled: enabled.has(path) })).sort((a, b) => a.path.localeCompare(b.path));
	}
	return result;
}

/** projectRoot, when given, resolves both .pi/settings.json (declarations)
 * and .pi/ as the install home for project-local npm packages -- the same
 * -l convention setup.ts already uses, so global and project packages of
 * the same name never collide on one resolved directory. */
export function listPackageResources(piHome: string, projectRoot?: string): { global: PackageResources[]; project: PackageResources[] } {
	const global = readSettingsPackages(join(piHome, "settings.json"))
		.map((entry) => resourcesForEntry(entry, piHome, "global"))
		.filter((item): item is PackageResources => item !== undefined);
	if (!projectRoot) return { global, project: [] };
	const projectHome = join(projectRoot, ".pi");
	const project = readSettingsPackages(join(projectHome, "settings.json"))
		.map((entry) => resourcesForEntry(entry, projectHome, "project"))
		.filter((item): item is PackageResources => item !== undefined);
	return { global, project };
}

/** The exact settings.json a toggle targets -- shared by the daemon's
 * resources.toggle route and the standalone CLI fallback so they can never
 * drift onto two different resolutions of the same package's settings. */
export function resolveToggleSettingsPath(piHome: string, projectRoot?: string): string {
	return projectRoot ? join(projectRoot, ".pi", "settings.json") : join(piHome, "settings.json");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await writeJsonAtomic(path, value, { mode: 0o644, pretty: true });
}

export interface ToggleResourceInput {
	settingsPath: string;
	source: string;
	field: ResourceField;
	path: string;
	enabled: boolean;
}

/** Toggles one resource's enabled state by rewriting its package entry's
 * filter array with a minimal +path/-path override -- never touches the
 * package's own glob-based defaults, and is idempotent for the same path.
 * Matches pi's own pi config strip-and-append strategy exactly, including
 * its one known edge case: re-enabling a single resource out of an
 * explicit [] (disable-all-of-this-type) state re-enables the whole type,
 * because the array stops being empty and the general apply-patterns
 * algorithm treats "no bare include pattern" as "include everything" once
 * it is no longer literally []. This is upstream's real behavior, not a
 * Packed-specific bug -- parity with pi's own semantics matters more than
 * a locally "nicer" model the actual loader wouldn't agree with. */
export async function toggleResource(input: ToggleResourceInput): Promise<{ ok: boolean; error?: string }> {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(input.settingsPath, "utf8"));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
	const index = packages.findIndex((raw) => parseEntry(raw)?.source === input.source);
	if (index === -1) return { ok: false, error: `package not found in settings: ${input.source}` };
	const existing = parseEntry(packages[index]);
	if (!existing) return { ok: false, error: `invalid package entry: ${input.source}` };
	const current = existing[input.field] ?? [];
	const withoutOverride = current.filter((entry) => entry !== `+${input.path}` && entry !== `-${input.path}`);
	const updated = [...withoutOverride, `${input.enabled ? "+" : "-"}${input.path}`];
	const merged: Record<string, unknown> =
		typeof packages[index] === "string" ? { source: packages[index] } : { ...(packages[index] as Record<string, unknown>) };
	merged[input.field] = updated;
	packages[index] = merged;
	try {
		await atomicWriteJson(input.settingsPath, { ...settings, packages });
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true };
}

/**
 * Captures a configured package entry's own filter overrides
 * (extensions/skills/prompts/themes +/-path arrays -- see toggleResource's
 * own doc comment) before a replace/update-to-target operation removes it
 * outright: a bare `pi remove` + `pi install` sequence to bump a pinned
 * version replaces the WHOLE settings.json entry, silently reverting any
 * per-resource enable/disable customization the user had configured back
 * to the freshly-installed package's own defaults. undefined when the
 * entry has no filter overrides at all (nothing to preserve) or isn't
 * found (already removed, or never existed as a real entry).
 */
export function captureEntryFilters(settingsPath: string, source: string): Partial<Record<ResourceField, string[]>> | undefined {
	const entry = readSettingsPackages(settingsPath).find((candidate) => candidate.source === source);
	if (!entry) return undefined;
	const filters: Partial<Record<ResourceField, string[]>> = {};
	for (const field of RESOURCE_FIELDS) {
		const value = entry[field];
		if (value) filters[field] = value;
	}
	return Object.keys(filters).length > 0 ? filters : undefined;
}

/**
 * Re-applies a previously captured set of filter overrides onto `source`'s
 * own freshly-created package entry -- the other half of
 * captureEntryFilters, restoring what a replace operation's remove step
 * would otherwise have discarded. A no-op (never throws) when `filters` is
 * undefined/empty, the settings file is unreadable, or `source`'s entry
 * doesn't exist yet (e.g. the install step itself failed and never wrote
 * one) -- there is nothing safe to merge a filter override onto in that
 * case, and the caller's own install failure is already the real error to
 * surface.
 */
export async function applyEntryFilters(
	settingsPath: string,
	source: string,
	filters: Partial<Record<ResourceField, string[]>> | undefined,
): Promise<boolean> {
	if (!filters || Object.keys(filters).length === 0) return true; // nothing to preserve is not a failure
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		return false;
	}
	const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
	const index = packages.findIndex((raw) => parseEntry(raw)?.source === source);
	if (index === -1) return false;
	const merged: Record<string, unknown> =
		typeof packages[index] === "string" ? { source: packages[index] } : { ...(packages[index] as Record<string, unknown>) };
	for (const [field, value] of Object.entries(filters)) merged[field] = value;
	packages[index] = merged;
	try {
		await atomicWriteJson(settingsPath, { ...settings, packages });
		return true;
	} catch {
		// best-effort: the replace itself already succeeded, a filter-preservation
		// write failure here is surfaced to the caller as a non-fatal detail, not
		// a reason to report the whole replace as failed.
		return false;
	}
}
