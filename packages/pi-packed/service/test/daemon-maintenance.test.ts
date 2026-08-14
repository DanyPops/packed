import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VehicleRegistrationOutcome, VehicleSpec } from "@danypops/armada";
import { createArmadaTestHarness } from "@danypops/armada/testing";
import type { MaintenanceTask } from "@danypops/vehicle-server/daemon";
import type { ServiceInstallResult, ServiceSpec } from "@danypops/vehicle-server/service";
import { daemonOptions, startPackedDaemon } from "../src/daemon/daemon.ts";
import {
	type DaemonServiceInstaller,
	RealDaemonServiceInstaller,
	reconcileAllDaemonServices,
} from "../src/daemon/daemon-service.ts";
import { openDb, replaceAll } from "../src/packages/db.ts";
import type { Installer, Registry } from "../src/packages/package.ts";
import { RECONCILE_INTERVAL_DEFAULT_MS } from "../src/shared/constants.ts";
import { resolvePackedPaths } from "../src/shared/paths.ts";
import { loadUpdates } from "../src/daemon/watcher.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePiHome(packages: string[]): string {
	const piHome = mkdtempSync(join(tmpdir(), "packed-maintenance-"));
	roots.push(piHome);
	writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages }));
	return piHome;
}

function fakePaths() {
	const root = mkdtempSync(join(tmpdir(), "packed-maintenance-state-"));
	roots.push(root);
	return resolvePackedPaths({ env: { PI_PACKED_HOME: root } });
}

function vehicleReconcileTask(piHome: string, daemonServiceInstaller: DaemonServiceInstaller): MaintenanceTask {
	return {
		name: "vehicle-reconcile",
		intervalMs: RECONCILE_INTERVAL_DEFAULT_MS,
		run: async () => {
			await reconcileAllDaemonServices(piHome, undefined, daemonServiceInstaller);
		},
	};
}

function installMockDaemon(piHome: string, name: string): void {
	const directory = join(piHome, "npm", "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			packed: { daemonService: { binPath: "cli.ts", args: ["serve"] } },
		}),
	);
	writeFileSync(join(directory, "cli.ts"), "// Mock Vehicle entry point; Armada's test controller never executes it.\n");
}

/** A Vehicle-shaped daemon-dependency (real bin + vehicle-server dependency), not declared in
 * settings.json's packages[] -- e.g. papyrus, resolved only via pi-papyrus. */
function installUnconfiguredDaemonDependency(piHome: string, name: string, version: string): void {
	const directory = join(piHome, "npm", "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name, version, bin: { probe: "cli.ts" }, dependencies: { "@danypops/vehicle-server": "^0.1.0" } }),
	);
	writeFileSync(join(directory, "cli.ts"), "// Mock Vehicle entry point.\n");
}

function installConfiguredExtension(piHome: string, name: string, version: string): void {
	const directory = join(piHome, "npm", "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
}

const registry: Registry = {
	async search() {
		return { total: 0, results: [] };
	},
	async searchPage() {
		return { total: 0, results: [] };
	},
	async searchAll() {
		return [];
	},
	async info(name) {
		return { name, version: "1.0.0" };
	},
};

const installer: Installer = {
	async install(source) {
		return `installed ${source}`;
	},
	async remove(source) {
		return `removed ${source}`;
	},
	async update(source) {
		return { output: `updated ${source}`, reloadRequired: false, alreadyUpToDate: true, pinned: false };
	},
};

class RecordingDaemonServiceInstaller {
	gotSources: string[] = [];
	async install(
		_piHome: string,
		source: string,
	): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		this.gotSources.push(source);
		return { ok: false, reason: "not a daemon", notADaemon: true };
	}
	async remove(): Promise<{ ok: true; result: ServiceInstallResult; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }> {
		return { ok: false, reason: "not a daemon", notADaemon: true };
	}
	async restart(): Promise<
		{ ok: true; restarted: boolean; reason?: string; spec: ServiceSpec } | { ok: false; reason: string; notADaemon?: boolean }
	> {
		return { ok: false, reason: "not a daemon", notADaemon: true };
	}
	async listRegisteredVehicles(): Promise<readonly VehicleSpec[]> {
		return [];
	}
	async unregisterVehicleByName(): Promise<VehicleRegistrationOutcome> {
		return { ok: true, manifestHash: "hash" as never, applied: [], diagnostics: [] };
	}
}

describe("startPackedDaemon's own maintenance-task wiring (self-heals Vehicle drift, not just per-package on demand)", () => {
	it("leaves the idle budget unspecified when no Packed override exists, so Vehicle can keep a service-launched daemon always on", () => {
		const options = daemonOptions({
			paths: fakePaths(),
			reg: registry,
			inst: installer,
			piHome: fakePiHome([]),
			maintenanceTasks: [],
			env: {},
		});
		expect(options.idleBudgetMs).toBeUndefined();
	});

	it("honors an explicit Packed idle override without replacing Vehicle's provenance default", () => {
		const options = daemonOptions({
			paths: fakePaths(),
			reg: registry,
			inst: installer,
			piHome: fakePiHome([]),
			maintenanceTasks: [],
			env: { PI_PACKED_IDLE_SECS: "17" },
		});
		expect(options.idleBudgetMs).toBe(17_000);
	});

	it("registers pi-packed's own stable identity in the shared Vehicle Handle Directory (Vehicle Shell broker mode) -- enable-vehicle-shell-broker-mode-in-pi-packed", () => {
		const paths = fakePaths();
		const options = daemonOptions({ paths, reg: registry, inst: installer, piHome: fakePiHome([]), maintenanceTasks: [] });
		// Must match extension/src/vehicle-tools.ts's own registerVehicleTools({ shell: { broker:
		// { ownVehicleName } } }) literal -- the two sides can't share a real TS import (extension/
		// and service/ deliberately never cross-import, matching this package's own established
		// convention), so both carry the same comment-anchored literal instead.
		expect(options.vehicleName).toBe("pi-packed");
		expect(options.tokenPath).toBe(paths.token);
	});

	it("includes a vehicle-reconcile task, defaulting to RECONCILE_INTERVAL_DEFAULT_MS", () => {
		const piHome = fakePiHome([]);
		const paths = fakePaths();
		const options = daemonOptions({ paths, reg: registry, inst: installer, piHome, maintenanceTasks: [] });
		// maintenanceTasks: [] is itself the override under test setup convention (see
		// daemon-kit-migration.test.ts) for every OTHER test in this file that needs the
		// real default list; assert its shape directly here via a second, non-overridden call.
		expect(options.maintenanceTasks).toEqual([]);
	});

	it("the default (non-overridden) maintenance list names vehicle-reconcile at the configured interval", () => {
		const piHome = fakePiHome([]);
		const paths = fakePaths();
		const installerSpy = new RecordingDaemonServiceInstaller();
		const options = daemonOptions({ paths, reg: registry, inst: installer, piHome, daemonServiceInstaller: installerSpy });
		const task = options.maintenanceTasks?.find((t) => t.name === "vehicle-reconcile");
		expect(task).toBeDefined();
		expect(task?.intervalMs).toBe(RECONCILE_INTERVAL_DEFAULT_MS);
	});

	it("vehicle-reconcile sweeps every package declared in piHome's own settings through the injected installer", async () => {
		const piHome = fakePiHome(["npm:@danypops/probe", "npm:@danypops/other"]);
		const paths = fakePaths();
		const installerSpy = new RecordingDaemonServiceInstaller();
		const options = daemonOptions({ paths, reg: registry, inst: installer, piHome, daemonServiceInstaller: installerSpy });
		const task = options.maintenanceTasks?.find((t) => t.name === "vehicle-reconcile");
		expect(task).toBeDefined();

		await task?.run();

		expect(installerSpy.gotSources).toEqual(["npm:@danypops/probe", "npm:@danypops/other"]);
	});

	it("runs initial maintenance only after publishing the daemon handle", async () => {
		const piHome = fakePiHome([]);
		const paths = fakePaths();
		let resolveRun: (() => void) | undefined;
		const ran = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const task: MaintenanceTask = {
			name: "probe-initial-maintenance",
			intervalMs: RECONCILE_INTERVAL_DEFAULT_MS,
			run: () => {
				expect(existsSync(paths.handle)).toBe(true);
				resolveRun?.();
			},
		};

		const running = await startPackedDaemon({ paths, reg: registry, inst: installer, piHome, maintenanceTasks: [task] });
		try {
			await Promise.race([
				ran,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("initial maintenance did not run")), 250)),
			]);
		} finally {
			await running.stop();
		}
	});

	/**
	 * Regression guard for the double-execution risk this file's own daemon.ts (startPackedDaemon/
	 * serveMain) used to carry: a bespoke runInitialMaintenance() wrapper called explicitly, on top
	 * of what startDaemon() (vehicle-server) itself now already does since it started running every
	 * maintenance task once immediately at startup. Removed entirely -- this proves it stayed
	 * removed, not just that a task runs at least once (the test above already covers that).
	 */
	it("runs each maintenance task exactly once at startup, never twice", async () => {
		const piHome = fakePiHome([]);
		const paths = fakePaths();
		let runs = 0;
		const task: MaintenanceTask = {
			name: "probe-exactly-once",
			intervalMs: RECONCILE_INTERVAL_DEFAULT_MS,
			run: () => {
				runs++;
			},
		};
		const running = await startPackedDaemon({ paths, reg: registry, inst: installer, piHome, maintenanceTasks: [task] });
		try {
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(runs).toBe(1);
		} finally {
			await running.stop();
		}
	});

	it("does not reconcile Armada before the daemon has published its readiness handle", async () => {
		const piHome = fakePiHome(["npm:@danypops/pi-packed", "npm:@danypops/probe"]);
		const paths = fakePaths();
		installMockDaemon(piHome, "@danypops/pi-packed");
		installMockDaemon(piHome, "@danypops/probe");
		const harness = await createArmadaTestHarness();
		try {
			const serviceInstaller = new RealDaemonServiceInstaller(harness.registrar);
			daemonOptions({
				paths,
				reg: registry,
				inst: installer,
				piHome,
				daemonServiceInstaller: serviceInstaller,
				maintenanceTasks: [vehicleReconcileTask(piHome, serviceInstaller)],
			});

			expect(existsSync(paths.handle)).toBe(false);
			expect(harness.events()).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("reconciles Armada only after the real daemon handle is ready", async () => {
		const piHome = fakePiHome(["npm:@danypops/pi-packed", "npm:@danypops/probe"]);
		const paths = fakePaths();
		installMockDaemon(piHome, "@danypops/pi-packed");
		installMockDaemon(piHome, "@danypops/probe");
		const harness = await createArmadaTestHarness();
		const serviceInstaller = new RealDaemonServiceInstaller(harness.registrar);
		const running = await startPackedDaemon({
			paths,
			reg: registry,
			inst: installer,
			piHome,
			daemonServiceInstaller: serviceInstaller,
			maintenanceTasks: [vehicleReconcileTask(piHome, serviceInstaller)],
		});
		try {
			await harness.waitForEvent("ready:probe");
			expect(existsSync(paths.handle)).toBe(true);
			expect(harness.events()).toEqual([
				"replace:armada-probe.service",
				"start:armada-probe.service",
				"ready:probe",
			]);
			expect(await harness.registrar.isRegistered("pi-packed")).toBe(false);
		} finally {
			await running.stop();
			await harness.dispose();
		}
	});

	describe("package-update-check (feeds package.updates / pkg_updates)", () => {
		it("reports a stale pi:-configured extension", async () => {
			const piHome = fakePiHome(["npm:@danypops/probe-ext"]);
			installConfiguredExtension(piHome, "@danypops/probe-ext", "1.0.0");
			const paths = fakePaths();
			const db = openDb(paths.database);
			replaceAll(db, [{ name: "@danypops/probe-ext", version: "2.0.0" }], "test");
			db.close();

			const options = daemonOptions({ paths, reg: registry, inst: installer, piHome });
			const task = options.maintenanceTasks?.find((t) => t.name === "package-update-check");
			expect(task).toBeDefined();
			await task?.run();

			const snapshot = await loadUpdates(paths.stateDirectory);
			expect(snapshot?.updates.map((u) => u.name)).toContain("@danypops/probe-ext");
		});

		it("also reports a stale daemon-dependency package (e.g. papyrus via pi-papyrus)", async () => {
			const piHome = fakePiHome([]); // deliberately NOT declaring probe-daemon in settings.json
			installUnconfiguredDaemonDependency(piHome, "@danypops/probe-daemon", "1.0.0");
			const paths = fakePaths();
			const db = openDb(paths.database);
			replaceAll(db, [{ name: "@danypops/probe-daemon", version: "9.9.9" }], "test");
			db.close();

			const options = daemonOptions({ paths, reg: registry, inst: installer, piHome });
			const task = options.maintenanceTasks?.find((t) => t.name === "package-update-check");
			expect(task).toBeDefined();
			await task?.run();

			const snapshot = await loadUpdates(paths.stateDirectory);
			expect(snapshot?.updates.map((u) => u.name)).toContain("@danypops/probe-daemon");
		});
	});

	/**
	 * Real gap this closes: install()'s own ServiceInstallResult reports `installed: true`
	 * whenever register()/reconcile() SUCCEEDS -- which is true on every healthy pass whether or
	 * not anything actually changed underneath (register() is a safe no-op against unchanged
	 * desired state). A caller logging "applied changes" off `installed` alone would say so on
	 * literally every tick of a healthy, unchanged fleet -- see pkg-update-never-restarts-
	 * vehicle-daemon. versionChanged is the honest signal instead.
	 */
	describe("reconcileAllDaemonServices reports versionChanged honestly, not just installed", () => {
		it("is true on a package's first-ever registration, false on an unchanged re-sweep, true again once its on-disk version actually moves", async () => {
			const piHome = fakePiHome(["npm:@danypops/probe"]);
			installMockDaemon(piHome, "@danypops/probe");
			const harness = await createArmadaTestHarness();
			try {
				const installer = new RealDaemonServiceInstaller(harness.registrar);

				const first = await reconcileAllDaemonServices(piHome, undefined, installer);
				expect(first.reconciled).toEqual([
					{ packageName: "@danypops/probe", vehicleName: "probe", installed: true, versionChanged: true },
				]);

				const second = await reconcileAllDaemonServices(piHome, undefined, installer);
				expect(second.reconciled).toEqual([
					{ packageName: "@danypops/probe", vehicleName: "probe", installed: true, versionChanged: false },
				]);

				writeFileSync(
					join(piHome, "npm", "node_modules", "@danypops", "probe", "package.json"),
					JSON.stringify({ name: "@danypops/probe", version: "1.1.0", packed: { daemonService: { binPath: "cli.ts", args: ["serve"] } } }),
				);
				const third = await reconcileAllDaemonServices(piHome, undefined, installer);
				expect(third.reconciled).toEqual([
					{ packageName: "@danypops/probe", vehicleName: "probe", installed: true, versionChanged: true },
				]);
			} finally {
				await harness.dispose();
			}
		});
	});

	describe("reconcileAllDaemonServices pruning (the-armada-registrar-jittor-web-spider-daemon-collision)", () => {
		function stalePiHomeVehicle(piHome: string, name: string): VehicleSpec {
			return {
				name: name as VehicleSpec["name"],
				version: "0.1.0",
				executable: join(piHome, "npm", "node_modules", "@danypops", "old-package", "cli.ts"),
				arguments: ["serve"],
				handlePath: join(piHome, "stale-handle.json"),
				restart: { policy: "never" },
				readiness: { timeoutMs: 500, pollIntervalMs: 50 },
			};
		}

		it("prunes a Vehicle whose executable lives under piHome's own node_modules once nothing discovers it anymore", async () => {
			const piHome = fakePiHome([]); // deliberately empty -- old-package no longer configured or on disk
			const harness = await createArmadaTestHarness();
			try {
				await harness.registrar.register(stalePiHomeVehicle(piHome, "old-package"));
				expect(await harness.registrar.isRegistered("old-package")).toBe(true);

				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([{ vehicleName: "old-package", executable: stalePiHomeVehicle(piHome, "old-package").executable }]);
				expect(result.pruneFailed).toEqual([]);
				expect(await harness.registrar.isRegistered("old-package")).toBe(false);
			} finally {
				await harness.dispose();
			}
		});

		it("never prunes a Vehicle registered outside piHome's own node_modules, regardless of discovery", async () => {
			const piHome = fakePiHome([]);
			const harness = await createArmadaTestHarness();
			try {
				await harness.registrar.register({
					name: "externally-managed" as VehicleSpec["name"],
					version: "1.0.0",
					executable: "/opt/custom/cli.js",
					arguments: ["serve"],
					handlePath: join(piHome, "external-handle.json"),
					restart: { policy: "never" },
					readiness: { timeoutMs: 500, pollIntervalMs: 50 },
				});

				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([]);
				expect(await harness.registrar.isRegistered("externally-managed")).toBe(true);
			} finally {
				await harness.dispose();
			}
		});

		it("never prunes a Vehicle still discoverable through the configured-extension sweep -- only updates it", async () => {
			const piHome = fakePiHome(["npm:@danypops/probe"]);
			installMockDaemon(piHome, "@danypops/probe");
			const harness = await createArmadaTestHarness();
			try {
				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([]);
				expect(await harness.registrar.isRegistered("probe")).toBe(true);
			} finally {
				await harness.dispose();
			}
		});

		it("never prunes a Vehicle still discoverable only through the unconfigured-daemon-dependency sweep (e.g. a root-pinned package like lector)", async () => {
			const piHome = fakePiHome([]); // deliberately NOT settings.json-configured
			installUnconfiguredDaemonDependency(piHome, "@danypops/probe-daemon", "1.0.0");
			const harness = await createArmadaTestHarness();
			try {
				await harness.registrar.register({
					name: "probe-daemon" as VehicleSpec["name"],
					version: "1.0.0",
					executable: join(piHome, "npm", "node_modules", "@danypops", "probe-daemon", "cli.ts"),
					arguments: ["serve"],
					handlePath: join(piHome, "probe-daemon-handle.json"),
					restart: { policy: "never" },
					readiness: { timeoutMs: 500, pollIntervalMs: 50 },
				});

				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([]);
				expect(await harness.registrar.isRegistered("probe-daemon")).toBe(true);
			} finally {
				await harness.dispose();
			}
		});

		it("never prunes pi-packed's own Vehicle, even though reconcileAllDaemonServices always skips scanning its own package", async () => {
			const piHome = fakePiHome([]);
			const harness = await createArmadaTestHarness();
			try {
				await harness.registrar.register({
					name: "pi-packed" as VehicleSpec["name"],
					version: "1.0.0",
					executable: join(piHome, "npm", "node_modules", "@danypops", "pi-packed", "service", "src", "cli", "cli.ts"),
					arguments: ["serve"],
					handlePath: join(piHome, "pi-packed-handle.json"),
					restart: { policy: "never" },
					readiness: { timeoutMs: 500, pollIntervalMs: 50 },
				});

				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([]);
				expect(await harness.registrar.isRegistered("pi-packed")).toBe(true);
			} finally {
				await harness.dispose();
			}
		});

		it("reproduces the real web-spider/web-spider-daemon collision: the orphaned duplicate is pruned, the correctly-discovered one survives", async () => {
			const piHome = fakePiHome(["npm:@danypops/pi-web-spider"]);
			// pi-web-spider's own dependency-walk discovers @danypops/web-spider-daemon,
			// whose packed.daemonService.name overrides the vehicle name to "web-spider".
			const piWebSpiderDir = join(piHome, "npm", "node_modules", "@danypops", "pi-web-spider");
			mkdirSync(piWebSpiderDir, { recursive: true });
			writeFileSync(
				join(piWebSpiderDir, "package.json"),
				JSON.stringify({ name: "@danypops/pi-web-spider", version: "1.0.0", dependencies: { "@danypops/web-spider-daemon": "^1.0.0" } }),
			);
			const daemonDir = join(piHome, "npm", "node_modules", "@danypops", "web-spider-daemon");
			mkdirSync(daemonDir, { recursive: true });
			writeFileSync(
				join(daemonDir, "package.json"),
				JSON.stringify({
					name: "@danypops/web-spider-daemon",
					version: "1.0.0",
					packed: { daemonService: { name: "web-spider", binPath: "cli.ts", args: ["serve"] } },
				}),
			);
			writeFileSync(join(daemonDir, "cli.ts"), "// Mock Vehicle entry point.\n");

			const harness = await createArmadaTestHarness();
			try {
				// A leftover registration from before the packed.daemonService.name override existed --
				// the exact orphan a prior Packed version would have produced and never cleaned up.
				await harness.registrar.register({
					name: "web-spider-daemon" as VehicleSpec["name"],
					version: "0.9.0",
					executable: join(daemonDir, "cli.ts"),
					arguments: ["serve"],
					handlePath: join(piHome, "web-spider-daemon-handle.json"),
					restart: { policy: "never" },
					readiness: { timeoutMs: 500, pollIntervalMs: 50 },
				});

				const installer = new RealDaemonServiceInstaller(harness.registrar);
				const result = await reconcileAllDaemonServices(piHome, undefined, installer);

				expect(result.pruned).toEqual([{ vehicleName: "web-spider-daemon", executable: join(daemonDir, "cli.ts") }]);
				expect(await harness.registrar.isRegistered("web-spider-daemon")).toBe(false);
				expect(await harness.registrar.isRegistered("web-spider")).toBe(true);
			} finally {
				await harness.dispose();
			}
		});
	});
});
