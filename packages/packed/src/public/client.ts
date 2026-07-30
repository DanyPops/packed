import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { readDaemonHandle, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import { isServiceInstalled as daemonKitIsServiceInstalled } from "@danypops/daemon-kit/service";
import type { ExtensionOperationInputs, ExtensionOperationName, ExtensionOperationOutputs, PackageInfo, PackageResources, PackageSummary, PiStatus, ResourceField, SecuritySettings, ServiceSpecSummary, SetupApplyResult, SetupPlan, UpdateEntry, UpdateOutcome } from "./protocol.js";

/** notADaemon: the overwhelmingly common case for install() -- most Pi packages aren't daemons at all. Distinct from a real installService failure (systemctl unavailable, spec resolved but installation itself failed). */
export class InstallServiceError extends Error {
	constructor(message: string, readonly notADaemon?: boolean) {
		super(message);
		this.name = "InstallServiceError";
	}
}

export interface PackedClientPaths { token: string; handle: string; serviceDescriptor: string; }
const SERVICE_NAME = "pi-packed";
const SERVICE_UNIT_NAME = "pi-packed.service";
export interface PackedPathOptions { env?: Record<string, string | undefined>; home?: string; platform?: NodeJS.Platform; }
export interface PackedExtensionClient {
	search(query: string, limit: number, offline?: boolean): Promise<{ query: string; total: number; results: PackageSummary[] }>;
	info(name: string): Promise<PackageInfo>;
	installed(): Promise<ExtensionOperationOutputs["package.installed"]>;
	updates(): Promise<UpdateEntry[]>;
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: SecuritySettings["mutationApproval"], approved?: boolean): Promise<SecuritySettings>;
	install(source: string, approved?: boolean): Promise<string>;
	installService(source: string, approved?: boolean): Promise<{ output: string; spec?: ServiceSpecSummary }>;
	remove(name: string, approved?: boolean): Promise<string>;
	update(source: string, approved?: boolean): Promise<UpdateOutcome>;
	setupPlan(manifestPath: string, prune?: boolean): Promise<SetupPlan>;
	setupApply(manifestPath: string, approved?: boolean, prune?: boolean): Promise<SetupApplyResult>;
	listResources(projectRoot?: string): Promise<{ global: PackageResources[]; project: PackageResources[] }>;
	toggleResource(source: string, field: ResourceField, path: string, enabled: boolean, projectRoot?: string, approved?: boolean): Promise<string>;
	piStatus(): Promise<PiStatus>;
}

export function resolvePackedClientPaths(options: PackedPathOptions = {}): PackedClientPaths {
	const env = options.env ?? process.env;
	if (env.PI_PACKED_HOME) {
		const directory = resolve(env.PI_PACKED_HOME);
		return { token: `${directory}/token`, handle: `${directory}/handle.json`, serviceDescriptor: `${directory}/${SERVICE_UNIT_NAME}` };
	}
	const paths = resolveDaemonPaths({ stateDirectoryName: "pi-packed", databaseFilename: "packages.db", tokenFilename: "token", handleFilename: "handle.json", systemdUnitName: SERVICE_UNIT_NAME }, options);
	return { token: paths.token, handle: paths.handle, serviceDescriptor: paths.serviceDescriptor };
}

/** Real, file-existence-only check on Linux/macOS (Windows checks a
 * registry Run key instead) -- cheap, synchronous, no subprocess. */
function isPackedServiceInstalled(serviceDescriptor: string): boolean {
	return daemonKitIsServiceInstalled(
		{ name: SERVICE_NAME, binPath: "", descriptorPath: serviceDescriptor },
		{ fileExists: existsSync, writeFile: () => {}, readFile: () => null, removeFile: () => {}, mkdirp: () => {}, runCommand: () => ({ ok: false, output: "" }), which: () => false },
	);
}

export type FetchTransport = (request: Request) => Promise<Response>;

function boundedTransport(transport: FetchTransport, timeoutMs = 30_000): FetchTransport {
	return (request) => transport(new Request(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) }));
}

export class PackedClient implements PackedExtensionClient {
	private readonly rpc: AuthenticatedRpcClient<ExtensionOperationName, ExtensionOperationInputs, ExtensionOperationOutputs>;
	constructor(base: string, token: string, transport: FetchTransport = fetch) {
		this.rpc = new AuthenticatedRpcClient(base, token, { label: "Packed", transport: boundedTransport(transport) });
	}
	private call<Name extends ExtensionOperationName>(name: Name, input: ExtensionOperationInputs[Name]): Promise<ExtensionOperationOutputs[Name]> { return this.rpc.call(name, input); }
	health(): Promise<unknown> { return this.rpc.health(); }
	search(query: string, limit: number, offline = false) { return this.call("package.search", { query, limit, offline }); }
	info(name: string) { return this.call("package.info", { name }); }
	installed() { return this.call("package.installed", {}); }
	async updates() { return (await this.call("package.updates", {})).updates; }
	security() { return this.call("package.security.get", {}); }
	setMutationApproval(mutationApproval: SecuritySettings["mutationApproval"], approved = false) { return this.call("package.security.set", { mutationApproval, approved }); }
	async install(source: string, approved = false) { const result = await this.call("package.install", { source, approved }); if (!result.ok) throw new Error(result.output); return result.output; }
	async installService(source: string, approved = false) { const result = await this.call("package.install_service", { source, approved }); if (!result.ok) throw new InstallServiceError(result.output, result.notADaemon); return { output: result.output, spec: result.spec }; }
	async remove(name: string, approved = false) { const result = await this.call("package.remove", { name, approved }); if (!result.ok) throw new Error(result.output); return result.output; }
	async update(source: string, approved = false): Promise<UpdateOutcome> { const result = await this.call("package.update", { source, approved }); if (!result.ok) throw new Error(result.output); return { output: result.output, reloadRequired: result.reloadRequired ?? true, alreadyUpToDate: result.alreadyUpToDate ?? false, pinned: result.pinned ?? false, previousVersion: result.previousVersion, currentVersion: result.currentVersion }; }
	setupPlan(manifestPath: string, prune = false) { return this.call("setup.plan", { manifestPath, prune }); }
	setupApply(manifestPath: string, approved = false, prune = false) { return this.call("setup.apply", { manifestPath, approved, prune }); }
	listResources(projectRoot?: string) { return this.call("resources.list", { projectRoot }); }
	async toggleResource(source: string, field: ResourceField, path: string, enabled: boolean, projectRoot?: string, approved = false) { const result = await this.call("resources.toggle", { source, field, path, enabled, projectRoot, approved }); if (!result.ok) throw new Error(result.output); return result.output; }
	piStatus() { return this.call("pi.status", {}); }
}

export async function connectPackedClient(paths = resolvePackedClientPaths(), transport: FetchTransport = fetch): Promise<PackedClient> {
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("Packed daemon is not running");
	let token: string;
	try { token = readFileSync(paths.token, "utf8").trim(); } catch { throw new Error("Packed daemon token is unavailable"); }
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Packed daemon token is invalid");
	const client = new PackedClient(`http://${handle.host}:${handle.port}`, token, transport);
	await client.health();
	return client;
}

export interface EnsureClientDeps {
	connect(): Promise<PackedClient>;
	/** Real OS check, not a guess -- does this machine have a supervised
	 * service registered for this daemon (systemd --user unit / launchd
	 * plist / Windows Run key)? */
	isServiceInstalled(): boolean;
	/** Spawns a detached, self-contained daemon for this session only.
	 * Never called when isServiceInstalled() is true. */
	spawn(): void;
	sleep(ms: number): Promise<void>;
	retryAttempts?: number;
	retryDelayMs?: number;
}

/**
 * Pure connect-or-provision decision, fully dependency-injected and
 * unit-testable without a real filesystem, subprocess, or network call.
 *
 * A real, confirmed hazard motivates the isServiceInstalled() branch: an
 * auto-spawned orphan gets daemon-kit's 30-minute idle budget (vs. a
 * supervised service's own, typically much shorter, policy), so it can
 * keep winning daemon-kit's single-instance lock race against every
 * subsequent supervised restart, invisibly, for up to half an hour. When a
 * service is installed, this never spawns a second, differently-supervised
 * process -- it retries the connection instead, on the assumption the
 * supervisor is responsible for the daemon actually being reachable, and
 * fails with a message pointing at the service rather than silently
 * creating a competing one.
 */
export async function ensureClient(deps: EnsureClientDeps): Promise<PackedClient> {
	try { return await deps.connect(); } catch {}
	const attempts = deps.retryAttempts ?? 30;
	const delayMs = deps.retryDelayMs ?? 100;
	const serviceInstalled = deps.isServiceInstalled();
	if (!serviceInstalled) deps.spawn();
	for (let attempt = 0; attempt < attempts; attempt++) {
		await deps.sleep(delayMs);
		try { return await deps.connect(); } catch {}
	}
	const waitedSeconds = (attempts * delayMs) / 1000;
	throw new Error(
		serviceInstalled
			? `Packed daemon did not become ready within ${waitedSeconds} seconds, but a supervised service is installed -- check it directly (e.g. systemctl --user status pi-packed.service) rather than auto-spawning a second one`
			: `Packed daemon did not become ready within ${waitedSeconds} seconds`,
	);
}

export async function ensurePackedClient(paths = resolvePackedClientPaths(), transport: FetchTransport = fetch): Promise<PackedClient> {
	return ensureClient({
		connect: () => connectPackedClient(paths, transport),
		isServiceInstalled: () => isPackedServiceInstalled(paths.serviceDescriptor),
		spawn: () => {
			const override = process.env.PI_PACKED_BIN;
			const command = override ?? process.env.PI_PACKED_BUN ?? "bun";
			const args = override ? ["serve"] : [join(dirname(fileURLToPath(import.meta.url)), "../src/cli/cli.ts"), "serve"];
			const child = spawn(command, args, {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, DAEMON_KIT_LAUNCH_PROVENANCE: "auto-spawn" },
			});
			child.once("error", () => {});
			child.unref();
		},
		sleep: (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
	});
}
