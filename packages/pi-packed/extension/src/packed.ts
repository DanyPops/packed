/**
 * packed.ts — thin Pi extension seam over the authenticated package daemon.
 *
 * Pi's extension runtime is Node-compatible and does not guarantee a global
 * `Bun`. All registry reads, SQLite access, and package mutations therefore
 * stay inside the supervised Bun daemon. A restarted daemon binds a new
 * port/token, which would otherwise leave a stale cached client behind for
 * the rest of the Pi session -- vehicle-client's createRetryingClient detects
 * that on the failing call itself and reconnects, so the happy path reuses
 * one connected client instead of reconnecting on every single operation.
 */
import { createRetryingClient } from "@danypops/vehicle-client/daemon-client";
import { ensurePackedClient, InstallServiceError, type PackedExtensionClient } from "@danypops/packed/client";
import { PI_COMMAND_NAME, type InstalledPackage, type PackageInfo, type PackageResources, type PackageSummary, type PiStatus, type ResourceField, type SecuritySettings, type ServiceSpecSummary, type SetupApplyResult, type SetupPlan, type UpdateEntry, type UpdateOutcome } from "@danypops/packed/protocol";

export { InstallServiceError, PI_COMMAND_NAME };

export type { PackageInfo, PackageResources, PiStatus, ResourceField, UpdateEntry, UpdateOutcome };
export type InstalledPkg = InstalledPackage;
export type PackageDaemonPort = PackedExtensionClient;
type MutationApproval = SecuritySettings["mutationApproval"];

export interface SearchResponse {
	query: string;
	total: number;
	results: PackageSummary[];
}

export interface Natives {
	search(query: string, limit: number): Promise<SearchResponse>;
	searchOffline(query: string, limit: number): Promise<SearchResponse>;
	info(name: string): Promise<PackageInfo>;
	installed(): Promise<InstalledPkg[]>;
	updates(): Promise<UpdateEntry[]>;
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: MutationApproval, approved?: boolean): Promise<SecuritySettings>;
	install(source: string, approved?: boolean): Promise<string>;
	/** Throws InstallServiceError; check .notADaemon before surfacing a failure -- most packages aren't daemons at all. */
	installService(source: string, approved?: boolean): Promise<{ output: string; spec?: ServiceSpecSummary }>;
	remove(name: string, approved?: boolean): Promise<string>;
	update(source: string, approved?: boolean): Promise<UpdateOutcome>;
	setupPlan(manifestPath: string, prune?: boolean): Promise<SetupPlan>;
	setupApply(manifestPath: string, approved?: boolean, prune?: boolean): Promise<SetupApplyResult>;
	listResources(projectRoot?: string): Promise<{ global: PackageResources[]; project: PackageResources[] }>;
	toggleResource(source: string, field: ResourceField, path: string, enabled: boolean, projectRoot?: string, approved?: boolean): Promise<string>;
	piStatus(): Promise<PiStatus>;
}

export type PackageDaemonConnector = () => Promise<PackageDaemonPort>;

async function connectDefaultDaemon(): Promise<PackageDaemonPort> {
	return ensurePackedClient();
}

export async function createNatives(connect: PackageDaemonConnector = connectDefaultDaemon): Promise<Natives> {
	const client = createRetryingClient(connect, { label: "pi-packed" });

	return {
		search: (query, limit) => client.call((daemon) => daemon.search(query, limit)),
		searchOffline: (query, limit) => client.call((daemon) => daemon.search(query, limit, true)),
		info: (name) => client.call((daemon) => daemon.info(name)),
		installed: () => client.call((daemon) => daemon.installed()),
		updates: () => client.call((daemon) => daemon.updates()),
		security: () => client.call((daemon) => daemon.security()),
		setMutationApproval: (value, approved) => client.call((daemon) => daemon.setMutationApproval(value, approved)),
		install: (source, approved) => client.call((daemon) => daemon.install(source, approved)),
		installService: (source, approved) => client.call((daemon) => daemon.installService(source, approved)),
		remove: (name, approved) => client.call((daemon) => daemon.remove(name, approved)),
		update: (source, approved) => client.call((daemon) => daemon.update(source, approved)),
		setupPlan: (manifestPath, prune) => client.call((daemon) => daemon.setupPlan(manifestPath, prune)),
		setupApply: (manifestPath, approved, prune) => client.call((daemon) => daemon.setupApply(manifestPath, approved, prune)),
		listResources: (projectRoot) => client.call((daemon) => daemon.listResources(projectRoot)),
		toggleResource: (source, field, path, enabled, projectRoot, approved) => client.call((daemon) => daemon.toggleResource(source, field, path, enabled, projectRoot, approved)),
		piStatus: () => client.call((daemon) => daemon.piStatus()),
	};
}
