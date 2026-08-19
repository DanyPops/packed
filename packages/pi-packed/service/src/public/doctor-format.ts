/**
 * doctor.run's report shape and its own human-readable formatter (the CLI's `packed doctor`
 * non-JSON path) -- kept as its own leaf module, imported back by adoption/doctor.ts rather than
 * defined there and re-exported, specifically so this file's only real (non-type) dependency is
 * its own formatDoctorReport/formatClaimant bodies. Every field type below crosses module
 * boundaries as `import type` only (fully erased at compile time), so a consumer needing just the
 * formatter -- e.g. pi-packed's own extension, rendering a Pi tool result -- never pulls in
 * runDoctor's own real runtime dependencies (subprocess-based extension smoke-testing, npm-tree
 * scanning, systemd status shell-outs, ...) just to format a report it already has.
 */
import type { DuplicateDependencyDiagnostic } from "../adoption/duplicate-dependency-doctor.ts";
import type { ModuleFreshnessDiagnostic } from "../adoption/module-freshness.ts";
import type { ServiceUnitDiagnostic } from "../adoption/service-doctor.ts";
import type { SmokeRegistrations } from "../adoption/smoke.ts";

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
