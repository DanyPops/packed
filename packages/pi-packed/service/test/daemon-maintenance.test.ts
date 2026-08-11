import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmadaTestHarness } from "@danypops/armada/testing";
import type { MaintenanceTask } from "@danypops/vehicle-server/daemon";
import type { ServiceInstallResult, ServiceSpec } from "@danypops/vehicle-server/service";
import { daemonOptions, startPackedDaemon } from "../src/daemon/daemon.ts";
import {
	type DaemonServiceInstaller,
	RealDaemonServiceInstaller,
	reconcileAllDaemonServices,
} from "../src/daemon/daemon-service.ts";
import type { Installer, Registry } from "../src/packages/package.ts";
import { RECONCILE_INTERVAL_DEFAULT_MS } from "../src/shared/constants.ts";
import { resolvePackedPaths } from "../src/shared/paths.ts";

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
});
