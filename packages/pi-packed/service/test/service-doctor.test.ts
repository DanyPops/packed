import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmadaTestHarness } from "@danypops/armada/testing";
import type { ServiceDoctorDeps } from "../src/adoption/service-doctor.ts";
import { checkServiceUnitPaths } from "../src/adoption/service-doctor.ts";
import { RECONCILE_INTERVAL_DEFAULT_MS } from "../src/shared/constants.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function piHome(settingsPackages: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "packed-service-doctor-"));
	roots.push(root);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: settingsPackages }));
	return root;
}

function installDaemonPackage(home: string, name: string): string {
	const dir = join(home, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			packed: { daemonService: { binPath: "cli.ts", handleFilename: "handle.json" } },
		}),
	);
	writeFileSync(join(dir, "cli.ts"), "// entrypoint\n");
	return dir;
}

function fakeDeps(status: unknown, fileExists = true): ServiceDoctorDeps {
	return {
		armadaCliPath: "/armada/cli.js",
		fileExists: () => fileExists,
		getMtimeMs: () => undefined,
		runCommand: () => ({ ok: true, output: JSON.stringify(status) }),
	};
}

describe("checkServiceUnitPaths", () => {
	it("reports version drift even after the old daemon has restarted", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, fakeDeps({ vehicles: [{
			name: "fakedaemon", executable: join(dir, "cli.ts"), version: "0.21.0",
			nativeStatus: "running", ready: true,
		}] }));
		expect(report.ok).toBe(false);
		expect(report.diagnostics).toContainEqual(expect.objectContaining({
			code: "SERVICE_VERSION_MISMATCH", severity: "error",
			message: expect.stringContaining("0.21.0"),
		}));
	});

	it("accepts an isolated service at the resolved version", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, fakeDeps({ vehicles: [{
			name: "fakedaemon", executable: "/managed/isolated/cli.ts", version: "1.0.0",
			nativeStatus: "running", ready: true,
		}] }));
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 1 });
	});

	it("reports missing registration rather than claiming a healthy deployment", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, fakeDeps({ vehicles: [] }));
		expect(report.ok).toBe(false);
		expect(report.diagnostics[0]?.code).toBe("SERVICE_NOT_REGISTERED");
	});

	it("reports native descriptor drift independently of version equality", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, fakeDeps({ vehicles: [{
			name: "fakedaemon", executable: "/managed/cli.ts", version: "1.0.0", descriptorDrift: true,
		}] }));
		expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "SERVICE_DESCRIPTOR_DRIFT" }));
	});

	it("skips packages with no Armada-managed Vehicle", () => {
		const home = piHome(["npm:not-a-daemon"]);
		const dir = join(home, "npm", "node_modules", "not-a-daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "not-a-daemon", version: "1.0.0" }));
		expect(checkServiceUnitPaths(home, undefined, fakeDeps({ vehicles: [], diagnostics: [] }))).toEqual({
			ok: true,
			diagnostics: [],
			checked: 0,
		});
	});

	it("reports a clean Armada-managed executable", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(
			home,
			undefined,
			fakeDeps({ vehicles: [{ name: "fakedaemon", executable: join(dir, "cli.ts") }], diagnostics: [] }),
		);
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 1 });
	});

	it("reports a stopped Vehicle from Armada's real status projection", async () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const harness = await createArmadaTestHarness();
		try {
			const registered = await harness.registrar.register({
				name: "fakedaemon",
				version: "1.0.0",
				executable: join(dir, "cli.ts"),
				arguments: ["serve"],
				handlePath: join(harness.root, "fakedaemon", "handle.json"),
				restart: { policy: "on-failure", delayMs: 100, maxAttempts: 2, windowMs: 1_000 },
				readiness: { timeoutMs: 100, pollIntervalMs: 50 },
			});
			expect(registered.ok).toBe(true);
			harness.application("fakedaemon").exitCleanly();

			const report = checkServiceUnitPaths(home, undefined, fakeDeps(await harness.status()));
			expect(report).toEqual({
				ok: false,
				checked: 1,
				diagnostics: [
					{
						code: "SERVICE_NOT_RUNNING",
						severity: "error",
						package: "fakedaemon",
						unitName: "fakedaemon",
						message: expect.stringContaining("stopped"),
					},
				],
			});
		} finally {
			await harness.dispose();
		}
	});

	it("reports a missing Armada-managed executable", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const executable = join(dir, "cli.ts");
		const report = checkServiceUnitPaths(
			home,
			undefined,
			fakeDeps({ vehicles: [{ name: "fakedaemon", executable }], diagnostics: [] }, false),
		);
		expect(report).toEqual({
			ok: false,
			checked: 1,
			diagnostics: [
				{
					code: "SERVICE_EXEC_PATH_MISSING",
					severity: "error",
					package: "fakedaemon",
					unitName: "fakedaemon",
					message: expect.stringContaining(executable),
				},
			],
		});
	});

	it("reports a running Vehicle whose process predates its own package.json well past Armada's own reconcile cadence as stale code, not an error", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		// Past two full reconcile cycles -- a genuinely broken operator, not a gap a healthy
		// vehicle-reconcile pass would already have self-healed.
		const gapMs = RECONCILE_INTERVAL_DEFAULT_MS * 2 + 60_000;
		const deps: ServiceDoctorDeps = {
			armadaCliPath: "/armada/cli.js",
			fileExists: () => true,
			getMtimeMs: () => Date.now(),
			runCommand: (command) =>
				command === "ps"
					? { ok: true, output: new Date(Date.now() - gapMs).toString() }
					: {
							ok: true,
							output: JSON.stringify({
								vehicles: [{ name: "fakedaemon", executable: join(dir, "cli.ts"), nativeStatus: "running", nativePid: 4242 }],
							}),
						},
		};
		const report = checkServiceUnitPaths(home, undefined, deps);
		expect(report).toEqual({
			ok: false,
			checked: 1,
			diagnostics: [
				{
					code: "SERVICE_STALE_CODE",
					severity: "warning",
					package: "fakedaemon",
					unitName: "fakedaemon",
					message: expect.stringContaining("pid 4242"),
				},
			],
		});
	});

	it("no longer flags a gap within Armada's own reconcile cadence -- a healthy self-healing operator closes that within one resync, not Doctor", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const deps: ServiceDoctorDeps = {
			armadaCliPath: "/armada/cli.js",
			fileExists: () => true,
			getMtimeMs: () => Date.now(),
			runCommand: (command) =>
				command === "ps"
					? { ok: true, output: new Date(Date.now() - 60_000).toString() }
					: {
							ok: true,
							output: JSON.stringify({
								vehicles: [{ name: "fakedaemon", executable: join(dir, "cli.ts"), nativeStatus: "running", nativePid: 4242 }],
							}),
						},
		};
		expect(checkServiceUnitPaths(home, undefined, deps)).toEqual({ ok: true, diagnostics: [], checked: 1 });
	});

	it("never flags a running Vehicle whose process started after its own package.json was last written", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const deps: ServiceDoctorDeps = {
			armadaCliPath: "/armada/cli.js",
			fileExists: () => true,
			getMtimeMs: () => Date.now() - 60_000,
			runCommand: (command) =>
				command === "ps"
					? { ok: true, output: new Date().toString() }
					: {
							ok: true,
							output: JSON.stringify({
								vehicles: [{ name: "fakedaemon", executable: join(dir, "cli.ts"), nativeStatus: "running", nativePid: 4242 }],
							}),
						},
		};
		expect(checkServiceUnitPaths(home, undefined, deps)).toEqual({ ok: true, diagnostics: [], checked: 1 });
	});

	it("reports Armada status failure without guessing from native descriptors", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const deps = fakeDeps({});
		deps.runCommand = () => ({ ok: false, output: "armada unavailable" });
		const report = checkServiceUnitPaths(home, undefined, deps);
		expect(report.ok).toBe(false);
		expect(report.diagnostics[0]?.code).toBe("SERVICE_STATUS_UNAVAILABLE");
	});
});
