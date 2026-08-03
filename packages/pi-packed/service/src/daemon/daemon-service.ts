/**
 * daemon-service.ts — resolves an installed npm package's own persistent-
 * daemon declaration into a real vehicle-server ServiceSpec, and installs it
 * through the exact same systemd/launchd/Registry mechanism that
 * package's own `<bin> service install` command already uses (daemon-
 * kit's installUserService()), so the two are fully interchangeable for
 * the same package.
 *
 * Answers the gap every daemon-backed pi package shared: `pi install
 * npm:@danypops/web-spider-daemon` (or any equivalent) already gets you a
 * daemon that auto-spawns lazily on first use (see each package's own
 * connectWithPolicy/ensure*Client wiring) -- but surviving a reboot always
 * required separately discovering and running that package's own `service
 * install` command by hand. This lets Packed do it as one more explicitly
 * approved mutation, the same way it already gates install/update/remove.
 *
 * Resolution order: an explicit `packed.daemonService` manifest always
 * wins (covers a non-standard bin name or args), then falls back to
 * detectVehicleDaemonService() -- reading conventions every real
 * daemon-backed package already follows (a `bin` entry, a `serve`
 * subcommand, a real dependency on @danypops/vehicle-server or the
 * legacy @danypops/daemon-kit) instead of requiring every package author
 * to redeclare them. Confirmed live: as of this module's introduction,
 * zero installed packages had adopted the manifest -- an unused opt-in
 * step isn't a real convention, so detection reads what's already true
 * on disk instead of asking for one more declaration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createVehicleRegistrar, type VehicleRegistrar } from "@danypops/armada";
import { resolveDaemonPaths } from "@danypops/vehicle-server/paths";
import {
	isVehicleServiceRegistered,
	registerVehicleService,
	type ServiceInstallResult,
	type ServiceSpec,
	unregisterVehicleService,
} from "@danypops/vehicle-server/service";
import { npmPackageName, readInstalledPackagesAcrossScopes } from "../packages/installed.ts";

export interface DaemonServiceManifest {
	/** Relative to the installed package's own root directory. */
	binPath: string;
	args?: string[];
	/** Defaults to the bare npm package name (scope stripped). */
	name?: string;
	displayName?: string;
	/** Runtime handle filename inside the Vehicle's XDG runtime directory. */
	handleFilename?: string;
	workingDirectory?: string;
	restartOnFailure?: boolean;
	restartSec?: number;
}

export type ResolveDaemonServiceResult =
	| { ok: true; spec: ServiceSpec }
	/** notADaemon: this package (and nothing one level into its own dependencies) is Vehicle-shaped at all -- the overwhelmingly common case for a non-daemon Pi package, distinct from a real failure (systemctl unavailable, spec resolved but install itself failed). A caller composing install + install-service (see cli.ts's `install` command) uses this to stay silent instead of surfacing a false alarm on every ordinary package install. */
	| { ok: false; reason: string; notADaemon?: boolean };

function unscopedName(packageName: string): string {
	const slash = packageName.indexOf("/");
	return slash === -1 ? packageName : packageName.slice(slash + 1);
}

/** A resolved daemon entrypoint, already an absolute binPath -- the common shape both an explicit manifest and detection converge to before a ServiceSpec is built. */
interface ResolvedDaemonEntrypoint {
	binPath: string;
	args?: string[];
	name: string;
	displayName?: string;
	handleFilename?: string;
	workingDirectory?: string;
	restartOnFailure?: boolean;
	restartSec?: number;
	version: string;
}

interface InstalledPackageJson {
	name?: string;
	version?: string;
	bin?: string | Record<string, string>;
	dependencies?: Record<string, string>;
	packed?: { daemonService?: DaemonServiceManifest };
}

function readPackageJson(dir: string): InstalledPackageJson | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as InstalledPackageJson;
	} catch {
		return undefined;
	}
}

function firstBinPath(pkg: InstalledPackageJson): string | undefined {
	if (typeof pkg.bin === "string") return pkg.bin;
	if (pkg.bin && typeof pkg.bin === "object") return Object.values(pkg.bin)[0];
	return undefined;
}

/** @danypops/vehicle-server is the current substrate; @danypops/daemon-kit is the pre-absorption package name -- a real, live signal for any not-yet-migrated ecosystem package (or an older installed version of an already-migrated one), not just a historical artifact. */
const VEHICLE_DEPENDENCY_NAMES = ["@danypops/vehicle-server", "@danypops/daemon-kit"];

function dependsOnVehicle(pkg: InstalledPackageJson): boolean {
	const deps = pkg.dependencies ?? {};
	return VEHICLE_DEPENDENCY_NAMES.some((depName) => depName in deps);
}

/**
 * Detects a Vehicle-shaped (or legacy daemon-kit-shaped) daemon without
 * requiring an explicit packed.daemonService manifest. Checks the
 * installed package itself first (the "I am the daemon" case, e.g.
 * @danypops/papyrus installed directly), then one level into its own
 * `dependencies` (the common case: a Pi extension like @danypops/
 * pi-papyrus has no daemon of its own, but npm already resolved its real
 * daemon dependency during `pi install`). That dependency can land in
 * either of two real, both-observed-live layouts: nested directly under
 * the installing package's own node_modules, or hoisted by npm to the
 * single flat node_modules root every Packed-managed install shares --
 * confirmed live for @danypops/pi-papyrus + @danypops/papyrus, which npm
 * hoists to siblings rather than nesting. `hoistedNodeModulesDir` (when
 * given) is checked as a fallback whenever the nested path misses.
 * `args` defaults to `["serve"]` -- confirmed as a real, universal
 * convention across every daemon-backed package checked (papyrus,
 * web-spider, packed, enigma all expose a `serve` subcommand on the same
 * bin their `service install` command already points at).
 */
export function detectVehicleDaemonService(
	packageDir: string,
	fallbackName: string,
	hoistedNodeModulesDir?: string,
): ResolvedDaemonEntrypoint | undefined {
	const own = readPackageJson(packageDir);
	if (!own) return undefined;

	const ownBin = firstBinPath(own);
	if (ownBin && dependsOnVehicle(own) && own.version) {
		return { binPath: join(packageDir, ownBin), args: ["serve"], name: unscopedName(own.name ?? fallbackName), version: own.version };
	}

	for (const depName of Object.keys(own.dependencies ?? {})) {
		const candidateDirs = [
			join(packageDir, "node_modules", depName),
			...(hoistedNodeModulesDir ? [join(hoistedNodeModulesDir, depName)] : []),
		];
		for (const depDir of candidateDirs) {
			const dep = readPackageJson(depDir);
			if (!dep) continue;
			const depBin = firstBinPath(dep);
			if (depBin && dependsOnVehicle(dep) && dep.version) {
				return { binPath: join(depDir, depBin), args: ["serve"], name: unscopedName(dep.name ?? depName), version: dep.version };
			}
		}
	}
	return undefined;
}

function buildSpec(entry: ResolvedDaemonEntrypoint): ServiceSpec {
	const paths = resolveDaemonPaths({
		stateDirectoryName: entry.name,
		databaseFilename: "unused.db",
		tokenFilename: "unused-token",
		handleFilename: entry.handleFilename ?? "handle.json",
		systemdUnitName: `${entry.name}.service`,
	});
	return {
		name: entry.name,
		displayName: entry.displayName,
		version: entry.version,
		binPath: entry.binPath,
		args: entry.args,
		handlePath: paths.handle,
		workingDirectory: entry.workingDirectory,
		...(entry.restartOnFailure === undefined ? {} : { restartOnFailure: entry.restartOnFailure }),
		...(entry.restartSec === undefined ? {} : { restartSec: entry.restartSec }),
	};
}

/**
 * Resolves the installed package's daemon entrypoint -- an explicit
 * `packed.daemonService` manifest first, then detectVehicleDaemonService()
 * -- and builds the exact ServiceSpec its own `service install` command
 * would build. npm sources only for now; git:/local sources resolve to a
 * different on-disk layout not yet supported here.
 */
export function resolveDaemonServiceSpec(piHome: string, source: string): ResolveDaemonServiceResult {
	const packageName = npmPackageName(source);
	if (!packageName) return { ok: false, reason: "daemon-service installation only supports npm: sources today" };

	const packageDir = join(piHome, "npm", "node_modules", packageName);
	const pkg = readPackageJson(packageDir);
	if (!pkg) return { ok: false, reason: `could not read ${join(packageDir, "package.json")} -- is ${packageName} installed?` };

	const manifest = pkg.packed?.daemonService;
	if (manifest && typeof manifest.binPath === "string" && manifest.binPath.length > 0) {
		return {
			ok: true,
			spec: buildSpec({
				binPath: join(packageDir, manifest.binPath),
				args: manifest.args,
				name: manifest.name ?? unscopedName(packageName),
				displayName: manifest.displayName,
				handleFilename: manifest.handleFilename,
				workingDirectory: manifest.workingDirectory,
				restartOnFailure: manifest.restartOnFailure,
				restartSec: manifest.restartSec,
				version: pkg.version ?? "0.0.0",
			}),
		};
	}

	const detected = detectVehicleDaemonService(packageDir, packageName, join(piHome, "npm", "node_modules"));
	if (detected) return { ok: true, spec: buildSpec(detected) };

	return {
		ok: false,
		notADaemon: true,
		reason: `${packageName} does not declare a packed.daemonService manifest and no Vehicle-shaped daemon dependency was detected`,
	};
}

export interface ReconcileAllResult {
	reconciled: Array<{ packageName: string; vehicleName: string; installed: boolean; reason?: string }>;
	skipped: number;
	failed: Array<{ packageName: string; reason: string }>;
}

/** Matches readPackageDeclarations' own bound -- a reconcile-all sweep never processes an unbounded package list. */
const MAX_RECONCILE_PACKAGES = 500;

/**
 * Sweeps every installed Packed package (global scope, plus a project's own
 * pins when projectRoot is given), resolves each to a Vehicle-shaped daemon
 * exactly as install()/restart() already do per-package, and upserts +
 * reconciles it through Armada. This is what makes Armada authoritative for
 * every Vehicle Packed knows about, not just the one source a single
 * install/update call happened to touch -- it also self-heals a Vehicle
 * whose daemon package version bumped as someone else's transitive
 * dependency, and a Vehicle a prior Packed version never registered at all.
 * Idempotent and safe to call unconditionally: a non-daemon package costs
 * one or two file reads (see resolveDaemonServiceSpec) and never reaches
 * Armada. Two packages that resolve to the same Vehicle (a Pi extension and
 * its own daemon dependency, both separately Packed-tracked) reconcile it
 * once, not twice.
 */
export async function reconcileAllDaemonServices(
	piHome: string,
	projectRoot: string | undefined,
	installer: Pick<DaemonServiceInstaller, "install">,
): Promise<ReconcileAllResult> {
	const packages = readInstalledPackagesAcrossScopes(piHome, projectRoot).slice(0, MAX_RECONCILE_PACKAGES);
	const reconciled: ReconcileAllResult["reconciled"] = [];
	const failed: ReconcileAllResult["failed"] = [];
	const seen = new Set<string>();
	let skipped = 0;
	for (const pkg of packages) {
		const resolved = await installer.install(piHome, `npm:${pkg.name}`);
		if (!resolved.ok) {
			if (resolved.notADaemon) {
				skipped++;
				continue;
			}
			failed.push({ packageName: pkg.name, reason: resolved.reason });
			continue;
		}
		if (seen.has(resolved.spec.name)) continue;
		seen.add(resolved.spec.name);
		reconciled.push({
			packageName: pkg.name,
			vehicleName: resolved.spec.name,
			installed: resolved.result.installed,
			...(resolved.result.installed ? {} : { reason: resolved.result.reason }),
		});
	}
	return { reconciled, skipped, failed };
}

export interface DaemonServiceInstaller {
	install(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }>;
	remove(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }>;
	restart(
		piHome: string,
		source: string,
	): Promise<{ ok: true; restarted: boolean; reason?: string; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }>;
}

/**
 * Calls Armada's own VehicleRegistrar directly (in-process), rather than
 * shelling out to its CLI as a subprocess -- the same registration logic
 * `@danypops/armada` exposes to any other library consumer, not a Packed-
 * specific reimplementation. One registrar per instance so its manifest
 * path/native controller are resolved once, not on every call.
 */
export class RealDaemonServiceInstaller implements DaemonServiceInstaller {
	constructor(private readonly registrar: VehicleRegistrar = createVehicleRegistrar()) {}

	async install(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		const result = await registerVehicleService(resolved.spec, this.registrar);
		return { ok: true, result, spec: resolved.spec };
	}

	async remove(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		const result = await unregisterVehicleService(resolved.spec.name, this.registrar);
		return { ok: true, result, spec: resolved.spec };
	}

	async restart(
		piHome: string,
		source: string,
	): Promise<{ ok: true; restarted: boolean; reason?: string; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		if (!(await isVehicleServiceRegistered(resolved.spec.name, this.registrar))) {
			return { ok: true, restarted: false, reason: `no persistent service is registered for ${resolved.spec.name}`, spec: resolved.spec };
		}
		const result = await registerVehicleService(resolved.spec, this.registrar);
		return {
			ok: true,
			restarted: result.installed,
			...(result.installed ? {} : { reason: result.reason }),
			spec: resolved.spec,
		};
	}
}
