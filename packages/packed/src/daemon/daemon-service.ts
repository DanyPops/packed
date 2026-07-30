/**
 * daemon-service.ts — resolves an installed npm package's own persistent-
 * daemon declaration into a real daemon-kit ServiceSpec, and installs it
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { installUserService, type ServiceInstallDeps, type ServiceInstallResult, type ServiceSpec } from "@danypops/daemon-kit/service";
import { npmPackageName } from "../packages/installed.ts";

export interface DaemonServiceManifest {
	/** Relative to the installed package's own root directory. */
	binPath: string;
	args?: string[];
	/** Defaults to the bare npm package name (scope stripped). Used for the state-directory/unit name, matching each package's own service-install convention (e.g. web-spider.service). */
	name?: string;
	displayName?: string;
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
}

interface InstalledPackageJson {
	name?: string;
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

/** @danypops/vehicle-server is the current substrate; @danypops/daemon-kit is the pre-absorption package name several real daemons (web-spider, packed, enigma) still depend on as of this module's introduction -- both are real, live signals, not just the current one. */
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
 * daemon dependency into its own node_modules during `pi install`).
 * `args` defaults to `["serve"]` -- confirmed as a real, universal
 * convention across every daemon-backed package checked (papyrus,
 * web-spider, packed, enigma all expose a `serve` subcommand on the same
 * bin their `service install` command already points at).
 */
export function detectVehicleDaemonService(packageDir: string, fallbackName: string): ResolvedDaemonEntrypoint | undefined {
	const own = readPackageJson(packageDir);
	if (!own) return undefined;

	const ownBin = firstBinPath(own);
	if (ownBin && dependsOnVehicle(own)) {
		return { binPath: join(packageDir, ownBin), args: ["serve"], name: unscopedName(own.name ?? fallbackName) };
	}

	for (const depName of Object.keys(own.dependencies ?? {})) {
		const depDir = join(packageDir, "node_modules", depName);
		const dep = readPackageJson(depDir);
		if (!dep) continue;
		const depBin = firstBinPath(dep);
		if (depBin && dependsOnVehicle(dep)) {
			return { binPath: join(depDir, depBin), args: ["serve"], name: unscopedName(dep.name ?? depName) };
		}
	}
	return undefined;
}

function buildSpec(entry: ResolvedDaemonEntrypoint): ServiceSpec {
	const paths = resolveDaemonPaths({
		stateDirectoryName: entry.name,
		// Only serviceDescriptor is used below; these three exist purely to
		// satisfy resolveDaemonPaths()'s shared shape for a package this
		// module never opens the db/token/handle of.
		databaseFilename: "unused.db",
		tokenFilename: "unused-token",
		handleFilename: "unused-handle.json",
		systemdUnitName: `${entry.name}.service`,
	});
	return {
		name: entry.name,
		displayName: entry.displayName,
		binPath: entry.binPath,
		args: entry.args,
		descriptorPath: paths.serviceDescriptor,
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
			}),
		};
	}

	const detected = detectVehicleDaemonService(packageDir, packageName);
	if (detected) return { ok: true, spec: buildSpec(detected) };

	return { ok: false, notADaemon: true, reason: `${packageName} does not declare a packed.daemonService manifest and no Vehicle-shaped daemon dependency was detected` };
}

/** Real (non-test) ServiceInstallDeps -- node:fs/node:child_process, mirroring the same shape daemon-kit's own service.test.ts fakes for tests. */
export function realServiceInstallDeps(): ServiceInstallDeps {
	return {
		writeFile: (path, content) => writeFileSync(path, content, "utf8"),
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		removeFile: (path) => {
			try {
				rmSync(path, { force: true });
			} catch {
				/* already gone */
			}
		},
		fileExists: (path) => existsSync(path),
		mkdirp: (path) => mkdirSync(path, { recursive: true }),
		runCommand: (command, args) => {
			try {
				const output = execFileSync(command, args, { encoding: "utf8" });
				return { ok: true, output };
			} catch (error) {
				const stdout = typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : "";
				const stderr = typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : "";
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, output: [stdout, stderr].filter(Boolean).join("\n") || message };
			}
		},
		which: (binary) => {
			try {
				execFileSync(process.platform === "win32" ? "where" : "which", [binary], { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		},
		uid: process.getuid?.(),
	};
}

export interface DaemonServiceInstaller {
	install(piHome: string, source: string): { ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean };
}

export class RealDaemonServiceInstaller implements DaemonServiceInstaller {
	install(piHome: string, source: string): { ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean } {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		const result = installUserService(resolved.spec, realServiceInstallDeps());
		return { ok: true, result, spec: resolved.spec };
	}
}
