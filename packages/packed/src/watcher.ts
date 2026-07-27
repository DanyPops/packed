/**
 * watcher.ts — event producer #1: version-drift detection.
 * Diffs installed packages against registry dist-tags.latest and persists
 * an event snapshot (event-carried state) for cheap consumer reads.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UPDATES_FILE } from "./constants.ts";
import { createLogger } from "./log.ts";

const log = createLogger("watcher");
import type { InstalledPkg, UpdateEntry, UpdatesSnapshot } from "./ports.ts";

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

/** Pure diff against the local mirror (apt list --upgradable semantics):
 * drift = mirrored latest ≠ what we have. The mirror is refreshed by
 * catalogSync; updates are computed offline, exactly like APT. */
export function checkUpdates(latestOf: (name: string) => string | undefined, installed: InstalledPkg[]): UpdateEntry[] {
	const now = new Date().toISOString();
	const updates: UpdateEntry[] = [];
	for (const p of installed) {
		const have = p.installed || p.pinned;
		if (!have) continue;
		const latest = latestOf(p.name);
		if (latest && latest !== have) {
			updates.push({ name: p.name, installed: have, latest, detectedAt: now });
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
