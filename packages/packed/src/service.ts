/**
 * service.ts — the hexagon's HTTP driving adapter as a pure Web Standard
 * handler: (Request) → Response. Bun.serve wraps it for the network;
 * tests call it in-process. Same port, two adapters — Cockburn's symmetry.
 */
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import { buildSearchQuery, clampLimit } from "./ports.ts";
import type { InstalledPkg, Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome, UpdatesSnapshot } from "./ports.ts";
import { TTLCache } from "./cache.ts";
import { syncCatalog } from "./catalog.ts";
import { loadUpdates } from "./watcher.ts";
import { readInstalledPackages, defaultPiHome } from "./installed.ts";
import { openDb, searchLocal, catalogList, getSyncMeta, dbPath } from "./db.ts";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "./constants.ts";
import { VERSION } from "./version.ts";
import { createLogger } from "./log.ts";
import { StaticPackageChecker, type CheckReport, type PackageChecker } from "./check.ts";
import { NpmPackVerifier, type PackReport } from "./pack.ts";
import { scoreTarget, type AdoptionReport } from "./score.ts";
import { SetupManager, type SetupApplyResult, type SetupExportReport, type SetupPlan, type SetupUpdateReport } from "./setup.ts";
import { RealDaemonServiceInstaller, type DaemonServiceInstaller } from "./daemon-service.ts";
import type { ServiceInstallResult, ServiceSpec } from "@danypops/daemon-kit/service";
import {
	assertPackagePermission,
	PackageApprovalRequiredError,
	readSecuritySettings,
	writeSecuritySettings,
	type MutationApproval,
	type PackageOperation,
} from "./security.ts";

const log = createLogger("service");

export interface Deps {
	reg: Registry;
	inst: Installer;
	token: string;
	stateDir: string;
	dataDir?: string;
	piHome?: string;
	cache?: TTLCache;
	checker?: PackageChecker;
	packer?: { verify(path: string): Promise<PackReport> };
	scorer?: { score(target: string): Promise<AdoptionReport> };
	setup?: {
		export(projectRoot: string, options?: { force?: boolean; machineLocal?: boolean }): Promise<SetupExportReport>;
		update(manifestPath: string): Promise<SetupUpdateReport>;
		plan(manifestPath: string, options?: { prune?: boolean }): Promise<SetupPlan>;
		apply(manifestPath: string, options?: { prune?: boolean }): Promise<SetupApplyResult>;
	};
	daemonServiceInstaller?: DaemonServiceInstaller;
}

export type OperationName =
	| "package.search"
	| "package.info"
	| "package.installed"
	| "package.catalog"
	| "package.catalog.sync"
	| "package.updates"
	| "package.check"
	| "package.pack"
	| "package.score"
	| "setup.export"
	| "setup.update"
	| "setup.plan"
	| "setup.apply"
	| "package.security.get"
	| "package.security.set"
	| "package.install"
	| "package.install_service"
	| "package.remove"
	| "package.update";

export interface OperationInputs {
	"package.search": { query: string; limit: number; offline?: boolean };
	"package.info": { name: string };
	"package.installed": Record<string, never>;
	"package.catalog": Record<string, never>;
	"package.catalog.sync": Record<string, never>;
	"package.updates": Record<string, never>;
	"package.check": { path: string; smoke?: boolean };
	"package.pack": { path: string };
	"package.score": { target: string };
	"setup.export": { projectRoot: string; force?: boolean; machineLocal?: boolean };
	"setup.update": { manifestPath: string };
	"setup.plan": { manifestPath: string; prune?: boolean };
	"setup.apply": { manifestPath: string; approved?: boolean; prune?: boolean };
	"package.security.get": Record<string, never>;
	"package.security.set": { mutationApproval: MutationApproval; approved?: boolean };
	"package.install": { source: string; approved?: boolean };
	"package.install_service": { source: string; approved?: boolean };
	"package.remove": { name: string; approved?: boolean };
	"package.update": { source: string; approved?: boolean };
}

interface MutationResponse { ok: boolean; output: string }
interface UpdateMutationResponse extends MutationResponse, Partial<Omit<UpdateOutcome, "output">> {}
interface InstallServiceResponse { ok: boolean; output: string; spec?: Pick<ServiceSpec, "name" | "binPath" | "descriptorPath"> }

export interface OperationOutputs {
	"package.search": { query: string; total: number; results: SearchPage["results"]; offline?: boolean };
	"package.info": PkgInfo;
	"package.installed": InstalledPkg[];
	"package.catalog": { fetchedAt?: string; sha256?: string; packages: Pkg[] };
	"package.catalog.sync": { synced: number };
	"package.updates": UpdatesSnapshot;
	"package.check": CheckReport;
	"package.pack": PackReport;
	"package.score": AdoptionReport;
	"setup.export": SetupExportReport;
	"setup.update": SetupUpdateReport;
	"setup.plan": SetupPlan;
	"setup.apply": SetupApplyResult;
	"package.security.get": { mutationApproval: MutationApproval };
	"package.security.set": { mutationApproval: MutationApproval };
	"package.install": MutationResponse;
	"package.install_service": InstallServiceResponse;
	"package.remove": MutationResponse;
	"package.update": UpdateMutationResponse;
}

export const OPERATION_NAMES: readonly OperationName[] = [
	"package.search", "package.info", "package.installed", "package.catalog", "package.catalog.sync", "package.updates", "package.check", "package.pack", "package.score",
	"setup.export", "setup.update", "setup.plan", "setup.apply",
	"package.security.get", "package.security.set", "package.install", "package.install_service", "package.remove", "package.update",
];

class PackageOperationError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

const SOURCE_RE = /^(npm:[A-Za-z0-9@._/-]+|git:[A-Za-z0-9@:._/-]+|https:\/\/[A-Za-z0-9@:._/?=&%~-]+)$/;
const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

function json(v: unknown, init?: ResponseInit): Response {
	return jsonResponse(v, init);
}

function err(status: number, msg: string, details: Record<string, unknown> = {}): Response {
	return jsonResponse({ error: msg, ...details }, { status });
}

function pickSpec(spec: ServiceSpec): Pick<ServiceSpec, "name" | "binPath" | "descriptorPath"> {
	return { name: spec.name, binPath: spec.binPath, descriptorPath: spec.descriptorPath };
}

export function createApp(deps: Deps): { fetch: (req: Request) => Promise<Response> } {
	const cache = deps.cache ?? new TTLCache();
	const dataDir = deps.dataDir ?? deps.stateDir;
	const checker = deps.checker ?? new StaticPackageChecker();
	const packer = deps.packer ?? new NpmPackVerifier();
	const setup = deps.setup ?? new SetupManager(deps.reg, deps.inst, deps.piHome ?? defaultPiHome());
	const daemonServiceInstaller = deps.daemonServiceInstaller ?? new RealDaemonServiceInstaller();
	const piHomeForServiceInstall = deps.piHome ?? defaultPiHome();

	function authorize(operation: PackageOperation, approved: boolean): Response | undefined {
		try {
			assertPackagePermission(readSecuritySettings(deps.stateDir), operation, approved);
			return undefined;
		} catch (error) {
			if (error instanceof PackageApprovalRequiredError) {
				return err(403, error.message, { code: error.code, operation: error.operation });
			}
			throw error;
		}
	}

	async function route(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;

		if (path === "/health" && req.method === "GET") return healthResponse(VERSION);
		if (path === "/ready" && req.method === "GET") return readyResponse(true);

		if (path === "/security" && req.method === "GET") {
			return json(readSecuritySettings(deps.stateDir));
		}

		if (path === "/security" && req.method === "POST") {
			let body: { mutationApproval?: unknown; approved?: unknown };
			try {
				body = (await req.json()) as typeof body;
			} catch {
				return err(400, "invalid security settings JSON");
			}
			if (body.mutationApproval !== "always" && body.mutationApproval !== "never") {
				return err(400, "mutationApproval must be always or never");
			}
			const denied = authorize("security.write", body.approved === true);
			if (denied) return denied;
			return json(writeSecuritySettings(deps.stateDir, { mutationApproval: body.mutationApproval as MutationApproval }));
		}

		if (path === "/search" && req.method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const limit = clampLimit(Number(url.searchParams.get("limit")), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
			// offline=1: serve from the SQLite mirror (apt-cache search analog)
			if (url.searchParams.get("offline") === "1") {
				const db = openDb(dbPath(dataDir));
				try {
					const results = searchLocal(db, q, limit);
					return json({ query: q, total: results.length, results, offline: true });
				} finally {
					db.close();
				}
			}
			try {
				const { results, total } = await deps.reg.search(buildSearchQuery(q), limit);
				return json({ query: q, total, results });
			} catch (e) {
				return err(502, e instanceof Error ? e.message : String(e));
			}
		}

		if (path === "/info" && req.method === "GET") {
			const name = url.searchParams.get("name") ?? "";
			if (!name) return err(400, "missing name");
			try {
				return json(await deps.reg.info(name));
			} catch (e) {
				return err(502, e instanceof Error ? e.message : String(e));
			}
		}

		if (path === "/installed" && req.method === "GET") {
			return json(readInstalledPackages(deps.piHome ?? defaultPiHome()));
		}

		if (path === "/remove" && req.method === "POST") {
			let name = "";
			let approved = false;
			try {
				const body = (await req.json()) as { name?: unknown; approved?: unknown };
				name = String(body.name ?? "");
				approved = body.approved === true;
			} catch {
				/* fall through to validation */
			}
			if (!NAME_RE.test(name)) {
				return err(400, "invalid name; want a bare npm package name");
			}
			const denied = authorize("remove", approved);
			if (denied) return denied;
			try {
				const output = await deps.inst.remove(`npm:${name}`, { approved });
				return json({ ok: true, name, output });
			} catch (e) {
				return json({ ok: false, name, output: e instanceof Error ? e.message : String(e) });
			}
		}

		if (path === "/install" && req.method === "POST") {
			let source = "";
			let approved = false;
			try {
				const body = (await req.json()) as { source?: unknown; approved?: unknown };
				source = String(body.source ?? "");
				approved = body.approved === true;
			} catch {
				/* fall through to validation */
			}
			if (!SOURCE_RE.test(source)) {
				return err(400, "invalid source; want npm:<pkg>[@ver], git:<host>/<owner>/<repo>[@ref], or https://…");
			}
			const denied = authorize("install", approved);
			if (denied) return denied;
			try {
				const output = await deps.inst.install(source, { approved });
				return json({ ok: true, source, output });
			} catch (e) {
				return json({ ok: false, source, output: e instanceof Error ? e.message : String(e) });
			}
		}

		if (path === "/install-service" && req.method === "POST") {
			let source = "";
			let approved = false;
			try {
				const body = (await req.json()) as { source?: unknown; approved?: unknown };
				source = String(body.source ?? "");
				approved = body.approved === true;
			} catch {
				/* fall through to validation */
			}
			if (!SOURCE_RE.test(source)) {
				return err(400, "invalid source; want npm:<pkg>[@ver] -- daemon-service installation only supports npm sources today");
			}
			const denied = authorize("install_service", approved);
			if (denied) return denied;
			const resolved = daemonServiceInstaller.install(piHomeForServiceInstall, source);
			if (!resolved.ok) return json({ ok: false, output: resolved.reason });
			if (!resolved.result.installed) return json({ ok: false, output: resolved.result.reason, spec: pickSpec(resolved.spec) });
			return json({ ok: true, output: `installed a persistent service for ${resolved.spec.name}`, spec: pickSpec(resolved.spec) });
		}

		if (path === "/update" && req.method === "POST") {
			let source = "";
			let approved = false;
			try {
				const body = (await req.json()) as { source?: unknown; approved?: unknown };
				source = String(body.source ?? "");
				approved = body.approved === true;
			} catch {
				/* fall through to validation */
			}
			if (!SOURCE_RE.test(source)) {
				return err(400, "invalid source; want a configured npm:, git:, or https package source");
			}
			const denied = authorize("update", approved);
			if (denied) return denied;
			try {
				const outcome = await deps.inst.update(source, { approved });
				return json({ ok: true, source, ...outcome });
			} catch (error) {
				return json({ ok: false, source, output: error instanceof Error ? error.message : String(error), reloadRequired: false });
			}
		}

		if (path === "/updates" && req.method === "GET") {
			const snap = await loadUpdates(deps.stateDir);
			return json(snap ?? { updates: [] });
		}

		if (path === "/catalog" && req.method === "GET") {
			const db = openDb(dbPath(dataDir));
			try {
				const meta = getSyncMeta(db);
				return json({ fetchedAt: meta?.fetchedAt, sha256: meta?.sha256, packages: catalogList(db) });
			} finally {
				db.close();
			}
		}

		return err(404, "not found");
	}

	async function executeOperation<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
		if (op === "package.catalog.sync") return { synced: await syncCatalog(deps.reg, dataDir) } as OperationOutputs[Name];
		if (op === "package.check" || op === "package.pack") {
			const packagePath = (input as OperationInputs["package.check"] | OperationInputs["package.pack"]).path;
			if (typeof packagePath !== "string" || packagePath.length === 0 || packagePath.length > 4_096) throw new PackageOperationError("path must be a non-empty string up to 4096 characters", 400);
			if (op === "package.pack") return await packer.verify(packagePath) as OperationOutputs[Name];
			return await checker.check(packagePath, { smoke: (input as OperationInputs["package.check"]).smoke === true }) as OperationOutputs[Name];
		}
		if (op === "package.score") {
			const target = (input as OperationInputs["package.score"]).target;
			if (typeof target !== "string" || target.length === 0 || target.length > 4_096) throw new PackageOperationError("target must be a non-empty string up to 4096 characters", 400);
			return (deps.scorer ? await deps.scorer.score(target) : await scoreTarget(target, deps.reg, packer)) as OperationOutputs[Name];
		}
		if (op === "setup.export") {
			const value = input as OperationInputs["setup.export"];
			if (typeof value.projectRoot !== "string" || value.projectRoot.length === 0 || value.projectRoot.length > 4_096) throw new PackageOperationError("projectRoot must be a non-empty string up to 4096 characters", 400);
			return await setup.export(value.projectRoot, { force: value.force === true, machineLocal: value.machineLocal === true }) as OperationOutputs[Name];
		}
		if (op === "setup.update" || op === "setup.plan" || op === "setup.apply") {
			const value = input as OperationInputs["setup.update"] | OperationInputs["setup.plan"] | OperationInputs["setup.apply"];
			if (typeof value.manifestPath !== "string" || value.manifestPath.length === 0 || value.manifestPath.length > 4_096) throw new PackageOperationError("manifestPath must be a non-empty string up to 4096 characters", 400);
			if (op === "setup.update") return await setup.update(value.manifestPath) as OperationOutputs[Name];
			if (op === "setup.apply") {
				const applyInput = input as OperationInputs["setup.apply"];
				const denied = authorize("setup.apply", applyInput.approved === true);
				if (denied) throw new PackageOperationError((await denied.json() as { error: string }).error, denied.status);
				return await setup.apply(value.manifestPath, { prune: applyInput.prune === true }) as OperationOutputs[Name];
			}
			return await setup.plan(value.manifestPath, { prune: (input as OperationInputs["setup.plan"]).prune === true }) as OperationOutputs[Name];
		}
		let path: string;
		let init: RequestInit = {};
		switch (op) {
			case "package.search": {
				const value = input as OperationInputs["package.search"];
				const params = new URLSearchParams({ q: value.query, limit: String(value.limit) });
				if (value.offline) params.set("offline", "1");
				path = `/search?${params}`;
				break;
			}
			case "package.info": path = `/info?name=${encodeURIComponent((input as OperationInputs["package.info"]).name)}`; break;
			case "package.installed": path = "/installed"; break;
			case "package.catalog": path = "/catalog"; break;
			case "package.updates": path = "/updates"; break;
			case "package.security.get": path = "/security"; break;
			case "package.security.set": path = "/security"; init = { method: "POST", body: JSON.stringify(input) }; break;
			case "package.install": path = "/install"; init = { method: "POST", body: JSON.stringify(input) }; break;
			case "package.install_service": path = "/install-service"; init = { method: "POST", body: JSON.stringify(input) }; break;
			case "package.remove": path = "/remove"; init = { method: "POST", body: JSON.stringify(input) }; break;
			case "package.update": path = "/update"; init = { method: "POST", body: JSON.stringify(input) }; break;
			default: throw new PackageOperationError(`unknown operation: ${String(op)}`, 404);
		}
		const response = await route(new Request(`http://packed.internal${path}`, init));
		const body = await response.json() as { error?: unknown };
		if (!response.ok) {
			throw new PackageOperationError(typeof body.error === "string" ? body.error : `operation failed with HTTP ${response.status}`, response.status);
		}
		return body as OperationOutputs[Name];
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const t0 = Date.now();
			if (!requireBearerToken(req, deps.token)) return errorResponse("missing or invalid bearer token", 401);
			const requestUrl = new URL(req.url);
			if (req.method === "GET" && requestUrl.pathname === "/api/v1/ops") return jsonResponse({ operations: OPERATION_NAMES });
			if (req.method === "POST" && requestUrl.pathname === "/api/v1/ops") {
				try {
					const body = await req.json() as { op?: unknown; input?: unknown };
					if (typeof body.op !== "string") return errorResponse("op is required", 400);
					const input = body.input ?? {};
					if (typeof input !== "object" || input === null || Array.isArray(input)) return errorResponse("input must be an object", 400);
					const result = await executeOperation(body.op as OperationName, input as OperationInputs[OperationName]);
					return jsonResponse({ result });
				} catch (error) {
					return errorResponse(error instanceof Error ? error.message : String(error), error instanceof PackageOperationError ? error.status : 400);
				}
			}
			// Cache successful GETs by URI (smart-proxy concern).
			if (req.method === "GET" && !["/health", "/updates", "/catalog", "/security"].includes(new URL(req.url).pathname)) {
				const hit = cache.get(req.url);
				if (hit) {
					log.debug("request", { path: new URL(req.url).pathname, cache: "hit", ms: Date.now() - t0 });
					return new Response(hit, { headers: { "content-type": "application/json", "x-cache": "hit" } });
				}
				const res = await route(req);
				if (res.status === 200) cache.set(req.url, await res.clone().text());
				log.debug("request", { path: new URL(req.url).pathname, status: res.status, cache: "miss", ms: Date.now() - t0 });
				return res;
			}
			const res = await route(req);
			log.debug("request", { path: new URL(req.url).pathname, status: res.status, ms: Date.now() - t0 });
			return res;
		},
	};
}
