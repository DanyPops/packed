import { join } from "node:path";
import type { ServiceInstallDeps } from "@danypops/vehicle-server/service";
import { readInstalledPackagesAcrossScopes } from "../packages/installed.ts";
import { resolveDaemonServiceSpec } from "../daemon/daemon-service.ts";

export interface ServiceUnitDiagnostic {
	code: "SERVICE_EXEC_PATH_MISSING" | "SERVICE_NOT_RUNNING" | "SERVICE_STATUS_UNAVAILABLE" | "SERVICE_STALE_CODE";
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

export interface ServiceDoctorDeps extends ServiceInstallDeps {
	fileExists(path: string): boolean;
	/** Undefined (never throws) when the path doesn't exist or can't be stat'd. */
	getMtimeMs(path: string): number | undefined;
}

interface ArmadaStatus {
	vehicles?: Array<{ name?: string; executable?: string; nativeStatus?: string; ready?: boolean; nativePid?: number }>;
}

/** A boot/registration race can leave a process's own start time a few seconds behind its package.json's write; only a gap past this is treated as a genuinely stale running daemon. */
const STALE_CODE_GRACE_MS = 15_000;

/** Undefined (never throws) when `pid` isn't a running process this host can inspect, or `ps` isn't available. */
function processStartTimeMs(pid: number, deps: ServiceDoctorDeps): number | undefined {
	const result = deps.runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
	if (!result.ok) return undefined;
	const parsed = Date.parse(result.output.trim());
	return Number.isNaN(parsed) ? undefined : parsed;
}

export function checkServiceUnitPaths(
	piHome: string,
	projectRoot: string | undefined,
	deps: ServiceDoctorDeps,
): ServiceDoctorReport {
	const managedPackages = readInstalledPackagesAcrossScopes(piHome, projectRoot).flatMap((pkg) => {
		const resolved = resolveDaemonServiceSpec(piHome, `npm:${pkg.name}`);
		return resolved.ok ? [{ packageName: pkg.name, spec: resolved.spec }] : [];
	});
	if (managedPackages.length === 0) return { ok: true, diagnostics: [], checked: 0 };

	const statusResult = deps.runCommand(process.execPath, [deps.armadaCliPath, "status", "--json"]);
	if (!statusResult.ok) {
		return {
			ok: false,
			checked: 0,
			diagnostics: [
				{
					code: "SERVICE_STATUS_UNAVAILABLE",
					severity: "error",
					package: "@danypops/armada",
					unitName: "armada",
					message: `could not read Armada fleet status: ${statusResult.output}`,
				},
			],
		};
	}

	let status: ArmadaStatus;
	try {
		status = JSON.parse(statusResult.output) as ArmadaStatus;
	} catch {
		return {
			ok: false,
			checked: 0,
			diagnostics: [
				{
					code: "SERVICE_STATUS_UNAVAILABLE",
					severity: "error",
					package: "@danypops/armada",
					unitName: "armada",
					message: "Armada returned malformed fleet status",
				},
			],
		};
	}

	const vehicles = new Map((status.vehicles ?? []).flatMap((vehicle) => (vehicle.name ? [[vehicle.name, vehicle]] : [])));
	const diagnostics: ServiceUnitDiagnostic[] = [];
	let checked = 0;
	for (const managedPackage of managedPackages) {
		const vehicle = vehicles.get(managedPackage.spec.name);
		if (!vehicle) continue;
		checked++;
		const executable = vehicle.executable ?? managedPackage.spec.binPath;
		if (!deps.fileExists(executable)) {
			diagnostics.push({
				code: "SERVICE_EXEC_PATH_MISSING",
				severity: "error",
				package: managedPackage.packageName,
				unitName: managedPackage.spec.name,
				message: `${managedPackage.spec.name}'s Armada declaration references a path that no longer exists: ${executable}`,
			});
		}
		if (vehicle.nativeStatus !== undefined && vehicle.nativeStatus !== "running") {
			diagnostics.push({
				code: "SERVICE_NOT_RUNNING",
				severity: "error",
				package: managedPackage.packageName,
				unitName: managedPackage.spec.name,
				message: `${managedPackage.spec.name}'s Armada service is ${vehicle.nativeStatus}; start it through Armada before connecting`,
			});
			continue;
		}
		if (vehicle.nativePid !== undefined) {
			const packageJsonMtime = deps.getMtimeMs(join(piHome, "npm", "node_modules", managedPackage.packageName, "package.json"));
			const startedAt = processStartTimeMs(vehicle.nativePid, deps);
			if (packageJsonMtime !== undefined && startedAt !== undefined && startedAt < packageJsonMtime - STALE_CODE_GRACE_MS) {
				diagnostics.push({
					code: "SERVICE_STALE_CODE",
					severity: "warning",
					package: managedPackage.packageName,
					unitName: managedPackage.spec.name,
					message: `${managedPackage.spec.name}'s process (pid ${vehicle.nativePid}) started before its own package.json was last written -- it is very likely still running old in-memory code; restart it through Armada`,
				});
			}
		}
	}
	return { ok: diagnostics.length === 0, diagnostics, checked };
}

export function formatServiceDoctorReport(report: ServiceDoctorReport, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	let out = `${report.ok ? "PASS" : "FAIL"} — ${report.checked} managed service(s) checked, ${report.diagnostics.length} issue(s)\n`;
	for (const diagnostic of report.diagnostics) {
		out += `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.package} (${diagnostic.unitName}): ${diagnostic.message}\n`;
	}
	return out;
}
