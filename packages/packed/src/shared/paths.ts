import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type DaemonPaths, type PathEnvironment, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { DB_FILE, ENV, SECURITY_FILE, SETTINGS_FILE, UPDATES_FILE } from "./constants.ts";

const PATH_NAMES = {
	stateDirectoryName: "pi-packed",
	databaseFilename: DB_FILE,
	tokenFilename: "token",
	handleFilename: "handle.json",
	systemdUnitName: "pi-packed.service",
} as const;

export interface PackedPaths extends DaemonPaths {
	stateDirectory: string;
}

export function resolvePackedPaths(options: PathEnvironment = {}): PackedPaths {
	const env = options.env ?? process.env;
	const override = env[ENV.HOME];
	if (override) {
		const directory = resolve(override);
		return {
			database: join(directory, DB_FILE),
			token: join(directory, PATH_NAMES.tokenFilename),
			handle: join(directory, PATH_NAMES.handleFilename),
			serviceDescriptor: join(directory, PATH_NAMES.systemdUnitName),
			stateDirectory: directory,
		};
	}
	const paths = resolveDaemonPaths(PATH_NAMES, options);
	return { ...paths, stateDirectory: dirname(paths.token) };
}

export function legacyPackedStateDirectory(options: Pick<PathEnvironment, "env" | "home"> = {}): string {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	return join(env["XDG_CACHE_HOME"] ?? join(home, ".cache"), "pi-packed");
}

function copyIfMissing(source: string, destination: string): void {
	if (!existsSync(source) || existsSync(destination)) return;
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = `${destination}.${process.pid}.tmp`;
	try {
		copyFileSync(source, temporary);
		chmodSync(temporary, 0o600);
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function copyDatabaseIfMissing(source: string, destination: string): void {
	if (!existsSync(source) || existsSync(destination)) return;
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = `${destination}.${process.pid}.migration`;
	const suffixes = ["", "-wal", "-shm"] as const;
	try {
		for (const suffix of suffixes) {
			if (!existsSync(`${source}${suffix}`)) continue;
			copyFileSync(`${source}${suffix}`, `${temporary}${suffix}`);
			chmodSync(`${temporary}${suffix}`, 0o600);
		}
		for (const suffix of ["-shm", "-wal"] as const) {
			if (existsSync(`${temporary}${suffix}`)) renameSync(`${temporary}${suffix}`, `${destination}${suffix}`);
		}
		renameSync(temporary, destination);
	} finally {
		for (const suffix of suffixes) rmSync(`${temporary}${suffix}`, { force: true });
	}
}

/** Keeps existing installs usable while moving process discovery into daemon-kit's XDG split. */
export function migrateLegacyPackedState(paths: PackedPaths, legacyDirectory = legacyPackedStateDirectory()): void {
	if (resolve(legacyDirectory) === resolve(paths.stateDirectory)) return;
	copyDatabaseIfMissing(join(legacyDirectory, DB_FILE), paths.database);
	for (const filename of [SECURITY_FILE, SETTINGS_FILE, UPDATES_FILE]) {
		copyIfMissing(join(legacyDirectory, filename), join(paths.stateDirectory, filename));
	}
	const legacyToken = join(legacyDirectory, PATH_NAMES.tokenFilename);
	try {
		if (/^[a-f0-9]{64}$/.test(readFileSync(legacyToken, "utf8").trim())) copyIfMissing(legacyToken, paths.token);
	} catch {
		// Old Packed tokens were 128-bit. daemon-kit intentionally rotates them to 256-bit.
	}
}
