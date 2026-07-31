import { readFileSync } from "node:fs";

function packageVersion(): string {
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as unknown;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new Error("packed package manifest must be an object");
	}
	const version = (manifest as Record<string, unknown>)["version"];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("packed package manifest has an invalid version");
	}
	return version;
}

/** Runtime package version; package.json is the single release source of truth. */
export const VERSION = packageVersion();

export interface VersionReport {
	installed: string;
	/** Undefined when no daemon is reachable at all -- not a drift concern. */
	daemon?: { version: string; stale: boolean };
}

export function buildVersionReport(installed: string, daemonVersion: string | undefined): VersionReport {
	return {
		installed,
		...(daemonVersion !== undefined ? { daemon: { version: daemonVersion, stale: daemonVersion !== installed } } : {}),
	};
}

/** A running daemon holding stale in-memory code is otherwise invisible --
 * it stays reachable and correctly answers every RPC, just with whatever
 * logic was current when it started. Confirmed live: an 11-hour-old daemon
 * kept flagging false "update available" rows from a same-day comparison
 * fix it predated. */
export function formatVersionReport(report: VersionReport): string {
	const lines = [`packed ${report.installed} (installed)`];
	if (report.daemon) {
		lines.push(
			report.daemon.stale
				? `daemon running v${report.daemon.version} -- STALE, restart required to pick up v${report.installed} (e.g. systemctl --user restart pi-packed.service)`
				: `daemon running v${report.daemon.version} -- up to date`,
		);
	}
	return `${lines.join("\n")}\n`;
}
