import { dirname } from "node:path";
import {
	type MaintenanceTask,
	type RunningDaemon,
	runDaemonProcess,
	type StartDaemonOptions,
	startDaemon,
} from "@danypops/vehicle-server/daemon";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { type DaemonServiceInstaller, RealDaemonServiceInstaller, reconcileAllDaemonServices } from "./daemon-service.ts";
import { generateIndex, indexPath, indexStatus } from "../index/build-index.ts";
import { catalogStatus, syncCatalog } from "../packages/catalog.ts";
import { latestVersion, openDb } from "../packages/db.ts";
import { ExecInstaller } from "../packages/install.ts";
import { defaultPiHome, readInstalledPackages } from "../packages/installed.ts";
import type { Installer, Registry } from "../packages/package.ts";
import { HttpRegistry } from "../registry/registry.ts";
import {
	CATALOG_INTERVAL_DEFAULT_MS,
	ENV,
	INDEX_INTERVAL_DEFAULT_MS,
	RECONCILE_INTERVAL_DEFAULT_MS,
	WATCH_INTERVAL_DEFAULT_MS,
	WATCHDOG_TICK_MS,
} from "../shared/constants.ts";
import { createLogger } from "../shared/log.ts";
import { legacyPackedStateDirectory, migrateLegacyPackedState, type PackedPaths, resolvePackedPaths } from "../shared/paths.ts";
import { envMs } from "../shared/state.ts";
import { createApp } from "./service.ts";
import { checkUpdates, saveUpdates } from "./watcher.ts";

const logger = createLogger("daemon");

export interface StartPackedDaemonOptions {
	paths?: PackedPaths;
	reg?: Registry;
	inst?: Installer;
	piHome?: string;
	daemonServiceInstaller?: DaemonServiceInstaller;
	maintenanceTasks?: MaintenanceTask[];
	idleBudgetMs?: number;
	migrateLegacy?: boolean;
	env?: Readonly<Record<string, string | undefined>>;
}

function configuredIdleBudgetMs(options: StartPackedDaemonOptions): number | undefined {
	if (options.idleBudgetMs !== undefined) return options.idleBudgetMs;
	const raw = (options.env ?? process.env)[ENV.IDLE_SECS];
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export function daemonOptions(options: StartPackedDaemonOptions): StartDaemonOptions {
	const paths = options.paths ?? resolvePackedPaths();
	if (options.migrateLegacy ?? options.paths === undefined) migrateLegacyPackedState(paths, legacyPackedStateDirectory());
	const token = ensureAuthToken(paths.token, "Packed");
	const reg = options.reg ?? new HttpRegistry();
	const piHome = options.piHome ?? defaultPiHome();
	const database = openDb(paths.database);
	// Wires ExecInstaller.update()'s own out-of-range cross-check to the exact
	// same registry-mirror source of truth the package-update-check task below
	// already uses via checkUpdates() -- one mirror, two consumers, never two
	// notions of "the real latest version".
	const inst = options.inst ?? new ExecInstaller(undefined, piHome, undefined, undefined, undefined, (name) => latestVersion(database, name));
	const daemonServiceInstaller = options.daemonServiceInstaller ?? new RealDaemonServiceInstaller();
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
		{
			name: "index-build",
			intervalMs: envMs(ENV.INDEX_SECS, INDEX_INTERVAL_DEFAULT_MS),
			run: async () => {
				const ttlMs = envMs(ENV.INDEX_SECS, INDEX_INTERVAL_DEFAULT_MS);
				const dataDirectory = dirname(paths.database);
				if (indexStatus(indexPath(dataDirectory), ttlMs).stale) await generateIndex(reg, dataDirectory, indexPath(dataDirectory));
			},
		},
		{
			// Self-heals a Vehicle a running daemon never picked up -- an out-of-band
			// npm install/update, or a transitive dependency bump that resolveDaemonServiceSpec
			// would only otherwise re-check the next time /install or /restart-service ran
			// for that exact package.
			name: "vehicle-reconcile",
			intervalMs: envMs(ENV.RECONCILE_SECS, RECONCILE_INTERVAL_DEFAULT_MS),
			run: async () => {
				const result = await reconcileAllDaemonServices(piHome, undefined, daemonServiceInstaller);
				if (result.failed.length > 0) {
					logger.warn("vehicle-reconcile completed with failures", {
						reconciled: result.reconciled.length,
						skipped: result.skipped,
						failed: result.failed.length,
					});
				}
			},
		},
	];
	const maintenanceTasks = configuredMaintenanceTasks.filter((task) => task.intervalMs > 0);
	const idleBudgetMs = configuredIdleBudgetMs(options);

	return {
		daemonLabel: "Packed",
		handlePath: paths.handle,
		logger,
		maintenanceTasks,
		...(idleBudgetMs === undefined ? {} : { idleBudgetMs }),
		idleTickMs: WATCHDOG_TICK_MS,
		buildApp: () => createApp({ reg, inst, token, stateDir: paths.stateDirectory, dataDir: dirname(paths.database), piHome, daemonServiceInstaller }),
		onShutdown: () => database.close(),
	};
}

function runInitialMaintenance(maintenanceTasks: MaintenanceTask[] | undefined): void {
	for (const task of maintenanceTasks ?? []) {
		void Promise.resolve(task.run()).catch((error) =>
			logger.error(`maintenance task failed: ${task.name}`, { error: error instanceof Error ? error.message : String(error) }),
		);
	}
}

export async function startPackedDaemon(options: StartPackedDaemonOptions = {}): Promise<RunningDaemon> {
	const configured = daemonOptions(options);
	const running = await startDaemon(configured);
	runInitialMaintenance(configured.maintenanceTasks);
	return running;
}

export function serveMain(): void {
	const configured = daemonOptions({});
	runDaemonProcess({
		...configured,
		onListen: ({ host, port }) => {
			logger.info("listening", { host, port });
			runInitialMaintenance(configured.maintenanceTasks);
		},
	});
}
