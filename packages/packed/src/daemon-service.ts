/**
 * daemon-service.ts — resolves an installed npm package's own persistent-
 * daemon declaration (`packed.daemonService` in its package.json) into a
 * real daemon-kit ServiceSpec, and installs it through the exact same
 * systemd/launchd/Registry mechanism that package's own `<bin> service
 * install` command already uses (daemon-kit's installUserService()), so
 * the two are fully interchangeable for the same package.
 *
 * Answers the gap every daemon-backed pi package shared: `pi install
 * npm:@danypops/web-spider-daemon` (or any equivalent) already gets you a
 * daemon that auto-spawns lazily on first use (see each package's own
 * connectWithPolicy/ensure*Client wiring) -- but surviving a reboot always
 * required separately discovering and running that package's own `service
 * install` command by hand. This lets Packed do it as one more explicitly
 * approved mutation, the same way it already gates install/update/remove.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { installUserService, type ServiceInstallDeps, type ServiceInstallResult, type ServiceSpec } from "@danypops/daemon-kit/service";
import { npmPackageName } from "./installed.ts";

export interface DaemonServiceManifest {
	/** Relative to the installed package's own root directory. */
	binPath: string;
	args?: string[];
	/** Defaults to the bare npm package name (scope stripped). Used for the state-directory/unit name, matching each package's own service-install convention (e.g. web-spider.service). */
	name?: string;
	displayName?: string;
}

export type ResolveDaemonServiceResult = { ok: true; spec: ServiceSpec } | { ok: false; reason: string };

function unscopedName(packageName: string): string {
	const slash = packageName.indexOf("/");
	return slash === -1 ? packageName : packageName.slice(slash + 1);
}

/**
 * Reads the installed package's own package.json for a `packed.daemonService`
 * declaration and builds the exact ServiceSpec its own `service install`
 * command would build -- npm sources only for now; git:/local sources
 * resolve to a different on-disk layout not yet supported here.
 */
export function resolveDaemonServiceSpec(piHome: string, source: string): ResolveDaemonServiceResult {
	const packageName = npmPackageName(source);
	if (!packageName) return { ok: false, reason: "daemon-service installation only supports npm: sources today" };

	const packageDir = join(piHome, "npm", "node_modules", packageName);
	const packageJsonPath = join(packageDir, "package.json");
	let manifest: DaemonServiceManifest | undefined;
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packed?: { daemonService?: DaemonServiceManifest } };
		manifest = pkg.packed?.daemonService;
	} catch {
		return { ok: false, reason: `could not read ${packageJsonPath} -- is ${packageName} installed?` };
	}
	if (!manifest || typeof manifest.binPath !== "string" || manifest.binPath.length === 0) {
		return { ok: false, reason: `${packageName} does not declare a packed.daemonService manifest in its package.json` };
	}

	const name = manifest.name ?? unscopedName(packageName);
	const paths = resolveDaemonPaths({
		stateDirectoryName: name,
		// Only serviceDescriptor is used below; these three exist purely to
		// satisfy resolveDaemonPaths()'s shared shape for a package this
		// module never opens the db/token/handle of.
		databaseFilename: "unused.db",
		tokenFilename: "unused-token",
		handleFilename: "unused-handle.json",
		systemdUnitName: `${name}.service`,
	});

	return {
		ok: true,
		spec: {
			name,
			displayName: manifest.displayName,
			binPath: join(packageDir, manifest.binPath),
			args: manifest.args,
			descriptorPath: paths.serviceDescriptor,
		},
	};
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
	install(piHome: string, source: string): { ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string };
}

export class RealDaemonServiceInstaller implements DaemonServiceInstaller {
	install(piHome: string, source: string): { ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string } {
		const resolved = resolveDaemonServiceSpec(piHome, source);
		if (!resolved.ok) return resolved;
		const result = installUserService(resolved.spec, realServiceInstallDeps());
		return { ok: true, result, spec: resolved.spec };
	}
}
