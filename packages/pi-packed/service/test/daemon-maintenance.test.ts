import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceInstallResult, ServiceSpec } from "@danypops/vehicle-server/service";
import { daemonOptions, startPackedDaemon } from "../src/daemon/daemon.ts";
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

		// daemonOptions() also fires every default task once at startup (see the dedicated
		// startup-self-heal test below) -- let that finish, then isolate this test's own
		// explicit invocation from it rather than racing the two.
		await new Promise((resolveTick) => setTimeout(resolveTick, 20));
		installerSpy.gotSources = [];
		await task?.run();

		expect(installerSpy.gotSources).toEqual(["npm:@danypops/probe", "npm:@danypops/other"]);
	});

	it("does not reconcile Armada before the daemon has published its readiness handle", async () => {
		const piHome = fakePiHome(["npm:@danypops/pi-packed", "npm:@danypops/probe"]);
		const paths = fakePaths();
		const installerSpy = new RecordingDaemonServiceInstaller();
		mkdirSync(join(piHome, "npm", "node_modules"), { recursive: true });
		daemonOptions({ paths, reg: registry, inst: installer, piHome, daemonServiceInstaller: installerSpy });

		// Give pre-listen maintenance enough time to expose an accidental Armada call.
		await new Promise((resolveTick) => setTimeout(resolveTick, 10));

		expect(installerSpy.gotSources).toEqual([]);
	});

	it("reconciles Armada only after the real daemon handle is ready", async () => {
		const piHome = fakePiHome(["npm:@danypops/pi-packed", "npm:@danypops/probe"]);
		const paths = fakePaths();
		const installerSpy = new RecordingDaemonServiceInstaller();
		const running = await startPackedDaemon({ paths, reg: registry, inst: installer, piHome, daemonServiceInstaller: installerSpy });
		try {
			await new Promise((resolveTick) => setTimeout(resolveTick, 10));
			expect(existsSync(paths.handle)).toBe(true);
			expect(installerSpy.gotSources).toEqual(["npm:@danypops/probe"]);
		} finally {
			await running.stop();
		}
	});
});
