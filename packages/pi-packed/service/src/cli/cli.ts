#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateSystemdUnit } from "@danypops/vehicle-server/service";
import { formatAdvisoryReport, resolveInstalledVersions, scanInstalledPackages } from "../adoption/advisories.ts";
import { checkPackage, formatCheckReport } from "../adoption/check.ts";
import { formatDoctorReport, runDoctor } from "../adoption/doctor.ts";
import { formatPackReport, NpmPackVerifier, type PackReport } from "../adoption/pack.ts";
import { type AdoptionReport, formatAdoptionReport, scoreTarget } from "../adoption/score.ts";
import type { PackageDaemonPort } from "../daemon/client.ts";
import type { OperationOutputs } from "../daemon/service.ts";
import { checkUpdates } from "../daemon/watcher.ts";
import { generateIndex, indexPath, readIndex } from "../index/build-index.ts";
import { syncCatalog } from "../packages/catalog.ts";
import { catalogList, dbPath, getSyncMeta, latestVersion, openDb, searchLocal } from "../packages/db.ts";
import { formatDeployVerification, verifyDeploy } from "../packages/deploy-verify.ts";
import { listManagedPackages } from "../daemon/daemon-service.ts";
import { defaultPiBin, NAME_RE } from "../packages/install.ts";
import { npmPackageName, readInstalledPackages, readInstalledPackagesAcrossScopes } from "../packages/installed.ts";
import type { Installer, Pkg, Registry, UpdateEntry } from "../packages/package.ts";
/**
 * cli.ts — the CLI entry point; drives the same shared ports (registry, installer, security) the HTTP service also drives.
 * cliRun is pure: ({code, out}) in, no I/O — the entry point prints.
 * Command table follows the go-tool/Cobra convention; flags may appear
 * anywhere (agents put them anywhere).
 */
import { buildSearchQuery, clampLimit } from "../packages/package.ts";
import {
	listPackageResources,
	type PackageResources,
	RESOURCE_FIELDS,
	type ResourceField,
	resolveToggleSettingsPath,
	toggleResource,
} from "../packages/resources.ts";
import { checkPiVersion, type PiVersionReport, runPiStatusInteractive, runPiUpdateSelf } from "../pi/pi-version.ts";
import {
	formatPublishReport,
	npmWebUrl,
	openBrowser,
	PublishManager,
	type PublishSetupReport,
	type PublishStatusReport,
	runInherited,
	runNpmLoginWeb,
} from "../publish/publish.ts";
import {
	assertPackagePermission,
	type MutationApproval,
	type PackageOperation,
	packageOperationClassification,
	type SecuritySettingsPort,
} from "../security/security.ts";
import { runSelfUpdate, type SelfUpdateReport } from "../self-update/self-update.ts";
import {
	bundledEcosystemManifestPath,
	formatSetupReport,
	type SetupApplyResult,
	type SetupExportReport,
	SetupManager,
	type SetupPlan,
	type SetupUpdateReport,
} from "../setup/setup.ts";
import { resolvePackedPaths } from "../shared/paths.ts";

/** A generated unit must never trust a bare "pi" resolving under systemd's
 * own restricted PATH just because it resolves in the shell that generated
 * the unit -- confirmed live: it doesn't. Always pin the real resolved
 * absolute path when one can be found; only omit the pin (bare name) when
 * resolution genuinely fails, which the running daemon will then also
 * fail at identically, not silently. */
function defaultPiBinForUnit(): string | undefined {
	const b = defaultPiBin();
	if (b !== "pi") return b; // explicit override already given
	return Bun.which("pi") ?? undefined;
}

import { MIRROR_PAGE_DELAY_MS, NPM_REGISTRY_BASE, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_PAGE_SIZE } from "../shared/constants.ts";
import { buildVersionReport, formatVersionReport, VERSION } from "../shared/version.ts";

const SOURCE_RE = /^(npm:[A-Za-z0-9@._/-]+|git:[A-Za-z0-9@:._/-]+|https:\/\/[A-Za-z0-9@:._/?=&%~-]+)$/;

const USAGE = `packed — package service for the Pi agent

usage:
  packed search <query> [--offline] [--json]   search npm (or the local mirror with --offline)
  packed info <name> [--json]                  package details
  packed updates [--project <path>] [--json]   updates per the local mirror; --project also checks that project's own .pi/settings.json pins
  packed update <source> [--approve] [--json]  update one configured package through Pi and reconcile its registered Vehicle
  packed update --self [--approve] [--json]    update Packed itself (npm-global installs only) and restart its supervised service
  packed mirror [--json]                       sync upstream into the local SQLite index
  packed installed [--json]                    installed pi packages
  packed catalog [--json]                      local package index (apt-cache stats)
  packed index build [--json]                  regenerate the local static adoption-scoring snapshot (npm-only, no GitHub)
  packed index status [--json]                 report the local static index's generatedAt and package count
  packed check [path] [--smoke] [--json]       diagnose a Pi package; smoke is isolated and opt-in
  packed doctor [--project <path>] [--json]    smoke-test every enabled extension (global + project scope) and report tool/command/shortcut/flag name collisions before pi has to
  packed verify-deploy <name> [--version <v>] [--json] diff a package's on-disk version across every known install location plus stale node_modules shadow copies
  packed pack [path] [--json]                  verify exact npm tarball contents without lifecycle scripts
  packed score [path|name] [--json]            report adoption-readiness evidence by dimension
  packed publish setup [path] [--force] [--json] generate an OIDC staged-publish workflow
  packed publish status [path] [--json]         validate staged-publish prerequisites and handoff
  packed setup export [path] [--force] [--machine-local] [--json] export immutable packages and scoped profiles
  packed setup update [manifest] [--json]       deliberately refresh immutable package resolutions
  packed setup plan [manifest] [--prune] [--json] show an additive or exact setup diff without mutation
  packed setup apply [manifest] [--prune] [--approve] [--json] apply an approved setup plan
  packed install <source> [--approve] [--json] pi install npm:|git:|https://… via daemon and reconcile any declared Vehicle
  packed install-service <source> --approve [--json] reconcile a package's declared Vehicle
  packed restart-service <source> --approve [--json] restart a package's already-registered persistent service standalone (packed update already does this automatically)
  packed reconcile-services --approve [--project <path>] [--json] sweep every installed package and self-heal its Vehicle registration (the daemon also runs this on its own interval and at startup)
  packed remove <name> [--approve] [--json]    remove by bare npm name via daemon
  packed security [always|never] [--approve] [--json] read or set mutation approval policy
  packed serve                                 run the long-running daemon
  packed service                               print a systemd user unit
  packed version                               print version
`;

export interface CliDeps {
	reg: Registry;
	inst: Installer;
	security: SecuritySettingsPort;
	daemon?: PackageDaemonPort;
	stateDir: string;
	dataDir?: string;
	piHome: string;
	execPath?: string; // bun binary (defaults to process.execPath)
	cliPath?: string; // this CLI's entry file (for the systemd unit)
	piBin?: string; // pi binary path to pin into the unit's Environment
	/** Reads the reachable daemon's own live-reported version, or undefined
	 * when none is reachable. Defaults to a real probe() over HTTP -- injectable
	 * so tests never depend on this machine's actual daemon state. */
	daemonVersionCheck?: () => Promise<string | undefined>;
	packer?: { verify(path: string): Promise<PackReport> };
	scorer?: { score(target: string): Promise<AdoptionReport> };
	publisher?: {
		setup(path: string, options?: { force?: boolean }): Promise<PublishSetupReport>;
		status(path: string): Promise<PublishStatusReport>;
	};
	setup?: {
		export(projectRoot: string, options?: { force?: boolean; machineLocal?: boolean }): Promise<SetupExportReport>;
		update(manifestPath: string): Promise<SetupUpdateReport>;
		plan(manifestPath: string, options?: { prune?: boolean }): Promise<SetupPlan>;
		apply(manifestPath: string, options?: { prune?: boolean }): Promise<SetupApplyResult>;
	};
	daemonService?: {
		install(source: string, approved?: boolean): Promise<{ output: string; spec?: { name: string; binPath: string } }>;
		restart(
			source: string,
			approved?: boolean,
		): Promise<{ output: string; restarted?: boolean; spec?: { name: string; binPath: string } }>;
		reconcileAll(approved?: boolean, projectRoot?: string): Promise<OperationOutputs["package.reconcile_services"]>;
	};
	piVersion?: { check(): Promise<PiVersionReport> };
	selfUpdater?: { run(): Promise<SelfUpdateReport> };
}

export interface CliResult {
	code: number;
	out: string;
}

interface Flags {
	json: boolean;
	limit: number;
	cached: boolean;
	offline: boolean;
	approved: boolean;
	smoke: boolean;
	force: boolean;
	prune: boolean;
	machineLocal: boolean;
	ecosystem: boolean;
	self: boolean;
	all: boolean;
	project?: string;
	version?: string;
	to?: string;
}

function parseFlags(rest: string[]): { flags: Flags; pos: string[] } {
	const flags: Flags = {
		json: false,
		limit: SEARCH_DEFAULT_LIMIT,
		cached: false,
		offline: false,
		approved: false,
		smoke: false,
		force: false,
		prune: false,
		machineLocal: false,
		ecosystem: false,
		self: false,
		all: false,
	};
	const pos: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") flags.json = true;
		else if (a === "--cached") flags.cached = true;
		else if (a === "--offline") flags.offline = true;
		else if (a === "--approve") flags.approved = true;
		else if (a === "--smoke") flags.smoke = true;
		else if (a === "--force") flags.force = true;
		else if (a === "--prune") flags.prune = true;
		else if (a === "--machine-local") flags.machineLocal = true;
		else if (a === "--ecosystem") flags.ecosystem = true;
		else if (a === "--self") flags.self = true;
		else if (a === "--all") flags.all = true;
		else if (a === "--limit" && i + 1 < rest.length) flags.limit = Number(rest[++i]) || SEARCH_DEFAULT_LIMIT;
		else if (a.startsWith("--limit=")) flags.limit = Number(a.slice(8)) || SEARCH_DEFAULT_LIMIT;
		else if (a === "--project" && i + 1 < rest.length) flags.project = rest[++i];
		else if (a.startsWith("--project=")) flags.project = a.slice(10);
		else if (a === "--version" && i + 1 < rest.length) flags.version = rest[++i];
		else if (a.startsWith("--version=")) flags.version = a.slice(10);
		else if (a === "--to" && i + 1 < rest.length) flags.to = rest[++i];
		else if (a.startsWith("--to=")) flags.to = a.slice(5);
		else pos.push(a);
	}
	return { flags, pos };
}

type Command = (rest: string[], d: CliDeps, flags: Flags, pos: string[]) => Promise<CliResult>;

const dataDirectory = (deps: CliDeps): string => deps.dataDir ?? deps.stateDir;
const ok = (out: string): CliResult => ({ code: 0, out });
const fail = (out: string, code = 1): CliResult => ({ code, out });
const usageErr = (out: string): CliResult => ({ code: 2, out });
const evidenceLabel = (pkg: Pick<Pkg, "packageEvidence">): string => {
	const evidence = pkg.packageEvidence;
	if (!evidence?.verified) return "[keyword candidate]";
	return `[verified ${evidence.shape}]`;
};

const PACKAGE_COMMAND_OPERATIONS: Record<string, PackageOperation | undefined> = {
	search: "search",
	info: "info",
	installed: "installed",
	catalog: "catalog",
	updates: "updates",
	check: "check",
	pack: "check",
	score: "info",
	update: "update",
	mirror: "mirror",
	install: "install",
	"install-service": "install_service",
	"restart-service": "restart_service",
	"reconcile-services": "reconcile_services",
	remove: "remove",
	pi: "pi.status",
	advisories: "advisories.scan",
	doctor: "doctor",
};

function formatResourcesList(result: { global: PackageResources[]; project: PackageResources[] }): string {
	let out = "";
	for (const [scope, groups] of [
		["global", result.global],
		["project", result.project],
	] as const) {
		if (groups.length === 0) continue;
		out += `${scope}:\n`;
		for (const group of groups) {
			out += `  ${group.name} (${group.source}):\n`;
			for (const field of RESOURCE_FIELDS) {
				for (const item of group[field]) out += `    ${item.enabled ? "on " : "off"}  ${field}/${item.path}\n`;
			}
		}
	}
	return out || "no package resources found\n";
}

function formatPiVersionReport(report: PiVersionReport): string {
	if (!report.current && !report.latest)
		return "pi version unknown (pi not found on PATH, and the latest-version check failed or was skipped)\n";
	let out = `pi ${report.current ?? "unknown"}`;
	if (report.latest) out += ` (latest ${report.latest})`;
	out += "\n";
	if (report.upToDate === true) out += "up to date\n";
	else if (report.upToDate === false) out += "update available -- run: pi update --self\n";
	if (report.packageName) out += `note: pi has moved to package "${report.packageName}"\n`;
	if (report.note) out += `${report.note}\n`;
	return out;
}

const commands: Record<string, { usage: string; run: Command }> = {
	setup: {
		usage:
			"packed setup export [path] [--force] [--machine-local] [--json] | packed setup update [manifest] [--json] | packed setup plan [manifest|--ecosystem] [--prune] [--json] | packed setup apply [manifest|--ecosystem] [--prune] [--approve] [--json]",
		async run(_rest, d, flags, pos) {
			const action = pos[0];
			if (action !== "export" && action !== "update" && action !== "plan" && action !== "apply")
				return usageErr(`usage: ${commands.setup!.usage}\n`);
			// --ecosystem resolves to the curated @danypops starter manifest bundled
			// in this same package -- no separate download, review, or trust surface
			// beyond the npm package itself. Only meaningful for plan/apply.
			const path = flags.ecosystem ? bundledEcosystemManifestPath() : resolve(pos[1] ?? ".");
			let report: SetupExportReport | SetupUpdateReport | SetupPlan | SetupApplyResult;
			if (d.daemon) {
				if (action === "export") report = await d.daemon.setupExport(path, flags.force, flags.machineLocal);
				else if (action === "update") report = await d.daemon.setupUpdate(path);
				else if (action === "plan") report = await d.daemon.setupPlan(path, flags.prune);
				else report = await d.daemon.setupApply(path, flags.approved, flags.prune);
			} else {
				const manager = d.setup ?? new SetupManager(d.reg, d.inst, d.piHome);
				if (action === "export") report = await manager.export(path, { force: flags.force, machineLocal: flags.machineLocal });
				else if (action === "update") report = await manager.update(path);
				else if (action === "plan") report = await manager.plan(path, { prune: flags.prune });
				else {
					assertPackagePermission(await d.security.security(), "setup.apply", flags.approved);
					report = await manager.apply(path, { prune: flags.prune });
				}
			}
			const output = formatSetupReport(report, flags.json);
			return report.ok ? ok(output) : fail(output);
		},
	},

	publish: {
		usage: "packed publish setup [path] [--force] [--json] | packed publish status [path] [--json] [--open-browser]",
		async run(_rest, d, flags, pos) {
			const action = pos[0];
			if (action !== "setup" && action !== "status") return usageErr(`usage: ${commands.publish!.usage}\n`);
			const path = resolve(pos[1] ?? ".");
			const manager = d.publisher ?? new PublishManager(d.reg);
			const report = action === "setup" ? await manager.setup(path, { force: flags.force }) : await manager.status(path);
			const output = formatPublishReport(report, flags.json);
			return ("ready" in report ? report.ready : report.ok) ? ok(output) : fail(output);
		},
	},

	pack: {
		usage: "packed pack [path] [--json]",
		async run(_rest, d, flags, pos) {
			const path = resolve(pos[0] ?? ".");
			const report = d.daemon ? await d.daemon.pack(path) : await (d.packer ?? new NpmPackVerifier()).verify(path);
			return report.ok ? ok(formatPackReport(report, flags.json)) : fail(formatPackReport(report, flags.json));
		},
	},

	score: {
		usage: "packed score [path|name] [--json]",
		async run(_rest, d, flags, pos) {
			const target = pos[0] ?? ".";
			const report = d.daemon
				? await d.daemon.score(target)
				: d.scorer
					? await d.scorer.score(target)
					: await scoreTarget(target, d.reg, d.packer);
			return ok(formatAdoptionReport(report, flags.json));
		},
	},

	check: {
		usage: "packed check [path] [--smoke] [--json]",
		async run(_rest, d, flags, pos) {
			const path = resolve(pos[0] ?? ".");
			const report = d.daemon ? await d.daemon.check(path, flags.smoke) : await checkPackage(path, { smoke: flags.smoke });
			const output = formatCheckReport(report, flags.json);
			return report.ok ? ok(output) : fail(output);
		},
	},

	doctor: {
		usage: "packed doctor [--project <path>] [--json]",
		async run(_rest, d, flags) {
			const report = d.daemon ? await d.daemon.doctor(flags.project) : await runDoctor(d.piHome, flags.project);
			const output = formatDoctorReport(report, flags.json);
			return report.ok ? ok(output) : fail(output);
		},
	},

	"verify-deploy": {
		usage: "packed verify-deploy <name> [--version <v>] [--json]  (diff a package's on-disk version across every known install location plus stale node_modules shadow copies)",
		async run(_rest, d, flags, pos) {
			const name = pos[0] ?? "";
			if (!NAME_RE.test(name)) return usageErr(`usage: ${commands["verify-deploy"]!.usage}\n`);
			const report = verifyDeploy(d.piHome, name, flags.version);
			const output = formatDeployVerification(report, flags.json);
			return report.ok ? ok(output) : fail(output);
		},
	},

	search: {
		usage: "packed search <query> [--offline] [--limit N] [--json]",
		async run(_rest, d, flags, pos) {
			const q = pos[0];
			if (!q) return usageErr(`usage: ${commands.search!.usage}\n`);
			const limit = clampLimit(flags.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
			// --offline: query the SQLite mirror only (apt-cache search analog)
			if (flags.offline) {
				let results: Pkg[];
				if (d.daemon) {
					results = (await d.daemon.search(q, limit, true)).results;
				} else {
					const db = openDb(dbPath(dataDirectory(d)));
					try {
						results = searchLocal(db, q, limit);
					} finally {
						db.close();
					}
				}
				if (flags.json) return ok(`${JSON.stringify({ query: q, total: results.length, results, offline: true })}\n`);
				if (results.length === 0) return ok(`no mirrored packages match "${q}" (run: packed mirror)\n`);
				let out = `${results.length} mirrored package(s):\n\n`;
				for (const p of results) out += `  ${p.name}@${p.version}  ${evidenceLabel(p)}\n    ${p.description ?? ""}\n`;
				return ok(out);
			}
			const { results, total } = await d.reg.search(buildSearchQuery(q), limit);
			if (flags.json) return ok(`${JSON.stringify({ query: q, total, results })}\n`);
			if (results.length === 0) return ok(`no pi packages found for "${q}"\n`);
			let out = `${total} package(s) (showing ${results.length}):\n\n`;
			for (const p of results) out += `  ${p.name}@${p.version}  ${evidenceLabel(p)}\n    ${p.description ?? ""}\n`;
			return ok(out);
		},
	},

	mirror: {
		usage: "packed mirror [--json]  (sync the upstream registry into the local SQLite index — the apt update analog)",
		async run(_rest, d, flags) {
			const n = d.daemon ? await d.daemon.mirror() : await syncCatalog(d.reg, dataDirectory(d));
			if (flags.json) return ok(`${JSON.stringify({ synced: n })}\n`);
			return ok(`mirrored ${n} packages into the local index\n`);
		},
	},

	index: {
		usage:
			"packed index build [--json] | packed index status [--json]  (local static adoption-scoring snapshot, npm-only -- createrepo/dpkg-scanpackages analog)",
		async run(_rest, d, flags, pos) {
			const action = pos[0];
			if (action !== "build" && action !== "status") return usageErr(`usage: ${commands.index!.usage}\n`);
			if (action === "build") {
				const index = d.daemon ? await d.daemon.indexBuild() : await generateIndex(d.reg, dataDirectory(d), indexPath(dataDirectory(d)));
				if (flags.json) return ok(`${JSON.stringify(index)}\n`);
				return ok(
					`generated a static index of ${index.packages.length} packages (generatedAt ${index.generatedAt})${index.truncated ? " -- truncated, the local catalog holds more entries than this run's bound" : ""}\n`,
				);
			}
			const status = d.daemon ? await d.daemon.index() : readIndex(indexPath(dataDirectory(d)));
			if (flags.json) return ok(`${JSON.stringify(status ?? null)}\n`);
			if (!status) return ok("no local index generated yet -- run packed index build\n");
			return ok(
				`local index: ${status.packages.length} packages, generated ${status.generatedAt}${status.truncated ? " (truncated)" : ""}\n`,
			);
		},
	},

	info: {
		usage: "packed info <name> [--json]",
		async run(_rest, d, flags, pos) {
			const name = pos[0];
			if (!name) return usageErr(`usage: ${commands.info!.usage}\n`);
			const info = await d.reg.info(name);
			if (flags.json) return ok(`${JSON.stringify(info)}\n`);
			let out = `${info.name}@${info.version}\n${info.description ?? ""}\n`;
			if (info.repository) out += `repo: ${info.repository}\n`;
			if (info.pi) out += `provides: ${Object.keys(info.pi).join(", ")}\n`;
			if (info.packageEvidence)
				out += `shape: ${info.packageEvidence.shape}${info.packageEvidence.verified ? " (tarball verified)" : " (metadata only)"}\n`;
			if (info.publication?.provenanceUrl) out += `provenance: ${info.publication.provenanceUrl}\n`;
			out += `trusted publisher: ${info.publication?.trustedPublisher ?? "unknown"}\n`;
			return ok(out);
		},
	},

	updates: {
		usage: "packed updates [--project <path>] [--json]  (from the local mirror — run `packed mirror` first)",
		async run(_rest, d, flags) {
			let updates: UpdateEntry[];
			if (flags.project) {
				updates = d.daemon
					? await d.daemon.updatesForProject(flags.project)
					: await (async () => {
							const db = openDb(dbPath(dataDirectory(d)));
							try {
								return checkUpdates((name) => latestVersion(db, name), readInstalledPackagesAcrossScopes(d.piHome, flags.project));
							} finally {
								db.close();
							}
						})();
			} else if (d.daemon) {
				updates = await d.daemon.updates();
			} else {
				const db = openDb(dbPath(dataDirectory(d)));
				try {
					updates = checkUpdates((name) => latestVersion(db, name), readInstalledPackages(d.piHome));
				} finally {
					db.close();
				}
			}
			if (flags.json) {
				return ok(`${JSON.stringify({ checkedAt: new Date().toISOString(), updates })}\n`);
			}
			if (updates.length === 0) return ok("all pi packages up to date (per the local mirror)\n");
			let out = `${updates.length} update(s) available:\n\n`;
			for (const u of updates) out += `  ${u.name}${u.scope ? ` [${u.scope}]` : ""}  ${u.installed} → ${u.latest}\n`;
			return ok(`${out}\nrun: pi update --extensions\n`);
		},
	},

	pi: {
		usage: "packed pi status [--json]",
		async run(_rest, d, flags, pos) {
			if (pos[0] !== "status") return usageErr(`usage: ${commands.pi!.usage}\n`);
			const report = d.daemon ? await d.daemon.piStatus() : await (d.piVersion ?? { check: checkPiVersion }).check();
			if (flags.json) return ok(`${JSON.stringify(report)}\n`);
			return ok(formatPiVersionReport(report));
		},
	},

	advisories: {
		usage:
			"packed advisories [name] [--json]  (no lockfile required; scans installed npm-sourced Pi packages against npm's bulk advisory endpoint)",
		async run(_rest, d, flags, pos) {
			const name = pos[0];
			const report = d.daemon ? await d.daemon.advisoriesScan(name) : await scanInstalledPackages(resolveInstalledVersions(d.piHome, name));
			return ok(formatAdvisoryReport(report, flags.json));
		},
	},

	resources: {
		usage:
			"packed resources list [--project <path>] [--json] | packed resources toggle <source> <field> <path> <on|off> [--project <path>] [--approve] [--json]",
		async run(_rest, d, flags, pos) {
			const action = pos[0];
			if (action === "list") {
				const result = d.daemon ? await d.daemon.resourcesList(flags.project) : listPackageResources(d.piHome, flags.project);
				if (flags.json) return ok(`${JSON.stringify(result)}\n`);
				return ok(formatResourcesList(result));
			}
			if (action === "toggle") {
				const [source, field, path, state] = [pos[1] ?? "", pos[2] ?? "", pos[3] ?? "", pos[4] ?? ""];
				if (!source || !RESOURCE_FIELDS.includes(field as ResourceField) || !path || (state !== "on" && state !== "off")) {
					return usageErr(`usage: ${commands.resources!.usage}\n`);
				}
				const enabled = state === "on";
				try {
					let output: string;
					if (d.daemon) {
						output = await d.daemon.resourcesToggle(source, field as ResourceField, path, enabled, flags.project, flags.approved);
					} else {
						assertPackagePermission(await d.security.security(), "resources.toggle", flags.approved);
						const settingsPath = resolveToggleSettingsPath(d.piHome, flags.project);
						if (flags.project && !existsSync(settingsPath)) throw new Error("no project settings file to toggle");
						const result = await toggleResource({ settingsPath, source, field: field as ResourceField, path, enabled });
						if (!result.ok) throw new Error(result.error ?? "toggle failed");
						output = `${enabled ? "enabled" : "disabled"} ${path}`;
					}
					return flags.json ? ok(`${JSON.stringify({ ok: true, source, field, path, enabled, output })}\n`) : ok(`${output}\n`);
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e);
					return flags.json ? fail(`${JSON.stringify({ ok: false, source, field, path, enabled, error })}\n`) : fail(`${error}\n`);
				}
			}
			return usageErr(`usage: ${commands.resources!.usage}\n`);
		},
	},

	installed: {
		usage: "packed installed [--json]",
		async run(_rest, d, flags) {
			const installed = d.daemon ? await d.daemon.installed() : listManagedPackages(d.piHome);
			if (flags.json) return ok(`${JSON.stringify(installed)}\n`);
			return ok(
				installed
					.map((p) => `  ${p.name}@${p.pinned ?? p.installed ?? "?"}${p.kind === "daemon-dependency" ? " [daemon-dependency]" : ""}\n`)
					.join(""),
			);
		},
	},

	catalog: {
		usage: "packed catalog [--json]",
		async run(_rest, d, flags) {
			let snapshot: { fetchedAt?: string; sha256?: string; packages: Pkg[] };
			if (d.daemon) {
				snapshot = await d.daemon.catalog();
			} else {
				const db = openDb(dbPath(dataDirectory(d)));
				try {
					const meta = getSyncMeta(db);
					snapshot = { fetchedAt: meta?.fetchedAt, sha256: meta?.sha256, packages: catalogList(db) };
				} finally {
					db.close();
				}
			}
			if (flags.json) return ok(`${JSON.stringify(snapshot)}\n`);
			let out = `${snapshot.packages.length} packages in the local index`;
			if (snapshot.fetchedAt && snapshot.sha256) out += ` (synced ${snapshot.fetchedAt}, sha256:${snapshot.sha256.slice(0, 12)}…)`;
			out += "\n\n";
			for (const p of snapshot.packages.slice(0, 50)) out += `  ${p.name}@${p.version}  ${evidenceLabel(p)}\n`;
			return ok(out);
		},
	},

	install: {
		usage: "packed install npm:<pkg>[@ver] | git:<host>/<owner>/<repo>[@ref] | https://… [--json]",
		async run(_rest, d, flags, pos) {
			const source = pos[0] ?? "";
			if (!SOURCE_RE.test(source)) return usageErr(`usage: ${commands.install!.usage}\n`);
			try {
				const output = await d.inst.install(source, { approved: flags.approved });
				if (flags.json) return ok(`${JSON.stringify({ ok: true, source, output })}\n`);
				return ok(`${output}\n`);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				return flags.json ? fail(`${JSON.stringify({ ok: false, source, error })}\n`) : fail(`${error}\n`);
			}
		},
	},

	"install-service": {
		usage:
			"packed install-service npm:<pkg>[@ver] --approve [--json]  (registers the package's own daemon as a persistent login/boot service; see its packed.daemonService manifest)",
		async run(_rest, d, flags, pos) {
			const source = pos[0] ?? "";
			if (!SOURCE_RE.test(source)) return usageErr(`usage: ${commands["install-service"]!.usage}\n`);
			if (!d.daemonService) return fail("install-service requires a running packed daemon\n");
			try {
				const { output, spec } = await d.daemonService.install(source, flags.approved);
				return flags.json ? ok(`${JSON.stringify({ ok: true, source, output, spec })}\n`) : ok(`${output}\n`);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				return flags.json ? fail(`${JSON.stringify({ ok: false, source, error })}\n`) : fail(`${error}\n`);
			}
		},
	},

	"restart-service": {
		usage: "packed restart-service npm:<pkg>[@ver] --approve [--json]  (restarts a package's already-registered persistent service)",
		async run(_rest, d, flags, pos) {
			const source = pos[0] ?? "";
			if (!SOURCE_RE.test(source)) return usageErr(`usage: ${commands["restart-service"]!.usage}\n`);
			if (!d.daemonService) return fail("restart-service requires a running packed daemon\n");
			try {
				const { output, restarted, spec } = await d.daemonService.restart(source, flags.approved);
				return flags.json ? ok(`${JSON.stringify({ ok: true, source, output, restarted, spec })}\n`) : ok(`${output}\n`);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				return flags.json ? fail(`${JSON.stringify({ ok: false, source, error })}\n`) : fail(`${error}\n`);
			}
		},
	},

	"reconcile-services": {
		usage:
			"packed reconcile-services --approve [--project <path>] [--json]  (sweeps every installed package and self-heals its Vehicle registration through Armada)",
		async run(_rest, d, flags) {
			if (!d.daemonService) return fail("reconcile-services requires a running packed daemon\n");
			try {
				const result = await d.daemonService.reconcileAll(flags.approved, flags.project);
				return flags.json ? ok(`${JSON.stringify(result)}\n`) : ok(`${result.output}\n`);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				return flags.json ? fail(`${JSON.stringify({ ok: false, error })}\n`) : fail(`${error}\n`);
			}
		},
	},

	security: {
		usage: "packed security [always|never] [--json]",
		async run(_rest, d, flags, pos) {
			const requested = pos[0];
			if (requested !== undefined && requested !== "always" && requested !== "never") {
				return usageErr(`usage: ${commands.security!.usage}\n`);
			}
			const settings = requested
				? await d.security.setMutationApproval(requested as MutationApproval, { approved: flags.approved })
				: await d.security.security();
			return flags.json ? ok(`${JSON.stringify(settings)}\n`) : ok(`package mutation approval: ${settings.mutationApproval}\n`);
		},
	},

	update: {
		usage:
			"packed update <configured-source> [--to <new-source>] [--approve] [--json] | packed update --self [--approve] [--json] | packed update --all [--approve] [--json]  (--to replaces an exact pin end to end -- see verify-deploy/doctor for post-replace checks; --all batches every currently-stale package, re-resolving once instead of once per package)",
		async run(_rest, d, flags, pos) {
			if (flags.all) {
				if (!d.daemon) return fail("update --all requires a running packed daemon\n");
				try {
					const result = await d.daemon.updateAll(undefined, flags.approved);
					if (flags.json) return ok(`${JSON.stringify(result)}\n`);
					if (result.results.length === 0) return ok("all pi packages up to date (per the local mirror)\n");
					let out = `${result.output}\n\n`;
					for (const item of result.results) {
						const transition = item.previousVersion && item.currentVersion ? ` (${item.previousVersion} → ${item.currentVersion})` : "";
						const status = item.ok ? (item.alreadyUpToDate ? "already up to date" : `updated${transition}`) : `FAILED: ${item.output}`;
						out += `  ${item.source}  ${status}\n`;
					}
					if (result.reresolveError) out += `\nWARNING: final dependency re-resolution failed: ${result.reresolveError}\n`;
					const anyChanged = result.results.some((item) => item.ok && !item.alreadyUpToDate);
					if (anyChanged) out += "\nReload Pi with /reload to activate the updated packages.\n";
					return result.ok ? ok(out) : fail(out);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return flags.json ? fail(`${JSON.stringify({ ok: false, error: message })}\n`) : fail(`${message}\n`);
				}
			}
			if (flags.self) {
				try {
					assertPackagePermission(await d.security.security(), "update.self", flags.approved);
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e);
					return flags.json ? fail(`${JSON.stringify({ ok: false, error })}\n`) : fail(`${error}\n`);
				}
				if (!d.selfUpdater) return fail("update --self requires a running packed daemon\n");
				const report = await d.selfUpdater.run();
				if (flags.json) return report.ok ? ok(`${JSON.stringify(report)}\n`) : fail(`${JSON.stringify(report)}\n`);
				const transition =
					report.latestVersion && report.previousVersion !== report.latestVersion
						? ` (${report.previousVersion} → ${report.latestVersion})`
						: "";
				return report.ok ? ok(`${report.message}${transition}\n`) : fail(`${report.message}\n`);
			}
			const source = pos[0] ?? "";
			if (!SOURCE_RE.test(source)) return usageErr(`usage: ${commands.update!.usage}\n`);
			if (flags.to !== undefined && !SOURCE_RE.test(flags.to)) return usageErr(`usage: ${commands.update!.usage}\n`);
			try {
				const outcome = await d.inst.update(source, { approved: flags.approved, target: flags.to });
				if (outcome.alreadyUpToDate) {
					if (flags.json) return ok(`${JSON.stringify({ ok: true, source, ...outcome })}\n`);
					const version = outcome.currentVersion ?? outcome.previousVersion;
					const reason = outcome.pinned
						? `is pinned to ${version ?? "an exact version"} — pi update intentionally leaves pinned packages unchanged; run \`packed update ${source} --to npm:${npmPackageName(source) ?? source}@<version>\` to move off the pin`
						: `is already up to date${version ? ` at ${version}` : ""}`;
					const outOfRangeNote = outcome.outOfRangeUpdateAvailable
						? ` (a newer version, ${outcome.outOfRangeUpdateAvailable}, exists outside the declared range -- widen it to update)`
						: "";
					return ok(`${source} ${reason}${outOfRangeNote}\n`);
				}
				if (flags.json) return ok(`${JSON.stringify({ ok: true, source, ...outcome })}\n`);
				const transition =
					outcome.previousVersion && outcome.currentVersion ? ` (${outcome.previousVersion} → ${outcome.currentVersion})` : "";
				const replacedNote = outcome.replaced ? ` (replaced ${outcome.before?.source ?? source} with ${outcome.after?.source ?? ""})` : "";
				return ok(`${outcome.output}${transition}${replacedNote}\nReload Pi with /reload to activate the updated package.\n`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return flags.json
					? fail(`${JSON.stringify({ ok: false, source, error: message, reloadRequired: false })}\n`)
					: fail(`${message}\n`);
			}
		},
	},

	remove: {
		usage: "packed remove <name> [--approve] [--json]  (bare npm name, e.g. pi-lsp or @scope/pkg)",
		async run(_rest, d, flags, pos) {
			const name = pos[0] ?? "";
			if (!NAME_RE.test(name)) return usageErr(`usage: ${commands.remove!.usage}\n`);
			try {
				const output = await d.inst.remove(`npm:${name}`, { approved: flags.approved });
				return flags.json ? ok(`${JSON.stringify({ ok: true, name, output })}\n`) : ok(`${output}\n`);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				return flags.json ? fail(`${JSON.stringify({ ok: false, name, error })}\n`) : fail(`${error}\n`);
			}
		},
	},

	service: {
		usage: "packed service  (print a systemd user unit to stdout)",
		async run(_rest, d) {
			const execPath = d.execPath ?? process.execPath;
			const cliPath = d.cliPath ?? new URL("./cli.ts", import.meta.url).pathname;
			return ok(renderUnit(execPath, cliPath, d.piBin ?? defaultPiBinForUnit()));
		},
	},

	version: {
		usage: "packed version [--json]",
		async run(rest, d) {
			const json = rest.includes("--json");
			const daemonVersion = d.daemonVersionCheck
				? await d.daemonVersionCheck()
				: await (async () => {
						const { probe } = await import("../daemon/client.ts");
						return (await probe())?.version;
					})();
			const report = buildVersionReport(VERSION, daemonVersion);
			return ok(json ? `${JSON.stringify(report)}\n` : formatVersionReport(report));
		},
	},
};

/** Renders the legacy diagnostic unit without installing it; Armada owns service-manager mutation. */
export function renderUnit(execPath: string, cliPath: string, piBin?: string): string {
	// systemd does not read shell rc files: PI_BIN must be explicit so the
	// daemon's install/remove execs can find the pi binary.
	const env: Record<string, string> = { PI_PACKED_IDLE_SECS: "0" };
	if (piBin) env.PI_BIN = piBin;
	return generateSystemdUnit({
		name: "pi-packed",
		displayName: "pi-packed package service (Pi agent)",
		version: VERSION,
		binPath: execPath,
		args: [cliPath, "serve"],
		env,
		handlePath: resolvePackedPaths().handle,
		// Packed's own client (connectPackageDaemon) never auto-spawns -- "start packed.service"
		// or this unit's own systemd supervision is its only recovery path.
		restartOnFailure: true,
		restartSec: 2,
		noNewPrivileges: true,
	});
}

export async function cliRun(args: string[], d: CliDeps): Promise<CliResult> {
	const [name, ...rest] = args;
	if (!name) return usageErr(USAGE);
	if (name === "help" || name === "--help" || name === "-h") return { code: 0, out: USAGE };
	const cmd = commands[name];
	if (!cmd) return usageErr(`unknown command "${name}"\n${USAGE}`);
	const { flags, pos } = parseFlags(rest);
	try {
		const validMutationInput =
			name === "install" || name === "update" || name === "install-service" || name === "restart-service"
				? SOURCE_RE.test(pos[0] ?? "")
				: name === "remove"
					? NAME_RE.test(pos[0] ?? "")
					: name === "security"
						? pos[0] === undefined || pos[0] === "always" || pos[0] === "never"
						: true;
		const operation = name === "security" ? (pos[0] === undefined ? "security.read" : "security.write") : PACKAGE_COMMAND_OPERATIONS[name];
		if (operation && validMutationInput) {
			const classification = packageOperationClassification(operation);
			if (classification === "code-execution" || classification === "settings-mutation" || classification === "security-mutation") {
				assertPackagePermission(await d.security.security(), operation, flags.approved);
			}
		}
		return await cmd.run(rest, d, flags, pos);
	} catch (e) {
		return fail(`${name} failed: ${e instanceof Error ? e.message : e}\n`);
	}
}

// Entry point (bun src/cli/cli.ts …). `serve` is dispatched before any proxying
// so the daemon always talks directly to npm.
/** Bounded, TTY-only y/n prompt -- never invoked non-interactively, never
 * assumes an answer. Lives outside cliRun so the pure command table never
 * touches real stdin. */
function readLine(): Promise<string> {
	return new Promise((resolveLine) => {
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (data: Buffer) => {
			process.stdin.pause();
			resolveLine(data.toString("utf8"));
		});
	});
}

async function confirmInteractive(question: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	process.stdout.write(`${question} [y/N] `);
	return (await readLine()).trim().toLowerCase().startsWith("y");
}

async function waitForEnter(prompt: string): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	process.stdout.write(prompt);
	await readLine();
}

/** Smooth, opt-in handoff to npm's own web UI for both login and trust --
 * never publishing, never touching a token, never running an npm CLI
 * subcommand we'd have to keep in sync with npm's own flags, and never run
 * unless a human is actually watching a real terminal and says yes to each
 * step. Headless by default: prints the URL and waits for Enter, exactly
 * like npm's own `--no-browser` config -- nothing here ever launches a
 * real browser unless the human passed --open-browser, since this runs
 * unattended just as often as it runs on someone's own desktop. */
async function runPublishInteractive(path: string, reg: Registry, openBrowserAuto: boolean): Promise<boolean> {
	const manager = new PublishManager(reg);
	let report = await manager.status(path);
	if (!report.checks.loggedIn) {
		if (await confirmInteractive("Not logged in to npm on this machine. Run npm login --auth-type=web now?")) {
			const result = await runNpmLoginWeb(openBrowserAuto);
			if (result.ok) report = await manager.status(path);
		}
	}
	if (report.checks.trustedPublisher !== "verified" && report.packageName) {
		const accessUrl = npmWebUrl(report.packageName);
		if (await confirmInteractive(`Configure npm Trusted Publisher for ${report.packageName} now?`)) {
			if (openBrowserAuto) await openBrowser(accessUrl);
			await waitForEnter(
				`${openBrowserAuto ? "Opened (or open manually)" : "Open this URL"}: ${accessUrl}\nConfigure "Trusted publisher" for the GitHub Actions workflow there, then press Enter to continue... `,
			);
			report = await manager.status(path);
		}
	}
	process.stdout.write(formatPublishReport(report, false));
	return report.ready;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "serve") {
		const { serveMain } = await import("../daemon/daemon.ts");
		serveMain();
	} else {
		const { migrateLegacyPackedState, resolvePackedPaths } = await import("../shared/paths.ts");
		const { dirname } = await import("node:path");
		const { defaultPiHome } = await import("../packages/installed.ts");
		const { connectPackageDaemon, DaemonBackedSecurity, DaemonBackedInstaller, DaemonBackedDaemonServiceInstaller, resolveRegistry } =
			await import("../daemon/client.ts");
		const paths = resolvePackedPaths();
		migrateLegacyPackedState(paths);
		const dir = paths.stateDirectory;
		// mirror talks to UPSTREAM, not the daemon cache — apt update semantics.
		const reg =
			args[0] === "mirror"
				? new (await import("../registry/registry.ts")).HttpRegistry(NPM_REGISTRY_BASE, SEARCH_PAGE_SIZE, MIRROR_PAGE_DELAY_MS)
				: await resolveRegistry(paths, NPM_REGISTRY_BASE);
		const daemon = await connectPackageDaemon(paths).catch(() => undefined);
		const { code, out } = await cliRun(args, {
			reg,
			daemon,
			inst: new DaemonBackedInstaller(paths),
			daemonService: new DaemonBackedDaemonServiceInstaller(paths),
			security: new DaemonBackedSecurity(paths),
			stateDir: dir,
			dataDir: dirname(paths.database),
			piHome: defaultPiHome(),
			selfUpdater: {
				run: () =>
					runSelfUpdate({
						registry: reg,
						isServiceInstalled: () => existsSync(paths.serviceDescriptor),
						restartService:
							process.platform === "linux" ? () => runInherited(["systemctl", "--user", "restart", "pi-packed.service"]) : undefined,
					}),
			},
		});
		const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.includes("--json");
		if (interactive && args[0] === "publish" && args[1] === "status") {
			const ready = await runPublishInteractive(resolve(args[2] ?? "."), reg, args.includes("--open-browser"));
			process.exit(ready ? 0 : 1);
		}
		if (interactive && args[0] === "pi" && args[1] === "status") {
			const report = await runPiStatusInteractive({
				check: () => (daemon ? daemon.piStatus() : checkPiVersion()),
				confirm: confirmInteractive,
				runUpdate: runPiUpdateSelf,
			});
			process.stdout.write(formatPiVersionReport(report));
			process.exit(report.upToDate === false ? 1 : 0);
		}
		process.stdout.write(out);
		process.exit(code);
	}
}
