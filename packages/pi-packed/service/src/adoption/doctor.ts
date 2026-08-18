/**
 * doctor.ts — unions every currently-configured package's declared,
 * enabled extensions across BOTH global and project scope, smoke-tests
 * each in isolation, and reports any tool/command/shortcut/flag name
 * claimed by more than one. Pi's own extension loader only discovers this
 * kind of collision at actual startup, one package at a time; doctor
 * answers the same question proactively, before pi ever runs.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createNodeServiceInstallDeps } from "@danypops/vehicle-server/service";
import { listPackageResources, type PackageResources, resolveInstalledDir } from "../packages/resources.ts";
import { type DuplicateDependencyDiagnostic, findDuplicateDependencyVersions } from "./duplicate-dependency-doctor.ts";
import type { ModuleFreshnessDiagnostic } from "./module-freshness.ts";
import { checkServiceUnitPaths, type ServiceUnitDiagnostic } from "./service-doctor.ts";
import { runExtensionSmoke, type SmokeOptions, type SmokeRegistrations } from "./smoke.ts";

const REGISTRATION_KINDS = ["tools", "commands", "shortcuts", "flags"] as const;
type RegistrationKind = (typeof REGISTRATION_KINDS)[number];
const CONFLICT_KIND: Record<RegistrationKind, "tool" | "command" | "shortcut" | "flag"> = {
	tools: "tool",
	commands: "command",
	shortcuts: "shortcut",
	flags: "flag",
};

const MAX_EXTENSIONS_SCANNED = 50;

export interface DoctorClaim {
	name: string;
	source: string;
	scope: "global" | "project";
	extension: string;
}

export interface DoctorConflict {
	kind: "tool" | "command" | "shortcut" | "flag";
	name: string;
	claimants: DoctorClaim[];
}

export interface DoctorExtensionResult {
	name: string;
	source: string;
	scope: "global" | "project";
	extension: string;
	status: string;
	registrations: SmokeRegistrations;
	message?: string;
}

export interface DoctorReport {
	ok: boolean;
	conflicts: DoctorConflict[];
	extensions: DoctorExtensionResult[];
	scanned: number;
	truncated: boolean;
	/** A daemon-backed package's systemd --user unit referencing a path that no longer exists on disk -- see service-doctor.ts. Empty (not omitted) on a platform without systemd --user coverage. */
	serviceUnits: ServiceUnitDiagnostic[];
	/** Any @danypops/* package resolved to more than one distinct version anywhere in piHome's own npm tree -- see duplicate-dependency-doctor.ts's own doc comment for why this stays out of `ok`. */
	duplicateDependencies: DuplicateDependencyDiagnostic[];
	/**
	 * Whether THIS running process still holds a stale in-memory copy of one
	 * of its own runtime dependencies, loaded once at startup -- see
	 * module-freshness.ts. Only meaningful for a long-running daemon process
	 * (the one thing that can actually go stale); omitted entirely for a
	 * standalone `packed doctor` invocation (a fresh CLI process has nothing
	 * of its own to compare against). Populated by the daemon's own
	 * doctor.run route, never by runDoctor() itself.
	 */
	moduleFreshness?: ModuleFreshnessDiagnostic[];
}

interface ScanJob {
	group: PackageResources;
	dir: string;
	extension: string;
}

function collectJobs(piHome: string, projectRoot: string | undefined): ScanJob[] {
	const { global, project } = listPackageResources(piHome, projectRoot);
	const groups: { group: PackageResources; baseHome: string }[] = [
		...global.map((group) => ({ group, baseHome: piHome })),
		...(projectRoot ? project.map((group) => ({ group, baseHome: join(projectRoot, ".pi") })) : []),
	];
	const jobs: ScanJob[] = [];
	for (const { group, baseHome } of groups) {
		const dir = resolveInstalledDir(baseHome, group.source);
		if (!dir) continue;
		for (const item of group.extensions) {
			if (item.enabled) jobs.push({ group, dir, extension: item.path });
		}
	}
	return jobs;
}

export async function runDoctor(piHome: string, projectRoot?: string, options: SmokeOptions = {}): Promise<DoctorReport> {
	const jobs = collectJobs(piHome, projectRoot);
	const truncated = jobs.length > MAX_EXTENSIONS_SCANNED;
	const bounded = jobs.slice(0, MAX_EXTENSIONS_SCANNED);

	const claims = new Map<RegistrationKind, Map<string, DoctorClaim[]>>(REGISTRATION_KINDS.map((kind) => [kind, new Map()]));
	const extensions: DoctorExtensionResult[] = [];
	let anyNotOk = false;

	for (const job of bounded) {
		const result = await runExtensionSmoke(job.dir, join(job.dir, job.extension), options);
		if (result.status !== "ok") anyNotOk = true;
		extensions.push({
			name: job.group.name,
			source: job.group.source,
			scope: job.group.scope,
			extension: job.extension,
			status: result.status,
			registrations: result.registrations,
			...(result.message ? { message: result.message } : {}),
		});
		if (result.status !== "ok") continue;
		const claim: DoctorClaim = { name: job.group.name, source: job.group.source, scope: job.group.scope, extension: job.extension };
		for (const kind of REGISTRATION_KINDS) {
			const byName = claims.get(kind)!;
			for (const name of result.registrations[kind]) byName.set(name, [...(byName.get(name) ?? []), claim]);
		}
	}

	const conflicts: DoctorConflict[] = [];
	for (const kind of REGISTRATION_KINDS) {
		for (const [name, claimants] of claims.get(kind)!) {
			if (claimants.length > 1) conflicts.push({ kind: CONFLICT_KIND[kind], name, claimants });
		}
	}
	conflicts.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

	const serviceReport = checkServiceUnitPaths(piHome, projectRoot, {
		...createNodeServiceInstallDeps(),
		fileExists: existsSync,
		getMtimeMs: (path) => {
			try {
				return statSync(path).mtimeMs;
			} catch {
				return undefined;
			}
		},
	});

	return {
		ok: conflicts.length === 0 && !anyNotOk && serviceReport.ok,
		conflicts,
		extensions,
		scanned: bounded.length,
		truncated,
		serviceUnits: serviceReport.diagnostics,
		duplicateDependencies: findDuplicateDependencyVersions(piHome),
	};
}

function formatClaimant(claim: DoctorClaim): string {
	return `${claim.name} (${claim.source}) [${claim.scope}] ${claim.extension}`;
}

export function formatDoctorReport(report: DoctorReport, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	let out = `${report.ok ? "PASS" : "FAIL"} — ${report.scanned} extension(s) scanned, ${report.conflicts.length} conflict(s)\n`;
	for (const conflict of report.conflicts) {
		out += `\nCONFLICT ${conflict.kind} "${conflict.name}" claimed by:\n`;
		for (const claimant of conflict.claimants) out += `  - ${formatClaimant(claimant)}\n`;
	}
	for (const extension of report.extensions) {
		if (extension.status === "ok") continue;
		out += `\n${extension.status.toUpperCase()} ${formatClaimant({ name: extension.name, source: extension.source, scope: extension.scope, extension: extension.extension })}${extension.message ? `: ${extension.message}` : ""}\n`;
	}
	for (const diagnostic of report.serviceUnits) {
		out += `\n${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.package} (${diagnostic.unitName}.service): ${diagnostic.message}\n`;
	}
	for (const duplicate of report.duplicateDependencies) {
		const versions = duplicate.locations.map((location) => `${location.version} (${location.path})`).join(", ");
		out += `\nDUPLICATE_DEPENDENCY_VERSION ${duplicate.name}: ${versions}\n`;
	}
	for (const module of report.moduleFreshness ?? []) {
		if (!module.stale) continue;
		out += `\nSTALE_MODULE_CACHE ${module.name}: the daemon loaded ${module.loadedVersion ?? "an unknown version"} at startup, but ${module.currentVersion ?? "a different version"} is now on disk -- restart the daemon (systemctl --user restart pi-packed.service) to pick it up.\n`;
	}
	if (report.truncated) out += "\nOutput truncated: more enabled extensions exist than this run's bound.\n";
	return out;
}
