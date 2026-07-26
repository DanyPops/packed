/**
 * packed.ts — thin Pi extension seam over the authenticated package daemon.
 *
 * Pi's extension runtime is Node-compatible and does not guarantee a global
 * `Bun`. All registry reads, SQLite access, and package mutations therefore
 * stay inside the supervised Bun daemon. A restarted daemon binds a new
 * port/token, which would otherwise leave a stale cached client behind for
 * the rest of the Pi session -- daemon-kit's createRetryingClient detects
 * that on the failing call itself and reconnects, so the happy path reuses
 * one connected client instead of reconnecting on every single operation.
 */
import { createRetryingClient } from "@danypops/daemon-kit/pi-client";
import type { PackageDaemonPort as ClientPackageDaemonPort } from "../../src/client.ts";
import type { InstalledPkg, Pkg, PkgInfo, UpdateEntry, UpdateOutcome } from "../../src/ports.ts";
import type { MutationApproval, SecuritySettings } from "../../src/security.ts";

export type { InstalledPkg, UpdateEntry, UpdateOutcome };
export type PackageInfo = PkgInfo;
export type PackageDaemonPort = ClientPackageDaemonPort;

export interface SearchResponse {
	query: string;
	total: number;
	results: Pkg[];
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
	remove(name: string, approved?: boolean): Promise<string>;
	update(source: string, approved?: boolean): Promise<UpdateOutcome>;
}

export type PackageDaemonConnector = () => Promise<PackageDaemonPort>;

async function connectDefaultDaemon(): Promise<PackageDaemonPort> {
	const [client, state] = await Promise.all([
		import("../../src/client.ts"),
		import("../../src/state.ts"),
	]);
	return client.connectPackageDaemon(state.stateDir());
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
		remove: (name, approved) => client.call((daemon) => daemon.remove(name, approved)),
		update: (source, approved) => client.call((daemon) => daemon.update(source, approved)),
	};
}
