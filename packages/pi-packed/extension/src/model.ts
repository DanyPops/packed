/**
 * model.ts — pure row logic for the /packages panel. No I/O: vitest drives
 * this directly (the TUI component is a thin shell over these functions).
 */
import type { InstalledPkg, UpdateEntry } from "./packed.js";

export interface Row {
	name: string;
	version: string; // pinned ?? installed
	latest?: string;
	hasUpdate: boolean;
}

export type ViewMode = "all" | "updates";

export function mergeRows(installed: InstalledPkg[], updates: UpdateEntry[]): Row[] {
	const byName = new Map(updates.map((u) => [u.name, u]));
	return installed
		.map((p) => {
			const u = byName.get(p.name);
			return {
				name: p.name,
				version: p.pinned ?? p.installed ?? "?",
				latest: u?.latest,
				hasUpdate: u !== undefined,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function visibleRows(rows: Row[], mode: ViewMode): Row[] {
	if (mode === "updates") return rows.filter((r) => r.hasUpdate);
	return rows;
}

export function nextMode(mode: ViewMode): ViewMode {
	return mode === "all" ? "updates" : "all";
}

export function filterRows(rows: Row[], query: string): Row[] {
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter((r) => r.name.toLowerCase().includes(q));
}

export function formatUpdateNotice(updates: UpdateEntry[]): string {
	const names = updates.slice(0, 3).map((u) => `${u.name} ${u.installed}→${u.latest}`);
	const more = updates.length > 3 ? ` +${updates.length - 3} more` : "";
	return `${updates.length} package update(s): ${names.join(", ")}${more}`;
}
