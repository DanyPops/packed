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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createVehicleRegistrar, type VehicleRegistrar, type VehicleRegistrationOutcome, type VehicleSpec } from "@danypops/armada";
import { resolveDaemonPaths } from "@danypops/vehicle-server/paths";
import {
	isVehicleServiceRegistered,
	registerVehicleService,
	type ServiceInstallResult,
	type ServiceSpec,
	unregisterVehicleService,
} from "@danypops/vehicle-server/service";
import { npmPackageName, readInstalledPackagesAcrossScopes, readPackageDeclarations } from "../packages/installed.ts";
import type { InstalledPkg } from "../packages/package.ts";
import { versionAtLeast } from "../publish/publish.ts";

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
/**
 * Resolves ONE candidate directory to a daemon entrypoint -- factored out
 * so the nested and hoisted candidates for the same dependency name can
 * each be resolved independently and then compared (see
 * detectVehicleDaemonService), instead of the first one found
 * unconditionally winning.
 */
function resolveDependencyCandidate(depDir: string, depName: string): ResolvedDaemonEntrypoint | undefined {
	const dep = readPackageJson(depDir);
	if (!dep) return undefined;
	// An explicit manifest wins over convention detection -- confirmed live: papyrus's real
	// handle file is "vehicle-handle.json", not the "daemon.json" convention guess.
	const depManifest = dep.packed?.daemonService;
	if (depManifest && typeof depManifest.binPath === "string" && depManifest.binPath.length > 0 && dep.version) {
		return {
			binPath: join(depDir, depManifest.binPath),
			args: depManifest.args,
			name: depManifest.name ?? unscopedName(dep.name ?? depName),
			displayName: depManifest.displayName,
			handleFilename: depManifest.handleFilename,
			workingDirectory: depManifest.workingDirectory,
			restartOnFailure: depManifest.restartOnFailure,
			restartSec: depManifest.restartSec,
			version: dep.version,
		};
	}
	const depBin = firstBinPath(dep);
	if (depBin && dependsOnVehicle(dep) && dep.version) {
		return { binPath: join(depDir, depBin), args: ["serve"], name: unscopedName(dep.name ?? depName), version: dep.version };
	}
	return undefined;
}

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
		const resolved = candidateDirs
			.map((depDir) => resolveDependencyCandidate(depDir, depName))
			.filter((entry): entry is ResolvedDaemonEntrypoint => entry !== undefined);
		if (resolved.length === 0) continue;
		if (resolved.length === 1) return resolved[0];
		// Nested and hoisted both resolved for the same dependency (the real jittor incident:
		// a stale nested copy always won just because it's checked first). Prefer the newer
		// version; a genuine tie keeps the nested result, preserving papyrus's intentional case.
		let best = resolved[0]!;
		for (const candidate of resolved.slice(1)) {
			if (versionAtLeast(candidate.version, best.version) && candidate.version !== best.version) best = candidate;
		}
		return best;
	}
	return undefined;
}

/**
 * "daemon.json" -- not "handle.json" -- when a detected daemon carries no explicit
 * packed.daemonService.handleFilename override. Confirmed live across every real Vehicle daemon
 * checked in this ecosystem: jittor, pipes, and web-spider-daemon's own HANDLE_FILENAME constants
 * are all "daemon.json"; only enigma uses "handle.json". A real, reported bug traced back to this
 * default: pipes' Armada vehicle registration kept reverting to the wrong handlePath every time
 * this auto-detect path re-ran, because this guess didn't match pipes' own real convention. Still
 * a guess, not a read of the target package's own actual value -- a package with a real,
 * non-default handleFilename must declare it explicitly via packed.daemonService for a fully
 * correct resolution; this only narrows how often the guess is wrong.
 */
const DEFAULT_DETECTED_HANDLE_FILENAME = "daemon.json";

function buildSpec(entry: ResolvedDaemonEntrypoint): ServiceSpec {
	const paths = resolveDaemonPaths({
		stateDirectoryName: entry.name,
		databaseFilename: "unused.db",
		tokenFilename: "unused-token",
		handleFilename: entry.handleFilename ?? DEFAULT_DETECTED_HANDLE_FILENAME,
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

export interface DaemonDependencyPkg {
	name: string;
	version: string;
	/** The Armada vehicle name resolveDaemonServiceSpec built for this package -- may differ
	 * from `name`'s own bare unscoped form when a packed.daemonService manifest overrides it. */
	vehicleName: string;
}

/** Bare npm package names directly under a node_modules directory -- one level for an
 * unscoped name, two for a @scope/name pair. Never throws; a missing directory (no
 * npm project yet) is just an empty result. */
function listTopLevelPackageNames(nodeModulesDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(nodeModulesDir);
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("@")) {
			names.push(entry);
			continue;
		}
		let scoped: string[];
		try {
			scoped = readdirSync(join(nodeModulesDir, entry));
		} catch {
			continue;
		}
		for (const name of scoped) names.push(`${entry}/${name}`);
	}
	return names;
}

/** Matches reconcileAllDaemonServices' own bound -- a full node_modules sweep never
 * processes an unbounded package list either. */
const MAX_DAEMON_DEPENDENCY_SCAN = 500;

/**
 * Every top-level npm package physically installed under piHome/npm/node_modules
 * that resolveDaemonServiceSpec() itself already recognizes as a real Vehicle-
 * shaped daemon (an explicit packed.daemonService manifest, or
 * detectVehicleDaemonService()'s own-bin-plus-real-vehicle-dependency
 * convention), but that is NOT itself a pi:-configured extension
 * (readPackageDeclarations() has no entry for it) -- e.g. @danypops/lector,
 * added directly to piHome/npm/package.json as an independent pin so it can
 * run ahead of whatever version its own pi-lector wrapper's dependency tree
 * would otherwise resolve. These are real, running Armada vehicles that a
 * pi:-manifest-only "installed packages" notion makes permanently invisible
 * to `packed installed`/`packed update` -- see
 * packed-package-update-restart-service-cant-manage.
 *
 * Deliberately does NOT walk one level into each configured extension's own
 * dependencies the way resolveDaemonServiceSpec's own detection does for
 * install-service/restart-service/doctor (service-doctor.ts's
 * checkServiceUnitPaths already reaches that same dependency through its
 * wrapper extension's own row) -- duplicating that walk here would
 * double-report the same Vehicle under two different package names. This
 * only reports a dependency independently resolvable BY ITS OWN NAME at
 * piHome/npm's own top level -- exactly the shape a caller can actually run
 * `packed update npm:<name>` against directly.
 */
export function listUnconfiguredDaemonDependencies(piHome: string): DaemonDependencyPkg[] {
	const configured = new Set(
		readPackageDeclarations(piHome).flatMap((source) => {
			const name = npmPackageName(source);
			return name ? [name] : [];
		}),
	);
	const names = listTopLevelPackageNames(join(piHome, "npm", "node_modules")).slice(0, MAX_DAEMON_DEPENDENCY_SCAN);
	const out: DaemonDependencyPkg[] = [];
	for (const name of names) {
		if (configured.has(name)) continue;
		const resolved = resolveDaemonServiceSpec(piHome, `npm:${name}`);
		if (resolved.ok) out.push({ name, version: resolved.spec.version, vehicleName: resolved.spec.name });
	}
	return out;
}

/**
 * True when `packageName` (a bare npm name) is a pi:-configured extension --
 * present in readPackageDeclarations()'s own packages[] list, regardless of
 * whether it's pinned. The other half of the classification
 * classifyUpdateSource() needs: a name that resolves ok via
 * resolveDaemonServiceSpec() but returns false here is a "daemon-dependency"
 * class source, not an "extension" one.
 */
export function isConfiguredExtension(piHome: string, packageName: string): boolean {
	return readPackageDeclarations(piHome).some((source) => npmPackageName(source) === packageName);
}

export type UpdateSourceKind = "extension" | "daemon-dependency";

/**
 * Classifies an npm: source for package.update's own two-path mutation:
 * "extension" (pi:-configured, settings.json's packages[] -- `pi update
 * --extension` already handles this correctly, unchanged) vs.
 * "daemon-dependency" (NOT pi:-configured, but resolveDaemonServiceSpec()
 * resolves it directly BY ITS OWN NAME -- pi-core can never see this one;
 * confirmed via this house's own failing-test repro, service/test/
 * install.test.ts, of pi's real "No matching package found"). Needs the
 * alternate npm-level mutation path (Installer.updateDaemonDependency())
 * instead of shelling to `pi update --extension` at all.
 *
 * undefined for a non-npm: source, or an npm: source that is neither
 * (never installed, or installed but not Vehicle-shaped) -- package.update's
 * existing catch-all path (calling `pi update --extension` and surfacing
 * whatever it reports) still applies unchanged to either of those, exactly
 * as it did before this classification existed.
 */
export function classifyUpdateSource(piHome: string, source: string): UpdateSourceKind | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const packageName = npmPackageName(source);
	if (!packageName) return undefined;
	if (isConfiguredExtension(piHome, packageName)) return "extension";
	return resolveDaemonServiceSpec(piHome, source).ok ? "daemon-dependency" : undefined;
}

/**
 * `packed installed`'s real, whole-fleet listing: every pi:-configured
 * extension (`kind: "extension"`, exactly today's
 * readInstalledPackagesAcrossScopes() output, unchanged) PLUS every
 * top-level daemon-only dependency listUnconfiguredDaemonDependencies() can
 * independently resolve (`kind: "daemon-dependency"`) -- so a real, running
 * Armada vehicle like @danypops/lector shows up under its own name instead
 * of staying invisibly nested inside its pi-lector wrapper's own row. See
 * packed-package-update-restart-service-cant-manage.
 *
 * projectRoot only ever widens the extension half (matching
 * readInstalledPackagesAcrossScopes' own scope) -- daemon-dependency
 * detection is global-only for now, since the reported gap itself (an
 * independently-pinned piHome/npm/package.json dependency) is a global-scope
 * shape; a project-scoped .pi/npm equivalent is real future work, not
 * something this fixes today.
 */
export function listManagedPackages(piHome: string, projectRoot?: string): InstalledPkg[] {
	const extensions: InstalledPkg[] = readInstalledPackagesAcrossScopes(piHome, projectRoot).map((pkg) => ({
		...pkg,
		kind: "extension",
	}));
	const daemonDependencies: InstalledPkg[] = listUnconfiguredDaemonDependencies(piHome).map((dep) => ({
		name: dep.name,
		installed: dep.version,
		scope: "global",
		kind: "daemon-dependency",
	}));
	return [...extensions, ...daemonDependencies];
}

export interface ReconcileAllResult {
	reconciled: Array<{ packageName: string; vehicleName: string; installed: boolean; reason?: string }>;
	skipped: number;
	failed: Array<{ packageName: string; reason: string }>;
	/** Every Vehicle unregistered because this sweep no longer discovers it at all -- see pruneStaleVehicles. */
	pruned: Array<{ vehicleName: string; executable: string }>;
	pruneFailed: Array<{ vehicleName: string; reason: string }>;
}

/** Matches readPackageDeclarations' own bound -- a reconcile-all sweep never processes an unbounded package list. */
const MAX_RECONCILE_PACKAGES = 500;
const PACKED_PACKAGE_NAME = "@danypops/pi-packed";
/** Packed's own stable cross-daemon identity -- both its real Armada vehicle name (this file's own
 * self-registration guards below) and, since it's the same daemon, the name it registers under in
 * the shared Vehicle Handle Directory for Vehicle Shell broker mode (see daemon.ts's own
 * daemonOptions() -- vehicleName: PACKED_VEHICLE_NAME). One canonical name, not two. */
export const PACKED_VEHICLE_NAME = "pi-packed";
const SELF_REGISTRATION_REASON = "Packed cannot replace its own Armada service from inside the running daemon";

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
	installer: Pick<DaemonServiceInstaller, "install" | "listRegisteredVehicles" | "unregisterVehicleByName">,
): Promise<ReconcileAllResult> {
	const packages = readInstalledPackagesAcrossScopes(piHome, projectRoot).slice(0, MAX_RECONCILE_PACKAGES);
	const reconciled: ReconcileAllResult["reconciled"] = [];
	const failed: ReconcileAllResult["failed"] = [];
	const seen = new Set<string>();
	let skipped = 0;
	for (const pkg of packages) {
		// Re-registering the daemon from inside its own process makes Armada stop
		// that process before registration can start the replacement.
		if (pkg.name === PACKED_PACKAGE_NAME) {
			skipped++;
			continue;
		}
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
	// Also fold in root-pinned dependencies (e.g. lector) the configured-packages loop above
	// never reaches -- pruning against a narrower set would delete a Vehicle still genuinely there.
	for (const dep of listUnconfiguredDaemonDependencies(piHome)) seen.add(dep.vehicleName);
	const { pruned, pruneFailed } = await pruneStaleVehicles(piHome, seen, installer);
	return { reconciled, skipped, failed, pruned, pruneFailed };
}

/**
 * Unregisters every Vehicle Armada declares that `discovered` no longer
 * produces at all -- otherwise a renamed/collided Vehicle (see the real
 * web-spider-daemon incident) sits in the manifest forever. Scoped to only
 * ever touch a Vehicle whose `executable` lives under piHome's own
 * npm/node_modules -- one Packed itself could plausibly have registered.
 * Packed's own Vehicle is excluded, matching install/remove/restart.
 */
async function pruneStaleVehicles(
	piHome: string,
	discovered: ReadonlySet<string>,
	installer: Pick<DaemonServiceInstaller, "listRegisteredVehicles" | "unregisterVehicleByName">,
): Promise<Pick<ReconcileAllResult, "pruned" | "pruneFailed">> {
	const managedRoot = join(piHome, "npm", "node_modules") + "/";
	const pruned: ReconcileAllResult["pruned"] = [];
	const pruneFailed: ReconcileAllResult["pruneFailed"] = [];
	const registered = await installer.listRegisteredVehicles();
	for (const vehicle of registered) {
		if (vehicle.name === PACKED_VEHICLE_NAME) continue;
		if (discovered.has(vehicle.name)) continue;
		if (!vehicle.executable.startsWith(managedRoot)) continue;
		const outcome = await installer.unregisterVehicleByName(vehicle.name);
		if (outcome.ok) pruned.push({ vehicleName: vehicle.name, executable: vehicle.executable });
		else pruneFailed.push({ vehicleName: vehicle.name, reason: outcome.diagnostics.map((d) => d.message).join("; ") || "unregister failed" });
	}
	return { pruned, pruneFailed };
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
	/** Every Vehicle Armada currently declares -- see pruneStaleVehicles' own doc comment for why this exists. */
	listRegisteredVehicles(): Promise<readonly VehicleSpec[]>;
	/**
	 * Unregisters by Armada vehicle NAME directly, distinct from remove()'s
	 * own by-npm-source resolution -- pruning has no installed package left to
	 * resolve a source from; the whole point is the vehicle survived past
	 * whatever used to produce it.
	 */
	unregisterVehicleByName(name: string): Promise<VehicleRegistrationOutcome>;
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

	async listRegisteredVehicles(): Promise<readonly VehicleSpec[]> {
		return this.registrar.listRegistered();
	}

	async unregisterVehicleByName(name: string): Promise<VehicleRegistrationOutcome> {
		return this.registrar.unregister(name);
	}

	async install(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		if (resolved.spec.name === PACKED_VEHICLE_NAME) {
			return { ok: true, result: { installed: false, reason: SELF_REGISTRATION_REASON }, spec: resolved.spec };
		}
		const result = await registerVehicleService(resolved.spec, this.registrar);
		return { ok: true, result, spec: resolved.spec };
	}

	async remove(
		piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		if (resolved.spec.name === PACKED_VEHICLE_NAME) {
			return { ok: true, result: { installed: false, reason: SELF_REGISTRATION_REASON }, spec: resolved.spec };
		}
		const result = await unregisterVehicleService(resolved.spec.name, this.registrar);
		return { ok: true, result, spec: resolved.spec };
	}

	async restart(
		piHome: string,
		source: string,
	): Promise<{ ok: true; restarted: boolean; reason?: string; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		if (resolved.spec.name === PACKED_VEHICLE_NAME) {
			return { ok: true, restarted: false, reason: SELF_REGISTRATION_REASON, spec: resolved.spec };
		}
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
