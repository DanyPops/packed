/** Authenticated clients for Packed's vehicle-server operation registry. */
import { readFileSync } from "node:fs";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { readDaemonHandle } from "@danypops/vehicle-server/paths";
import type { AdvisoryReport } from "../adoption/advisories.ts";
import type { CheckReport } from "../adoption/check.ts";
import type { DoctorReport } from "../adoption/doctor.ts";
import type { PackReport } from "../adoption/pack.ts";
import type { AdoptionReport } from "../adoption/score.ts";
import type { PackageIndex } from "../index/build-index.ts";
import type { PackageResources, ResourceField } from "../packages/resources.ts";
import type { PiVersionReport } from "../pi/pi-version.ts";
import { HttpRegistry } from "../registry/registry.ts";
import type { MutationApproval, SecuritySettings } from "../security/security.ts";
import type { SetupApplyResult, SetupExportReport, SetupPlan, SetupUpdateReport } from "../setup/setup.ts";
import {
	INDEX_OPERATION_TIMEOUT_MS,
	MIRROR_OPERATION_TIMEOUT_MS,
	PROBE_TIMEOUT_MS,
	REGISTRY_FETCH_TIMEOUT_MS,
} from "../shared/constants.ts";
import { type PackedPaths, resolvePackedPaths } from "../shared/paths.ts";
import type { InstalledPkg, Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateEntry, UpdateOutcome } from "../shared/ports.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type FetchTransport = (request: Request) => Promise<Response>;
type RpcClient = AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

export interface PackageDaemonPort {
	search(query: string, limit: number, offline?: boolean): Promise<{ query: string; total: number; results: SearchPage["results"] }>;
	info(name: string): Promise<PkgInfo>;
	installed(): Promise<InstalledPkg[]>;
	catalog(): Promise<{ fetchedAt?: string; sha256?: string; packages: Pkg[] }>;
	mirror(): Promise<number>;
	index(): Promise<PackageIndex | undefined>;
	indexBuild(): Promise<PackageIndex>;
	updates(): Promise<UpdateEntry[]>;
	updatesForProject(projectRoot: string): Promise<UpdateEntry[]>;
	check(path: string, smoke?: boolean): Promise<CheckReport>;
	pack(path: string): Promise<PackReport>;
	score(target: string): Promise<AdoptionReport>;
	setupExport(projectRoot: string, force?: boolean, machineLocal?: boolean): Promise<SetupExportReport>;
	setupUpdate(manifestPath: string): Promise<SetupUpdateReport>;
	setupPlan(manifestPath: string, prune?: boolean): Promise<SetupPlan>;
	setupApply(manifestPath: string, approved?: boolean, prune?: boolean): Promise<SetupApplyResult>;
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: MutationApproval, approved?: boolean): Promise<SecuritySettings>;
	install(source: string, approved?: boolean): Promise<string>;
	installService(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; spec?: { name: string; binPath: string; descriptorPath: string } }>;
	restartService(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; restarted?: boolean; spec?: { name: string; binPath: string; descriptorPath: string } }>;
	remove(name: string, approved?: boolean): Promise<string>;
	update(source: string, approved?: boolean): Promise<UpdateOutcome>;
	piStatus(): Promise<PiVersionReport>;
	resourcesList(projectRoot?: string): Promise<{ global: PackageResources[]; project: PackageResources[] }>;
	resourcesToggle(
		source: string,
		field: ResourceField,
		path: string,
		enabled: boolean,
		projectRoot?: string,
		approved?: boolean,
	): Promise<string>;
	advisoriesScan(name?: string): Promise<AdvisoryReport>;
	doctor(projectRoot?: string): Promise<DoctorReport>;
}

export class PackageDaemonError extends Error {
	/** True only for install_service's "this package isn't Vehicle-shaped at all" outcome -- distinct from a real failure (systemctl unavailable, spec resolved but the install itself failed). Lets a caller composing install + install-service (see cli.ts's `install` command) stay silent instead of surfacing a false alarm on every ordinary, non-daemon package install. */
	constructor(
		message: string,
		readonly operation: string,
		readonly status?: number,
		readonly notADaemon?: boolean,
	) {
		super(message);
		this.name = "PackageDaemonError";
	}
}

function timeoutTransport(transport: FetchTransport, timeoutMs = REGISTRY_FETCH_TIMEOUT_MS): FetchTransport {
	return (request) =>
		transport(
			new Request(request, {
				signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
			}),
		);
}

export class PackageDaemonClient implements PackageDaemonPort {
	private readonly rpc: RpcClient;
	private readonly maintenanceRpc: RpcClient;
	private readonly indexRpc: RpcClient;

	constructor(base: string, token: string, transport: FetchTransport = fetch) {
		this.rpc = new AuthenticatedRpcClient(base, token, { label: "Packed", transport: timeoutTransport(transport) });
		this.maintenanceRpc = new AuthenticatedRpcClient(base, token, {
			label: "Packed",
			transport: timeoutTransport(transport, MIRROR_OPERATION_TIMEOUT_MS),
		});
		this.indexRpc = new AuthenticatedRpcClient(base, token, {
			label: "Packed",
			transport: timeoutTransport(transport, INDEX_OPERATION_TIMEOUT_MS),
		});
	}

	private async call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
		try {
			return await this.rpc.call(operation, input);
		} catch (error) {
			throw new PackageDaemonError(error instanceof Error ? error.message : String(error), operation);
		}
	}

	async search(query: string, limit: number, offline = false): Promise<{ query: string; total: number; results: SearchPage["results"] }> {
		return this.call("package.search", { query, limit, offline });
	}

	info(name: string): Promise<PkgInfo> {
		return this.call("package.info", { name });
	}

	installed(): Promise<InstalledPkg[]> {
		return this.call("package.installed", {});
	}

	catalog(): Promise<{ fetchedAt?: string; sha256?: string; packages: Pkg[] }> {
		return this.call("package.catalog", {});
	}

	async mirror(): Promise<number> {
		try {
			return (await this.maintenanceRpc.call("package.catalog.sync", {})).synced;
		} catch (error) {
			throw new PackageDaemonError(error instanceof Error ? error.message : String(error), "package.catalog.sync");
		}
	}

	index(): Promise<PackageIndex | undefined> {
		return this.call("package.index", {});
	}

	async indexBuild(): Promise<PackageIndex> {
		try {
			return await this.indexRpc.call("package.index.build", {});
		} catch (error) {
			throw new PackageDaemonError(error instanceof Error ? error.message : String(error), "package.index.build");
		}
	}

	async updates(): Promise<UpdateEntry[]> {
		return (await this.call("package.updates", {})).updates;
	}

	async updatesForProject(projectRoot: string): Promise<UpdateEntry[]> {
		return (await this.call("package.updates.project", { projectRoot })).updates;
	}

	piStatus(): Promise<PiVersionReport> {
		return this.call("pi.status", {});
	}

	resourcesList(projectRoot?: string): Promise<{ global: PackageResources[]; project: PackageResources[] }> {
		return this.call("resources.list", { projectRoot });
	}

	async resourcesToggle(
		source: string,
		field: ResourceField,
		path: string,
		enabled: boolean,
		projectRoot?: string,
		approved?: boolean,
	): Promise<string> {
		return (await this.call("resources.toggle", { source, field, path, enabled, projectRoot, approved })).output;
	}

	advisoriesScan(name?: string): Promise<AdvisoryReport> {
		return this.call("advisories.scan", { name });
	}

	doctor(projectRoot?: string): Promise<DoctorReport> {
		return this.call("doctor.run", { projectRoot });
	}

	check(path: string, smoke = false): Promise<CheckReport> {
		return this.call("package.check", { path, smoke });
	}

	pack(path: string): Promise<PackReport> {
		return this.maintenanceRpc.call("package.pack", { path });
	}

	score(target: string): Promise<AdoptionReport> {
		return this.maintenanceRpc.call("package.score", { target });
	}

	setupExport(projectRoot: string, force = false, machineLocal = false): Promise<SetupExportReport> {
		return this.maintenanceRpc.call("setup.export", { projectRoot, force, machineLocal });
	}

	setupUpdate(manifestPath: string): Promise<SetupUpdateReport> {
		return this.maintenanceRpc.call("setup.update", { manifestPath });
	}

	setupPlan(manifestPath: string, prune = false): Promise<SetupPlan> {
		return this.maintenanceRpc.call("setup.plan", { manifestPath, prune });
	}

	setupApply(manifestPath: string, approved = false, prune = false): Promise<SetupApplyResult> {
		return this.maintenanceRpc.call("setup.apply", { manifestPath, approved, prune });
	}

	security(): Promise<SecuritySettings> {
		return this.call("package.security.get", {});
	}

	setMutationApproval(mutationApproval: MutationApproval, approved = false): Promise<SecuritySettings> {
		return this.call("package.security.set", { mutationApproval, approved });
	}

	async install(source: string, approved = false): Promise<string> {
		const result = await this.call("package.install", { source, approved });
		if (!result.ok) throw new PackageDaemonError(result.output || `failed to install ${source}`, "package.install");
		return result.output;
	}

	async installService(
		source: string,
		approved = false,
	): Promise<{ output: string; spec?: { name: string; binPath: string; descriptorPath: string } }> {
		const result = await this.call("package.install_service", { source, approved });
		if (!result.ok)
			throw new PackageDaemonError(
				result.output || `failed to install a persistent service for ${source}`,
				"package.install_service",
				undefined,
				result.notADaemon === true,
			);
		return { output: result.output, spec: result.spec };
	}

	async restartService(
		source: string,
		approved = false,
	): Promise<{ output: string; restarted?: boolean; spec?: { name: string; binPath: string; descriptorPath: string } }> {
		const result = await this.call("package.restart_service", { source, approved });
		if (!result.ok)
			throw new PackageDaemonError(
				result.output || `failed to restart the persistent service for ${source}`,
				"package.restart_service",
				undefined,
				result.notADaemon === true,
			);
		return { output: result.output, restarted: result.restarted, spec: result.spec };
	}

	async remove(name: string, approved = false): Promise<string> {
		const result = await this.call("package.remove", { name, approved });
		if (!result.ok) throw new PackageDaemonError(result.output || `failed to remove ${name}`, "package.remove");
		return result.output;
	}

	async update(source: string, approved = false): Promise<UpdateOutcome> {
		const result = await this.call("package.update", { source, approved });
		if (!result.ok) throw new PackageDaemonError(result.output || `failed to update ${source}`, "package.update");
		return {
			output: result.output,
			reloadRequired: result.reloadRequired ?? true,
			alreadyUpToDate: result.alreadyUpToDate ?? false,
			pinned: result.pinned ?? false,
			previousVersion: result.previousVersion,
			currentVersion: result.currentVersion,
		};
	}
}

export class PackageDaemonInstaller implements Installer {
	constructor(private readonly client: PackageDaemonClient) {}
	install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		return this.client.install(source, options?.approved);
	}
	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		if (!source.startsWith("npm:") || source.length <= 4)
			throw new PackageDaemonError("daemon package removal requires an npm: source", "package.remove");
		return this.client.remove(source.slice(4), options?.approved);
	}
	update(source: string, options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome> {
		return this.client.update(source, options?.approved);
	}
}

export class DaemonBackedSecurity {
	constructor(private readonly paths: PackedPaths = resolvePackedPaths()) {}
	async security(): Promise<SecuritySettings> {
		return (await connectPackageDaemon(this.paths)).security();
	}
	async setMutationApproval(value: MutationApproval, options?: { approved?: boolean }): Promise<SecuritySettings> {
		return (await connectPackageDaemon(this.paths)).setMutationApproval(value, options?.approved);
	}
}

export class DaemonBackedInstaller implements Installer {
	constructor(private readonly paths: PackedPaths = resolvePackedPaths()) {}
	async install(source: string, options?: { approved?: boolean }): Promise<string> {
		return (await connectPackageDaemon(this.paths)).install(source, options?.approved);
	}
	async remove(source: string, options?: { approved?: boolean }): Promise<string> {
		return new PackageDaemonInstaller(await connectPackageDaemon(this.paths)).remove(source, options);
	}
	async update(source: string, options?: { approved?: boolean }): Promise<UpdateOutcome> {
		return (await connectPackageDaemon(this.paths)).update(source, options?.approved);
	}
}

export interface DaemonServiceInstallerPort {
	install(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; spec?: { name: string; binPath: string; descriptorPath: string } }>;
	restart(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; restarted?: boolean; spec?: { name: string; binPath: string; descriptorPath: string } }>;
}

export class DaemonBackedDaemonServiceInstaller implements DaemonServiceInstallerPort {
	constructor(private readonly paths: PackedPaths = resolvePackedPaths()) {}
	async restart(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; restarted?: boolean; spec?: { name: string; binPath: string; descriptorPath: string } }> {
		return (await connectPackageDaemon(this.paths)).restartService(source, approved);
	}
	async install(
		source: string,
		approved?: boolean,
	): Promise<{ output: string; spec?: { name: string; binPath: string; descriptorPath: string } }> {
		return (await connectPackageDaemon(this.paths)).installService(source, approved);
	}
}

export class DaemonRegistry implements Registry {
	private readonly client: PackageDaemonClient;
	constructor(base: string, token: string, transport: FetchTransport = fetch) {
		this.client = new PackageDaemonClient(base, token, transport);
	}
	async search(query: string, limit: number): Promise<SearchPage> {
		const body = await this.client.search(query, limit);
		return { results: body.results, total: body.total };
	}
	async searchPage(query: string, _from: number, size: number): Promise<SearchPage> {
		return this.search(query, size).catch(() => ({ results: [], total: 0 }));
	}
	async searchAll(): Promise<never> {
		throw new Error("searchAll is not supported via the daemon proxy");
	}
	info(name: string): Promise<PkgInfo> {
		return this.client.info(name);
	}
}

/** version is the daemon's own live-reported version (its real /health
 * response, not a guess) -- an auto-spawned or supervised daemon process
 * can outlive the source/package it was started from, silently serving
 * stale code for as long as it stays reachable. Confirmed live: an 11-
 * hour-old daemon kept flagging false "update available" rows because it
 * predated a same-day fix to the exact comparison logic deciding that. */
export interface DaemonHandle {
	base: string;
	token: string;
	version: string;
}

export async function probe(paths: PackedPaths = resolvePackedPaths()): Promise<DaemonHandle | undefined> {
	const handle = readDaemonHandle(paths.handle);
	if (!handle) return undefined;
	let token: string;
	try {
		token = readFileSync(paths.token, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
	} catch {
		return undefined;
	}
	const base = `http://${handle.host}:${handle.port}`;
	try {
		const rpc = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(base, token, {
			label: "Packed",
			transport: timeoutTransport(fetch, PROBE_TIMEOUT_MS),
		});
		const health = await rpc.health();
		return { base, token, version: health.version };
	} catch {
		return undefined;
	}
}

export async function connectPackageDaemon(paths: PackedPaths = resolvePackedPaths()): Promise<PackageDaemonClient> {
	const handle = await probe(paths);
	if (!handle) throw new Error("pi-packed daemon is unavailable; start packed.service");
	return new PackageDaemonClient(handle.base, handle.token);
}

export async function resolveRegistry(paths: PackedPaths, npmBase: string): Promise<Registry> {
	const handle = await probe(paths);
	return handle ? new DaemonRegistry(handle.base, handle.token) : new HttpRegistry(npmBase);
}
