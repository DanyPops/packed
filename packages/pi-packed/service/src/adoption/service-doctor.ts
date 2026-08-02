/**
 * service-doctor.ts — checks every installed package's own daemon systemd
 * --user unit (if one is registered) for an ExecStart path that no longer
 * exists on disk. A unit is written once, at install/service-install time,
 * and never re-validated against the package's current on-disk layout --
 * confirmed live: a refactor that moved a package's own CLI entrypoint left
 * a real, already-registered unit pointing at a deleted file. The process
 * kept running only because it had been loaded into memory before the file
 * vanished; the next crash or reboot would have failed to restart at all,
 * silently, until someone happened to notice the daemon was down.
 *
 * Deliberately separate from doctor.ts's own DoctorReport (extension
 * registration-conflict scanning) -- a different subject (installed
 * services vs. loaded extensions), composed alongside it in runDoctor()
 * rather than folded into its shape.
 */
import { existsSync } from "node:fs";
import type { ServiceInstallDeps } from "@danypops/vehicle-server/service";
import { isServiceInstalled } from "@danypops/vehicle-server/service";
import { readInstalledPackagesAcrossScopes } from "../packages/installed.ts";
import { resolveDaemonServiceSpec } from "../daemon/daemon-service.ts";

export interface ServiceUnitDiagnostic {
	code: "SERVICE_EXEC_PATH_MISSING" | "SERVICE_EXEC_UNPARSEABLE";
	severity: "error" | "warning";
	package: string;
	unitName: string;
	message: string;
}

export interface ServiceDoctorReport {
	ok: boolean;
	diagnostics: ServiceUnitDiagnostic[];
	checked: number;
}

/**
 * Tokenizes ExecStart's own shell-quoted argument list -- matching
 * generateSystemdUnit's shellQuote, which wraps every argument in double
 * quotes and backslash-escapes only ", \, $, and ` inside them. Returns
 * undefined for a missing or unrecognizable ExecStart line rather than
 * guessing; the caller degrades that to a warning, never a false error.
 */
export function parseExecStartTokens(unitText: string): string[] | undefined {
	const line = unitText.split("\n").find((entry) => entry.trimStart().startsWith("ExecStart="));
	if (!line) return undefined;
	const raw = line.slice(line.indexOf("=") + 1);
	const tokens: string[] = [];
	const pattern = /"((?:[^"\\]|\\.)*)"/g;
	let match: RegExpExecArray | null = pattern.exec(raw);
	while (match !== null) {
		tokens.push(match[1]!.replace(/\\(["\\$`])/g, "$1"));
		match = pattern.exec(raw);
	}
	return tokens.length > 0 ? tokens : undefined;
}

/** A token worth existence-checking is one that's actually path-shaped -- a bare word like "serve" (a real subcommand argument, not a path) would otherwise resolve relative to this check's own cwd and produce a false SERVICE_EXEC_PATH_MISSING. */
function looksLikePath(token: string): boolean {
	return token.includes("/");
}

export interface ServiceDoctorDeps extends Pick<ServiceInstallDeps, "fileExists" | "readFile"> {
	platform?: string;
}

/**
 * For every installed package that resolves to a real Vehicle daemon spec
 * (same resolution daemon-service.ts's own install/restart commands use)
 * and currently has a systemd --user unit registered, reads that unit's
 * actual on-disk ExecStart (not a freshly recomputed "correct" one -- the
 * whole point is catching a real unit that has drifted from what's true
 * today) and flags any referenced path that no longer exists.
 *
 * Linux/systemd only, matching installUserService's own platform coverage
 * -- macOS/Windows unit shapes differ and aren't checked here yet.
 */
export function checkServiceUnitPaths(piHome: string, projectRoot: string | undefined, deps: ServiceDoctorDeps): ServiceDoctorReport {
	const diagnostics: ServiceUnitDiagnostic[] = [];
	const platform = deps.platform ?? process.platform;
	let checked = 0;
	if (platform !== "linux") return { ok: true, diagnostics, checked };

	for (const pkg of readInstalledPackagesAcrossScopes(piHome, projectRoot)) {
		const resolved = resolveDaemonServiceSpec(piHome, `npm:${pkg.name}`);
		if (!resolved.ok) continue;
		const spec = resolved.spec;
		if (!isServiceInstalled(spec, deps as ServiceInstallDeps)) continue;
		checked++;

		const unitText = deps.readFile(spec.descriptorPath);
		if (unitText === null) continue; // isServiceInstalled said yes but the read raced/failed -- transient, not a real finding.

		const tokens = parseExecStartTokens(unitText);
		if (!tokens) {
			diagnostics.push({
				code: "SERVICE_EXEC_UNPARSEABLE",
				severity: "warning",
				package: pkg.name,
				unitName: spec.name,
				message: `could not parse ExecStart in ${spec.descriptorPath}`,
			});
			continue;
		}

		for (const token of tokens) {
			if (!looksLikePath(token) || existsSync(token)) continue;
			diagnostics.push({
				code: "SERVICE_EXEC_PATH_MISSING",
				severity: "error",
				package: pkg.name,
				unitName: spec.name,
				message: `${spec.name}.service's ExecStart references a path that no longer exists: ${token} -- the service will fail to (re)start the next time it stops. Reinstall it (packed install-service npm:${pkg.name}) to regenerate.`,
			});
		}
	}

	return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"), diagnostics, checked };
}

export function formatServiceDoctorReport(report: ServiceDoctorReport, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	let out = `${report.ok ? "PASS" : "FAIL"} — ${report.checked} service unit(s) checked, ${report.diagnostics.length} issue(s)\n`;
	for (const diagnostic of report.diagnostics) {
		out += `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.package} (${diagnostic.unitName}.service): ${diagnostic.message}\n`;
	}
	return out;
}
