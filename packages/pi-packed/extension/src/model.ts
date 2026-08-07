/**
 * model.ts — pure row logic for the /packed panel. No I/O: vitest drives
 * this directly (the TUI component is a thin shell over these functions).
 */
import { gt, valid } from "semver";
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
			const version = p.pinned ?? p.installed ?? "?";
			const snapshot = byName.get(p.name);
			const comparable = valid(version) !== null && valid(snapshot?.latest) !== null;
			const update =
				snapshot && (comparable ? gt(snapshot.latest, version) : snapshot.installed === version && snapshot.latest !== version)
					? snapshot
					: undefined;
			return {
				name: p.name,
				version,
				latest: update?.latest,
				hasUpdate: update !== undefined,
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

const MS_PER_DAY = 86_400_000;

/**
 * A compact relative age for the Find tab's Card and the package inspector -- e.g. "today",
 * "12d ago", "5mo ago", "3y ago". `now` is injectable so a test never depends on the real clock.
 * Undefined for anything unparseable, or a date that claims to be in the future (clock skew or
 * bad upstream data -- never worth presenting as "released -3d ago").
 */
export function formatRelativeDate(iso: string | undefined, now: Date = new Date()): string | undefined {
	if (!iso) return undefined;
	const then = new Date(iso);
	if (Number.isNaN(then.getTime())) return undefined;
	const days = Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);
	if (days < 0) return undefined;
	if (days === 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

/**
 * A compact K/M-abbreviated download count -- e.g. 718531784 -> "718.5M", 166075689 -> "166.1M",
 * 950 -> "950". Undefined for anything not a real non-negative finite number (npm's own downloads
 * endpoints are usually reliable, but this is user-facing display text, not a trusted internal
 * value -- never render "NaN" or "-5").
 */
export function formatDownloadCount(count: number | undefined): string | undefined {
	if (count === undefined || !Number.isFinite(count) || count < 0) return undefined;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
	return String(Math.floor(count));
}
