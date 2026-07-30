import { startDaemon, runDaemonProcess, type MaintenanceTask, type RunningDaemon, type StartDaemonOptions } from "@danypops/daemon-kit/daemon";
import { ensureAuthToken } from "@danypops/daemon-kit/paths";
import { createApp } from "./service.ts";
import { HttpRegistry } from "../registry/registry.ts";
import { ExecInstaller } from "../packages/install.ts";
import { envMs } from "../shared/state.ts";
import { catalogStatus, syncCatalog } from "../packages/catalog.ts";
import { openDb, latestVersion } from "../packages/db.ts";
import {
	ENV, WATCH_INTERVAL_DEFAULT_MS, CATALOG_INTERVAL_DEFAULT_MS, IDLE_BUDGET_DEFAULT_MS, WATCHDOG_TICK_MS,
} from "../shared/constants.ts";
import { readInstalledPackages, defaultPiHome } from "../packages/installed.ts";
import { checkUpdates, saveUpdates } from "./watcher.ts";
import { createLogger } from "../shared/log.ts";
import { dirname } from "node:path";
import { legacyPackedStateDirectory, migrateLegacyPackedState, resolvePackedPaths, type PackedPaths } from "../shared/paths.ts";
import type { Installer, Registry } from "../shared/ports.ts";

const logger = createLogger("daemon");

export interface StartPackedDaemonOptions {
	paths?: PackedPaths;
	reg?: Registry;
	inst?: Installer;
	piHome?: string;
	maintenanceTasks?: MaintenanceTask[];
	idleBudgetMs?: number;
	migrateLegacy?: boolean;
}

function daemonOptions(options: StartPackedDaemonOptions): StartDaemonOptions {
	const paths = options.paths ?? resolvePackedPaths();
	if (options.migrateLegacy ?? options.paths === undefined) migrateLegacyPackedState(paths, legacyPackedStateDirectory());
	const token = ensureAuthToken(paths.token, "Packed");
	const reg = options.reg ?? new HttpRegistry();
	const inst = options.inst ?? new ExecInstaller();
	const piHome = options.piHome ?? defaultPiHome();
	const database = openDb(paths.database);
	const configuredMaintenanceTasks = options.maintenanceTasks ?? [
		{
			name: "package-update-check",
			intervalMs: envMs(ENV.WATCH_SECS, WATCH_INTERVAL_DEFAULT_MS),
			run: async () => {
				const updates = checkUpdates((name) => latestVersion(database, name), readInstalledPackages(piHome));
				await saveUpdates(paths.stateDirectory, { checkedAt: new Date().toISOString(), updates });
			},
		},
		{
			name: "catalog-sync",
			intervalMs: envMs(ENV.CATALOG_SECS, CATALOG_INTERVAL_DEFAULT_MS),
			run: async () => {
				const ttlMs = envMs(ENV.CATALOG_SECS, CATALOG_INTERVAL_DEFAULT_MS);
				const dataDirectory = dirname(paths.database);
				if (catalogStatus(dataDirectory, ttlMs).stale) await syncCatalog(reg, dataDirectory);
			},
		},
	];
	const maintenanceTasks = configuredMaintenanceTasks.filter((task) => task.intervalMs > 0);

	if (options.maintenanceTasks === undefined) {
		for (const task of maintenanceTasks) {
			void Promise.resolve(task.run()).catch((error) => logger.error(`maintenance task failed: ${task.name}`, { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	return {
		daemonLabel: "Packed",
		handlePath: paths.handle,
		logger,
		maintenanceTasks,
		idleBudgetMs: options.idleBudgetMs ?? envMs(ENV.IDLE_SECS, IDLE_BUDGET_DEFAULT_MS),
		idleTickMs: WATCHDOG_TICK_MS,
		buildApp: () => createApp({ reg, inst, token, stateDir: paths.stateDirectory, dataDir: dirname(paths.database), piHome }),
		onShutdown: () => database.close(),
	};
}

export function startPackedDaemon(options: StartPackedDaemonOptions = {}): Promise<RunningDaemon> {
	return startDaemon(daemonOptions(options));
}

export function serveMain(): void {
	runDaemonProcess({
		...daemonOptions({}),
		onListen: ({ host, port }) => logger.info("listening", { host, port }),
	});
}
