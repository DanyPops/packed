import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { npmPackageName } from "../packages/installed.ts";

const MAX_VERSION_DIRECTORIES = 20;
const RETAINED_VERSION_DIRECTORIES = 2;
const MAX_INSTALL_OUTPUT_BYTES = 64 * 1024;
const VERSION_DIRECTORY_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

export interface MaterializedDaemonPackage {
	readonly piHome: string;
	readonly source: string;
	commit(): void;
	rollback(): void;
}

export interface DaemonPackageMaterializer {
	materialize(piHome: string, source: string): Promise<MaterializedDaemonPackage>;
	remove(source: string): void;
	ownsExecutable(path: string): boolean;
}

function readVersion(packageJsonPath: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let retainedBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (retainedBytes >= MAX_INSTALL_OUTPUT_BYTES) continue;
		const remaining = MAX_INSTALL_OUTPUT_BYTES - retainedBytes;
		const retained = value.byteLength <= remaining ? value : value.slice(0, remaining);
		output += decoder.decode(retained, { stream: true });
		retainedBytes += retained.byteLength;
	}
	return output + decoder.decode();
}

function packageDirectory(piHome: string, packageName: string): string {
	return join(piHome, "npm", "node_modules", packageName);
}

function installKey(packageName: string): string {
	return encodeURIComponent(packageName).replaceAll("%", "_");
}

function isolatedPiHome(versionDirectory: string): string {
	return join(versionDirectory, "pi-home");
}

function resolvedPackageJson(piHome: string, packageName: string): string {
	return join(packageDirectory(piHome, packageName), "package.json");
}

export class PassThroughDaemonPackageMaterializer implements DaemonPackageMaterializer {
	async materialize(piHome: string, source: string): Promise<MaterializedDaemonPackage> {
		return { piHome, source, commit() {}, rollback() {} };
	}

	remove(_source: string): void {}

	ownsExecutable(_path: string): boolean {
		return false;
	}
}

/**
 * Installs a daemon source into a private, versioned npm project. The project deliberately has
 * no `overrides` field, so a host-level Pi/Bun override cannot rewrite the daemon's transitive
 * dependency closure. npm's cache remains shared; only resolution metadata and node_modules are
 * private. A completed directory is published with one atomic rename and retained alongside one
 * prior version for rollback.
 */
export class IsolatedDaemonPackageMaterializer implements DaemonPackageMaterializer {
	constructor(
		private readonly stateDirectory: string,
		private readonly npmBin = process.env.PI_PACKED_NPM_BIN ?? process.env.NPM_BIN ?? "npm",
	) {}

	async materialize(piHome: string, source: string): Promise<MaterializedDaemonPackage> {
		const packageName = npmPackageName(source);
		if (!packageName) throw new Error(`isolated daemon installation only supports npm sources: ${source}`);
		const version = readVersion(resolvedPackageJson(piHome, packageName));
		if (!version) throw new Error(`cannot isolate ${packageName}: installed package version is unreadable`);
		if (!VERSION_DIRECTORY_RE.test(version)) throw new Error(`cannot isolate ${packageName}: installed package version is unsafe`);

		const packageRoot = join(this.stateDirectory, "services", installKey(packageName));
		const finalDirectory = join(packageRoot, version);
		const finalPiHome = isolatedPiHome(finalDirectory);
		const finalPackageJson = resolvedPackageJson(finalPiHome, packageName);
		if (readVersion(finalPackageJson) === version) {
			return {
				piHome: finalPiHome,
				source: `npm:${packageName}@${version}`,
				commit: () => this.prune(packageRoot, finalDirectory),
				rollback() {},
			};
		}

		mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
		if (existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
		const temporaryDirectory = join(packageRoot, `.${version}.${process.pid}.${crypto.randomUUID()}.tmp`);
		const temporaryPiHome = isolatedPiHome(temporaryDirectory);
		const projectDirectory = join(temporaryPiHome, "npm");
		mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(projectDirectory, "package.json"),
			JSON.stringify({ name: `packed-service-${installKey(packageName)}`, private: true, dependencies: { [packageName]: version } }, null, 2),
		);

		let publishedByThisCall = false;
		try {
			const proc = Bun.spawn(
				[
					this.npmBin,
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--install-strategy=nested",
					"--loglevel=error",
				],
				{ cwd: projectDirectory, stdout: "pipe", stderr: "pipe", env: process.env },
			);
			const [stdout, stderr, code] = await Promise.all([readBounded(proc.stdout), readBounded(proc.stderr), proc.exited]);
			if (code !== 0) {
				const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
				throw new Error(`isolated npm install failed for ${packageName}@${version} (exit ${code}): ${output || "no output"}`);
			}
			if (readVersion(resolvedPackageJson(temporaryPiHome, packageName)) !== version) {
				throw new Error(`isolated npm install did not resolve ${packageName}@${version}`);
			}
			try {
				renameSync(temporaryDirectory, finalDirectory);
				publishedByThisCall = true;
			} catch (error) {
				if (readVersion(finalPackageJson) !== version) throw error;
				rmSync(temporaryDirectory, { recursive: true, force: true });
			}
		} catch (error) {
			rmSync(temporaryDirectory, { recursive: true, force: true });
			throw error;
		}

		let committed = false;
		return {
			piHome: finalPiHome,
			source: `npm:${packageName}@${version}`,
			commit: () => {
				committed = true;
				this.prune(packageRoot, finalDirectory);
			},
			rollback: () => {
				if (!committed && publishedByThisCall) rmSync(finalDirectory, { recursive: true, force: true });
			},
		};
	}

	remove(source: string): void {
		const packageName = npmPackageName(source);
		if (!packageName) return;
		rmSync(join(this.stateDirectory, "services", installKey(packageName)), { recursive: true, force: true });
	}

	ownsExecutable(path: string): boolean {
		return path.startsWith(join(this.stateDirectory, "services") + sep);
	}

	private prune(packageRoot: string, activeDirectory: string): void {
		let directories: string[];
		try {
			directories = readdirSync(packageRoot)
				.filter((name) => !name.startsWith("."))
				.slice(0, MAX_VERSION_DIRECTORIES)
				.map((name) => join(packageRoot, name))
				.filter((path) => statSync(path).isDirectory());
		} catch {
			return;
		}
		directories.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
		const retained = new Set([activeDirectory, ...directories.slice(0, RETAINED_VERSION_DIRECTORIES)]);
		for (const directory of directories) {
			if (!retained.has(directory)) rmSync(directory, { recursive: true, force: true });
		}
	}
}
