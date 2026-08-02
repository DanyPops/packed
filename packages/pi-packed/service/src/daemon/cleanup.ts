/**
 * cleanup.ts — the optional pi.cleanup convention: a package may declare a
 * bounded array of its own relative paths that packed remove reports and
 * removes explicitly, before delegating the actual uninstall to pi remove.
 * Addresses a real, documented gap: pi remove fires no uninstall hook
 * (pi-crew's own README documents this directly, as a known limitation
 * with a manual cleanup workaround). A package that declares nothing here
 * changes packed remove's behavior not at all -- readCleanupManifest
 * returns [] for every package that never opts in, and runCleanup is a
 * no-op on an empty declaration.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isContainedFile } from "../adoption/check.ts";

export const MAX_CLEANUP_ENTRIES = 50;
export const MAX_CLEANUP_PATH_BYTES = 512;

export type CleanupStatus = "removed" | "missing" | "escaped" | "failed";

export interface CleanupTarget {
	/** exactly as declared in the package's own pi.cleanup array */
	declared: string;
	status: CleanupStatus;
}

/** Reads and bounds a package's own optional pi.cleanup declaration.
 * Missing, malformed, non-array, or absent entirely all resolve to [] --
 * the caller never needs its own separate "did this package opt in?"
 * check. */
export function readCleanupManifest(installedDir: string): string[] {
	try {
		const pkg = JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8")) as { pi?: { cleanup?: unknown } };
		const declared = pkg.pi?.cleanup;
		if (!Array.isArray(declared)) return [];
		return declared
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_CLEANUP_PATH_BYTES)
			.slice(0, MAX_CLEANUP_ENTRIES);
	} catch {
		return [];
	}
}

/**
 * Removes every path a package declares via pi.cleanup, reporting every
 * declared entry's outcome -- never silently, and never partially: a
 * caller always gets one CleanupTarget back per declared string. Fails
 * closed (status "escaped", never deleted) on any path escaping the
 * package's own installed directory, matching check.ts's own
 * symlink/resource-escape discipline exactly: a static isAbsolute/".."
 * check first, then a realpath containment check that also catches a
 * symlink inside the package pointing outside it.
 */
export function runCleanup(installedDir: string): CleanupTarget[] {
	return readCleanupManifest(installedDir).map((declared): CleanupTarget => {
		const trimmed = declared.trim();
		if (isAbsolute(trimmed) || trimmed.split("/").includes("..")) return { declared, status: "escaped" };
		if (!existsSync(join(installedDir, trimmed))) return { declared, status: "missing" };
		if (!isContainedFile(installedDir, trimmed)) return { declared, status: "escaped" };
		try {
			rmSync(join(installedDir, trimmed), { recursive: true, force: true });
			return { declared, status: "removed" };
		} catch {
			return { declared, status: "failed" };
		}
	});
}

/** Human-readable summary appended to packed remove's own output -- "" when
 * there was nothing declared, so a package that never opted in produces
 * zero visible difference in packed remove's output either. */
export function formatCleanupSummary(targets: CleanupTarget[]): string {
	if (targets.length === 0) return "";
	const lines = targets.map((t) => `  ${t.status}: ${t.declared}`);
	return `\ncleanup (pi.cleanup):\n${lines.join("\n")}\n`;
}
