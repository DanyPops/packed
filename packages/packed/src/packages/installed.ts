/** installed.ts — pi's settings.json is the source of truth for what is
 * installed; node_modules supplies versions for unpinned sources. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV, SETTINGS_FILE } from "../shared/constants.ts";
import type { InstalledPkg } from "../shared/ports.ts";

export function splitNpmSource(spec: string): [name: string, version: string] {
	const i = spec.lastIndexOf("@");
	if (i <= 0) return [spec, ""];
	return [spec.slice(0, i), spec.slice(i + 1)];
}

function extractSource(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		const s = (entry as Record<string, unknown>)["source"];
		if (typeof s === "string") return s;
	}
	return "";
}

function nodeModulesVersion(piHome: string, name: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(piHome, "npm", "node_modules", name, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * True when a configured npm: source pins an exact version, e.g.
 * "npm:@scope/pkg@1.2.3" vs. the floating "npm:@scope/pkg". `pi update`
 * intentionally leaves pinned sources unchanged (see readInstalledPackages)
 * but still exits 0 and prints "Updated <source>" either way -- callers
 * must not treat that text as proof anything changed.
 */
export function isPinnedNpmSource(source: string): boolean {
	if (!source.startsWith("npm:")) return false;
	const [, pinned] = splitNpmSource(source.slice(4));
	return pinned !== "";
}

/** The bare npm package name for a configured npm: source, pinned or not.
 * undefined for git:/https: sources -- there is no npm-registry name to read. */
export function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const [name] = splitNpmSource(source.slice(4));
	return name;
}

/** Reads a single npm package's real on-disk resolved version, regardless of
 * whether its configured source is pinned -- ground truth for detecting
 * whether an update actually changed anything. undefined for non-npm
 * sources or when node_modules has no matching package.json to read. */
export function readResolvedVersion(piHome: string, source: string): string | undefined {
	const name = npmPackageName(source);
	return name ? nodeModulesVersion(piHome, name) : undefined;
}

export function readResolvedIntegrity(piHome: string, source: string): string | undefined {
	const name = npmPackageName(source);
	if (!name) return undefined;
	try {
		const lock = JSON.parse(readFileSync(join(piHome, "npm", "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: unknown }> };
		const integrity = lock.packages?.[`node_modules/${name}`]?.integrity;
		return typeof integrity === "string" ? integrity : undefined;
	} catch { return undefined; }
}

export function readPackageDeclarations(piHome: string): string[] {
	let settings: { packages?: unknown[] };
	try { settings = JSON.parse(readFileSync(join(piHome, SETTINGS_FILE), "utf8")); }
	catch { return []; }
	return (settings.packages ?? []).map(extractSource).filter((source) => source.length > 0).slice(0, 500);
}

export function readInstalledPackages(piHome: string): InstalledPkg[] {
	const out: InstalledPkg[] = [];
	for (const source of readPackageDeclarations(piHome)) {
		if (!source.startsWith("npm:")) continue;
		const [name, pinned] = splitNpmSource(source.slice(4));
		out.push({
			name,
			pinned: pinned || undefined,
			installed: pinned ? undefined : nodeModulesVersion(piHome, name),
		});
	}
	return out;
}

/**
 * Global scope alone is invisible to a project's own .pi/settings.json pin --
 * confirmed live: a project pinned a stale major version of a since-split
 * package, and nothing in packed's own drift detection ever saw it. Merges
 * global and (when given) project-scoped declarations, tagging each so a
 * name pinned differently in each scope is reported twice, not silently
 * deduped into one.
 */
export function readInstalledPackagesAcrossScopes(piHome: string, projectRoot?: string): InstalledPkg[] {
	const global = readInstalledPackages(piHome).map((pkg) => ({ ...pkg, scope: "global" as const }));
	if (!projectRoot) return global;
	const project = readInstalledPackages(join(projectRoot, ".pi")).map((pkg) => ({ ...pkg, scope: "project" as const }));
	return [...global, ...project];
}

export function defaultPiHome(): string {
	const envHome = process.env[ENV.PI_HOME];
	if (envHome) return envHome;
	return join(homedir(), ".pi", "agent");
}
