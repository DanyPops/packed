import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { readDaemonHandle, resolveDaemonPaths } from "@danypops/daemon-kit/paths";
import type { ExtensionOperationInputs, ExtensionOperationName, ExtensionOperationOutputs, PackageInfo, PackageSummary, SecuritySettings, SetupApplyResult, SetupPlan, UpdateEntry, UpdateOutcome } from "./protocol.js";

export interface PackedClientPaths { token: string; handle: string; }
export interface PackedPathOptions { env?: Record<string, string | undefined>; home?: string; platform?: NodeJS.Platform; }
export interface PackedExtensionClient {
	search(query: string, limit: number, offline?: boolean): Promise<{ query: string; total: number; results: PackageSummary[] }>;
	info(name: string): Promise<PackageInfo>;
	installed(): Promise<ExtensionOperationOutputs["package.installed"]>;
	updates(): Promise<UpdateEntry[]>;
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: SecuritySettings["mutationApproval"], approved?: boolean): Promise<SecuritySettings>;
	install(source: string, approved?: boolean): Promise<string>;
	remove(name: string, approved?: boolean): Promise<string>;
	update(source: string, approved?: boolean): Promise<UpdateOutcome>;
	setupPlan(manifestPath: string, prune?: boolean): Promise<SetupPlan>;
	setupApply(manifestPath: string, approved?: boolean, prune?: boolean): Promise<SetupApplyResult>;
}

export function resolvePackedClientPaths(options: PackedPathOptions = {}): PackedClientPaths {
	const env = options.env ?? process.env;
	if (env.PI_PACKED_HOME) {
		const directory = resolve(env.PI_PACKED_HOME);
		return { token: `${directory}/token`, handle: `${directory}/handle.json` };
	}
	const paths = resolveDaemonPaths({ stateDirectoryName: "pi-packed", databaseFilename: "packages.db", tokenFilename: "token", handleFilename: "handle.json", systemdUnitName: "pi-packed.service" }, options);
	return { token: paths.token, handle: paths.handle };
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
	async remove(name: string, approved = false) { const result = await this.call("package.remove", { name, approved }); if (!result.ok) throw new Error(result.output); return result.output; }
	async update(source: string, approved = false): Promise<UpdateOutcome> { const result = await this.call("package.update", { source, approved }); if (!result.ok) throw new Error(result.output); return { output: result.output, reloadRequired: result.reloadRequired ?? true, alreadyUpToDate: result.alreadyUpToDate ?? false, pinned: result.pinned ?? false, previousVersion: result.previousVersion, currentVersion: result.currentVersion }; }
	setupPlan(manifestPath: string, prune = false) { return this.call("setup.plan", { manifestPath, prune }); }
	setupApply(manifestPath: string, approved = false, prune = false) { return this.call("setup.apply", { manifestPath, approved, prune }); }
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

export async function ensurePackedClient(paths = resolvePackedClientPaths(), transport: FetchTransport = fetch): Promise<PackedClient> {
	try { return await connectPackedClient(paths, transport); } catch {}
	const override = process.env.PI_PACKED_BIN;
	const command = override ?? process.env.PI_PACKED_BUN ?? "bun";
	const args = override ? ["serve"] : [join(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts"), "serve"];
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, DAEMON_KIT_LAUNCH_PROVENANCE: "auto-spawn" },
	});
	child.once("error", () => {});
	child.unref();
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		try { return await connectPackedClient(paths, transport); } catch {}
	}
	throw new Error("Packed daemon did not become ready within 3 seconds");
}
