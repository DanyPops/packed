/**
 * deploy-verify.ts — answers "did a publish/install actually land
 * everywhere it should have" as one deterministic check, instead of the
 * hand-diffing ceremony repeated after nearly every @danypops/* publish:
 * comparing a package's on-disk version at every known install location
 * (Pi's own npm project, Bun's global install cache) against an expected
 * version, plus scanning for a stale nested node_modules "shadow" copy one
 * level below another installed package's own node_modules -- exactly the
 * layout ExecInstaller.reresolveDependencyTree() already fixes for the
 * install path (see install.ts), surfaced here read-only for diagnosis.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstallLocation {
	readonly label: string;
	readonly packageJsonPath: string;
}

export interface LocationStatus extends InstallLocation {
	/** undefined when the location has no readable package.json at all. */
	readonly version?: string;
	readonly mtimeMs?: number;
	readonly present: boolean;
	/** Only meaningful when present -- false whenever present is false too. */
	readonly upToDate: boolean;
}

export interface DeployVerification {
	readonly packageName: string;
	readonly expectedVersion?: string;
	readonly locations: readonly LocationStatus[];
	readonly shadowCopies: readonly LocationStatus[];
	/**
	 * false when expectedVersion is unknown, a *present* known location is
	 * behind it, or a shadow copy exists at all (a shadow copy is always a
	 * problem regardless of its own version -- it can shadow the correct
	 * top-level install for whichever importer's own node_modules walk
	 * reaches it first). A location simply being absent (e.g. this package
	 * was never installed via `bun install -g`) never fails this by
	 * itself -- only a present-but-stale copy does.
	 */
	readonly ok: boolean;
}

function readVersionAndMtime(packageJsonPath: string): { version?: string; mtimeMs?: number } {
	try {
		const mtimeMs = statSync(packageJsonPath).mtimeMs;
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
		return { version: typeof pkg.version === "string" ? pkg.version : undefined, mtimeMs };
	} catch {
		return {};
	}
}

function statusOf(location: InstallLocation, expectedVersion: string | undefined): LocationStatus {
	const { version, mtimeMs } = readVersionAndMtime(location.packageJsonPath);
	return { ...location, version, mtimeMs, present: version !== undefined, upToDate: version !== undefined && version === expectedVersion };
}

/** Every location Packed itself installs an npm-sourced package into --
 * Pi's own npm project (piHome/npm) and Bun's own global install cache
 * (used by `bun install -g`/bunx-adjacent flows, not something Packed
 * writes to itself, but a real place a stale copy can quietly linger).
 * `home` defaults to the real home directory; injectable so a test never
 * has to read or write outside its own tmpdir fixture. */
export function standardInstallLocations(piHome: string, packageName: string, home: string = homedir()): InstallLocation[] {
	return [
		{ label: "Pi npm project", packageJsonPath: join(piHome, "npm", "node_modules", packageName, "package.json") },
		{
			label: "Bun global install cache",
			packageJsonPath: join(home, ".cache", ".bun", "install", "global", "node_modules", packageName, "package.json"),
		},
	];
}

/** Bounded to Pi npm project's own direct children (and one level into a
 * scope directory) -- the exact shape ExecInstaller.reresolveDependencyTree()
 * fixes for the install path: a sibling package's own node_modules holding
 * a nested copy of a shared dependency that a targeted `pi update`/`pi
 * install` never reaches, only a full-tree `npm install` does. Never
 * descends into a shadow copy's own node_modules -- one level is the real,
 * confirmed-live shape; deeper nesting is npm's own problem to dedupe. */
export function findShadowCopies(piHome: string, packageName: string): InstallLocation[] {
	const npmNodeModulesDir = join(piHome, "npm", "node_modules");
	const found: InstallLocation[] = [];
	let entries: string[];
	try {
		entries = readdirSync(npmNodeModulesDir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry === packageName || entry.startsWith(".")) continue;
		const entryPath = join(npmNodeModulesDir, entry);
		let isDirectory: boolean;
		try {
			isDirectory = statSync(entryPath).isDirectory();
		} catch {
			continue;
		}
		if (!isDirectory) continue;
		if (entry.startsWith("@")) {
			let scoped: string[];
			try {
				scoped = readdirSync(entryPath);
			} catch {
				continue;
			}
			for (const sub of scoped) {
				const nested = join(entryPath, sub, "node_modules", packageName, "package.json");
				if (existsSync(nested)) found.push({ label: `shadow copy under ${entry}/${sub}`, packageJsonPath: nested });
			}
			continue;
		}
		const nested = join(entryPath, "node_modules", packageName, "package.json");
		if (existsSync(nested)) found.push({ label: `shadow copy under ${entry}`, packageJsonPath: nested });
	}
	return found;
}

/**
 * `expectedVersion` defaults to whatever's resolved at Pi's own npm
 * project -- the natural "it was just installed/updated there, does every
 * OTHER known location and shadow copy agree" question this exists to
 * answer without a network round-trip. Pass one explicitly (e.g. the
 * version a publish just produced) to check against that instead.
 */
export function verifyDeploy(piHome: string, packageName: string, expectedVersion?: string, home: string = homedir()): DeployVerification {
	const locations0 = standardInstallLocations(piHome, packageName, home);
	const resolvedExpected = expectedVersion ?? readVersionAndMtime(locations0[0]!.packageJsonPath).version;
	const locations = locations0.map((location) => statusOf(location, resolvedExpected));
	const shadowCopies = findShadowCopies(piHome, packageName).map((location) => statusOf(location, resolvedExpected));
	const ok = resolvedExpected !== undefined && locations.every((l) => !l.present || l.upToDate) && shadowCopies.length === 0;
	return { packageName, expectedVersion: resolvedExpected, locations, shadowCopies, ok };
}

export function formatDeployVerification(report: DeployVerification, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	let out = `${report.ok ? "PASS" : "FAIL"} — ${report.packageName}${report.expectedVersion ? `@${report.expectedVersion}` : " (version unknown -- not found at the primary location either)"}\n`;
	for (const location of report.locations) {
		const state = !location.present ? "MISSING" : location.upToDate ? "ok" : `STALE (${location.version})`;
		out += `  ${state.padEnd(16)} ${location.label} (${location.packageJsonPath})\n`;
	}
	for (const shadow of report.shadowCopies) {
		out += `  SHADOW COPY      ${shadow.label} at ${shadow.version ?? "unknown version"} (${shadow.packageJsonPath})\n`;
	}
	if (report.shadowCopies.length === 0) out += "  no shadow copies found\n";
	return out;
}
