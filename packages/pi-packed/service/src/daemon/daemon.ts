import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MaintenanceTask,
	type RunningDaemon,
	runDaemonProcess,
	type StartDaemonOptions,
	startDaemon,
} from "@danypops/vehicle-server/daemon";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { openVehicleMetricsStore } from "@danypops/vehicle-server/metrics";
import { captureLoadedModules, checkModuleFreshnessAll, ownRuntimeDependencyNames } from "../adoption/module-freshness.ts";
import {
	type DaemonServiceInstaller,
	listManagedPackages,
	PACKED_VEHICLE_NAME,
	RealDaemonServiceInstaller,
	reconcileAllDaemonServices,
} from "./daemon-service.ts";
import { generateIndex, indexPath, indexStatus } from "../index/build-index.ts";
import { catalogStatus, syncCatalog } from "../packages/catalog.ts";
import { latestVersion, openDb } from "../packages/db.ts";
import { ExecInstaller } from "../packages/install.ts";
import { defaultPiHome } from "../packages/installed.ts";
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

/**
 * Captured exactly once, here at daemon startup (daemonOptions() itself
 * runs once per process -- see vehicle-server/daemon.js's own single
 * `buildApp()` call site) -- see module-freshness.ts's own header comment
 * for why this specific moment is what makes the later comparison
 * meaningful: this is the instant this process's own static imports last
 * actually loaded these files into memory.
 */
function captureOwnModuleSnapshot() {
	const serviceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	const packageDirectory = dirname(serviceRoot);
	const ownPackageJsonPath = join(packageDirectory, "package.json");
	return captureLoadedModules(packageDirectory, ownRuntimeDependencyNames(ownPackageJsonPath));
}

export function daemonOptions(options: StartPackedDaemonOptions): StartDaemonOptions {
	const paths = options.paths ?? resolvePackedPaths();
	if (options.migrateLegacy ?? options.paths === undefined) migrateLegacyPackedState(paths, legacyPackedStateDirectory());
	const token = ensureAuthToken(paths.token, "Packed");
	const reg = options.reg ?? new HttpRegistry();
	const piHome = options.piHome ?? defaultPiHome();
	const database = openDb(paths.database);
	const vehicleMetrics = openVehicleMetricsStore(paths.metrics);
	const moduleSnapshot = captureOwnModuleSnapshot();
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
				// listManagedPackages(), not readInstalledPackages() -- also catches a physically
				// installed daemon-dependency that isn't itself pi:-configured (e.g. papyrus via
				// pi-papyrus). readInstalledPackages() alone silently missed every such stale package.
				const updates = checkUpdates((name) => latestVersion(database, name), listManagedPackages(piHome));
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
				// A package updated through a route pi-packed never sees at all (e.g. the generic,
				// daemon-unaware `pi update --extension` / pkg_update path -- see
				// pkg-update-never-restarts-vehicle-daemon) leaves this as the ONLY thing that ever
				// notices and restarts the stale daemon. Logging only on failure made every silent
				// success indistinguishable from "this never ran" -- there was no way to confirm a
				// restart this task performed actually happened, short of checking the process's own
				// PID by hand.
				const changed = result.reconciled.filter((entry) => entry.installed && entry.versionChanged);
				if (changed.length > 0 || result.pruned.length > 0) {
					logger.info("vehicle-reconcile applied changes", {
						reconciled: changed.map((entry) => entry.vehicleName),
						pruned: result.pruned.map((entry) => entry.vehicleName),
					});
				}
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
		// Vehicle Shell broker mode (enable-vehicle-shell-broker-mode-in-pi-packed): registers this
		// daemon's own identity in the shared, cross-daemon Vehicle Handle Directory, alongside its
		// existing private handlePath above -- unaffected either way. Must match
		// extension/src/vehicle-tools.ts's own registerVehicleTools({ shell: { broker: { ownVehicleName }
		// } }) literal (extension/ and service/ deliberately never cross-import in this package, so both
		// sides carry the same comment-anchored literal instead of a shared TS import -- see that
		// file's own comment).
		vehicleName: PACKED_VEHICLE_NAME,
		tokenPath: paths.token,
		logger,
		maintenanceTasks,
		...(idleBudgetMs === undefined ? {} : { idleBudgetMs }),
		idleTickMs: WATCHDOG_TICK_MS,
		buildApp: () =>
			createApp({
				reg,
				inst,
				token,
				stateDir: paths.stateDirectory,
				dataDir: dirname(paths.database),
				piHome,
				daemonServiceInstaller,
				moduleFreshness: () => checkModuleFreshnessAll(moduleSnapshot),
				vehicleMetrics,
			}),
		onShutdown: () => {
			database.close();
			vehicleMetrics.close();
		},
	};
}

// startDaemon() itself now runs every maintenance task once immediately at startup (in
// addition to its own interval) -- see @danypops/vehicle-server's own daemon.ts. This used to
// be a bespoke wrapper here (runInitialMaintenance(), called after startDaemon() returned, or
// from serveMain()'s onListen) working around a bare setInterval() never firing until its full
// interval first elapsed; kept here would now double-run every task on every startup. Every
// OTHER vehicle-server-based daemon (lector, jittor, papyrus, pipes, tickets,
// web-spider-daemon) never had this workaround at all and now gets the same fix for free from
// the shared implementation, instead of needing to independently reinvent it.
export async function startPackedDaemon(options: StartPackedDaemonOptions = {}): Promise<RunningDaemon> {
	return startDaemon(daemonOptions(options));
}

export function serveMain(): void {
	runDaemonProcess({
		...daemonOptions({}),
		onListen: ({ host, port }) => {
			logger.info("listening", { host, port });
		},
	});
}
