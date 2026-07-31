/**
 * watcher.ts — event producer #1: version-drift detection.
 * Diffs installed packages against registry dist-tags.latest and persists
 * an event snapshot (event-carried state) for cheap consumer reads.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gt, valid } from "semver";
import { UPDATES_FILE } from "../shared/constants.ts";
import { createLogger } from "../shared/log.ts";

const log = createLogger("watcher");
import type { InstalledPkg, UpdateEntry, UpdatesSnapshot } from "../shared/ports.ts";

function updatesPath(dir: string): string {
	return join(dir, UPDATES_FILE);
}

export async function saveUpdates(dir: string, snap: UpdatesSnapshot): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(updatesPath(dir), JSON.stringify(snap), { mode: 0o600 });
}

export async function loadUpdates(dir: string): Promise<UpdatesSnapshot | undefined> {
	try {
		return JSON.parse(await readFile(updatesPath(dir), "utf8")) as UpdatesSnapshot;
	} catch {
		return undefined;
	}
}

/**
 * True drift only: mirrored latest is a real semver step *ahead* of what's
 * installed, never merely different from it. A plain !== check (this
 * function's own bug until fixed) cannot distinguish "installed is behind
 * latest" from "installed is already ahead of a stale/wrong mirrored
 * latest" -- confirmed live: an installed package whose version had
 * already passed the daemon's own mirrored dist-tags.latest kept showing
 * a permanent, un-clearable "update available" badge pointing at an
 * *older* version. Falls back to the old inequality only when either side
 * isn't parseable semver (a git ref, a literal "latest" tag, etc.) --
 * those aren't comparable at all, so "different" is the only signal left.
 */
function isNewer(latest: string, have: string): boolean {
	if (valid(latest, { loose: true }) && valid(have, { loose: true })) return gt(latest, have, { loose: true });
	return latest !== have;
}

/** Pure diff against the local mirror (apt list --upgradable semantics):
 * drift = mirrored latest is genuinely newer than what we have. The
 * mirror is refreshed by catalogSync; updates are computed offline,
 * exactly like APT. */
export function checkUpdates(latestOf: (name: string) => string | undefined, installed: InstalledPkg[]): UpdateEntry[] {
	const now = new Date().toISOString();
	const updates: UpdateEntry[] = [];
	for (const p of installed) {
		const have = p.installed || p.pinned;
		if (!have) continue;
		const latest = latestOf(p.name);
		if (latest && isNewer(latest, have)) {
			updates.push({ name: p.name, installed: have, latest, detectedAt: now, ...(p.scope ? { scope: p.scope } : {}) });
		}
	}
	return updates;
}

export interface WatcherOptions {
	intervalMs: number;
	onError?: (e: unknown) => void;
}

/** Producer loop: immediate check, then on a timer. Returns a stop function. */
export function startWatcher(
	latestOf: (name: string) => string | undefined,
	stateDir: string,
	readInstalled: () => InstalledPkg[],
	opts: WatcherOptions,
): () => void {
	async function check(): Promise<void> {
		try {
			const updates = checkUpdates(latestOf, readInstalled());
			await saveUpdates(stateDir, { checkedAt: new Date().toISOString(), updates });
			log.info("updates check", { updates: updates.length });
		} catch (e) {
			opts.onError?.(e);
		}
	}
	void check();
	const timer = setInterval(() => void check(), opts.intervalMs);
	return () => clearInterval(timer);
}
