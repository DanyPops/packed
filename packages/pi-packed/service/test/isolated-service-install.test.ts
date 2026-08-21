import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedDaemonPackageMaterializer } from "../src/daemon/isolated-service-install.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "packed-isolated-service-"));
	roots.push(root);
	return root;
}

function writeInstalledPackage(piHome: string, name: string, version: string): void {
	const directory = join(piHome, "npm", "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
}

function writeFakeNpm(root: string, vehicleVersions: string | Record<string, string> = "0.10.3"): string {
	const path = join(root, `fake-npm-${crypto.randomUUID()}`);
	writeFileSync(
		path,
		`#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const project = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
if (project.overrides) throw new Error("host overrides leaked into isolated project");
const [name, version] = Object.entries(project.dependencies)[0];
const vehicleVersions = ${JSON.stringify(vehicleVersions)};
const vehicleVersion = typeof vehicleVersions === "string" ? vehicleVersions : vehicleVersions[name];
if (!vehicleVersion) throw new Error("missing fake Vehicle version for " + name);
const packageDir = path.join(process.cwd(), "node_modules", name);
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version, packed: { daemonService: { binPath: "src/cli.ts", args: ["serve"] } } }));
const vehicleDir = path.join(packageDir, "node_modules", "@danypops", "vehicle-client");
fs.mkdirSync(vehicleDir, { recursive: true });
fs.writeFileSync(path.join(vehicleDir, "package.json"), JSON.stringify({ name: "@danypops/vehicle-client", version: vehicleVersion }));
`,
	);
	chmodSync(path, 0o755);
	return path;
}

describe("IsolatedDaemonPackageMaterializer", () => {
	it("materializes a private dependency closure that cannot inherit the host project's incompatible override", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		mkdirSync(join(piHome, "npm"), { recursive: true });
		writeFileSync(
			join(piHome, "npm", "package.json"),
			JSON.stringify({
				dependencies: { "@danypops/lector": "0.19.21" },
				overrides: { "@danypops/vehicle-client": "0.6.2" },
			}),
		);
		writeInstalledPackage(piHome, "@danypops/lector", "0.19.21");
		writeInstalledPackage(piHome, "@danypops/vehicle-client", "0.6.2");
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, writeFakeNpm(root));

		const result = await materializer.materialize(piHome, "npm:@danypops/lector");
		const isolatedLector = join(result.piHome, "npm", "node_modules", "@danypops", "lector");
		const isolatedVehicle = join(isolatedLector, "node_modules", "@danypops", "vehicle-client", "package.json");

		expect(JSON.parse(readFileSync(isolatedVehicle, "utf8")).version).toBe("0.10.3");
		expect(JSON.parse(readFileSync(join(piHome, "npm", "node_modules", "@danypops", "vehicle-client", "package.json"), "utf8")).version).toBe("0.6.2");
		expect(result.source).toBe("npm:@danypops/lector@0.19.21");
		expect(existsSync(join(isolatedLector, "package.json"))).toBe(true);
		expect(materializer.ownsExecutable(join(isolatedLector, "src", "cli.ts"))).toBe(true);
		expect(materializer.ownsExecutable(join(piHome, "npm", "node_modules", "@danypops", "lector", "src", "cli.ts"))).toBe(false);
		result.commit();
	});

	it("keeps two managed daemons with incompatible shared dependency requirements in separate roots", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		writeInstalledPackage(piHome, "daemon-old", "1.0.0");
		writeInstalledPackage(piHome, "daemon-new", "2.0.0");
		const materializer = new IsolatedDaemonPackageMaterializer(
			stateDirectory,
			writeFakeNpm(root, { "daemon-old": "0.6.2", "daemon-new": "0.10.5" }),
		);

		const oldDaemon = await materializer.materialize(piHome, "npm:daemon-old");
		const newDaemon = await materializer.materialize(piHome, "npm:daemon-new");
		const versionAt = (materialized: { piHome: string }, name: string) =>
			JSON.parse(
				readFileSync(join(materialized.piHome, "npm", "node_modules", name, "node_modules", "@danypops", "vehicle-client", "package.json"), "utf8"),
			).version;

		expect(versionAt(oldDaemon, "daemon-old")).toBe("0.6.2");
		expect(versionAt(newDaemon, "daemon-new")).toBe("0.10.5");
		expect(oldDaemon.piHome).not.toBe(newDaemon.piHome);
		oldDaemon.commit();
		newDaemon.commit();
	});

	it("publishes complete roots atomically and removes an uncommitted candidate on rollback", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		writeInstalledPackage(piHome, "daemon", "1.0.0");
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, writeFakeNpm(root));

		const result = await materializer.materialize(piHome, "npm:daemon");
		const versionDirectory = join(result.piHome, "..");
		expect(existsSync(join(result.piHome, "npm", "node_modules", "daemon", "package.json"))).toBe(true);
		expect(readdirSync(join(stateDirectory, "services", "daemon")).some((name) => name.startsWith("."))).toBe(false);

		result.rollback();
		expect(existsSync(versionDirectory)).toBe(false);
	});

	it("retains only the active and immediately previous committed versions", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, writeFakeNpm(root));
		for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
			writeInstalledPackage(piHome, "daemon", version);
			const installed = await materializer.materialize(piHome, "npm:daemon");
			installed.commit();
		}

		expect(readdirSync(join(stateDirectory, "services", "daemon")).filter((name) => !name.startsWith(".")).sort()).toEqual([
			"1.1.0",
			"1.2.0",
		]);
	});

	it("cleans bounded stale crash candidates without touching a fresh concurrent candidate", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		const packageRoot = join(stateDirectory, "services", "daemon");
		const stale = join(packageRoot, ".stale.tmp");
		const fresh = join(packageRoot, ".fresh.tmp");
		mkdirSync(stale, { recursive: true });
		mkdirSync(fresh, { recursive: true });
		const old = new Date(Date.now() - 10 * 60 * 1_000);
		utimesSync(stale, old, old);
		writeInstalledPackage(piHome, "daemon", "1.0.0");
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, writeFakeNpm(root));

		const installed = await materializer.materialize(piHome, "npm:daemon");

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		installed.rollback();
	});

	it("rejects an unsafe installed version before creating a service directory", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		writeInstalledPackage(piHome, "daemon", "../../escape");
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, writeFakeNpm(root));

		await expect(materializer.materialize(piHome, "npm:daemon")).rejects.toThrow(/version is unsafe/);
		expect(existsSync(join(stateDirectory, "services"))).toBe(false);
	});

	it("reuses a committed version without invoking npm again and removes all roots on uninstall", async () => {
		const root = temporaryRoot();
		const piHome = join(root, "pi");
		const stateDirectory = join(root, "state");
		writeInstalledPackage(piHome, "daemon", "1.0.0");
		const npmBin = writeFakeNpm(root);
		const materializer = new IsolatedDaemonPackageMaterializer(stateDirectory, npmBin);
		const first = await materializer.materialize(piHome, "npm:daemon");
		first.commit();
		rmSync(npmBin);

		const second = await materializer.materialize(piHome, "npm:daemon");
		expect(second.piHome).toBe(first.piHome);
		second.commit();
		materializer.remove("npm:daemon");
		expect(existsSync(join(stateDirectory, "services", "daemon"))).toBe(false);
	});
});
