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
import {
	type DoctorClaim,
	type DoctorConflict,
	type DoctorExtensionResult,
	type DoctorReport,
	formatDoctorReport,
} from "../public/doctor-format.ts";
import { findDuplicateDependencyVersions } from "./duplicate-dependency-doctor.ts";
import { checkServiceUnitPaths } from "./service-doctor.ts";
import { runExtensionSmoke, type SmokeOptions } from "./smoke.ts";

export { type DoctorClaim, type DoctorConflict, type DoctorExtensionResult, type DoctorReport, formatDoctorReport } from "../public/doctor-format.ts";

const REGISTRATION_KINDS = ["tools", "commands", "shortcuts", "flags"] as const;
type RegistrationKind = (typeof REGISTRATION_KINDS)[number];
const CONFLICT_KIND: Record<RegistrationKind, "tool" | "command" | "shortcut" | "flag"> = {
	tools: "tool",
	commands: "command",
	shortcuts: "shortcut",
	flags: "flag",
};

const MAX_EXTENSIONS_SCANNED = 50;

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


