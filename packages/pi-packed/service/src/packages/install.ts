/** install.ts — driven adapter: pi CLI mutations via Bun.spawn. */

import { join } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	assertInstallValidationOk,
	HeadlessInstallValidator,
	type InstallValidationResult,
	type InstallValidator,
} from "../adoption/install-validation.ts";
import { applyEntryFilters, captureEntryFilters, resolveToggleSettingsPath } from "./resources.ts";
import { createLogger } from "../shared/log.ts";
import { defaultPiHome, isPinnedNpmSource, npmPackageName, readPackageDeclarations, readResolvedVersion } from "./installed.ts";
import { isNewer } from "./package.ts";
import type { Installer, UpdateOutcome } from "./package.ts";

function round1(ms: number): number {
	return Math.round(ms * 10) / 10;
}

/** Bare npm package name (for `packed remove`). */
export const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

export function defaultPiBin(): string {
	return process.env.PI_PACKED_PI_BIN ?? process.env.PI_BIN ?? "pi";
}

export function defaultNpmBin(): string {
	return process.env.PI_PACKED_NPM_BIN ?? process.env.NPM_BIN ?? "npm";
}

export class ExecInstaller implements Installer {
	constructor(
		private bin = defaultPiBin(),
		private piHome = defaultPiHome(),
		private validator: InstallValidator = new HeadlessInstallValidator(),
		private npmBin = defaultNpmBin(),
		/**
		 * Instrumentation only -- never gates behavior. Each install()/update() call logs one
		 * "install timing"/"update timing" debug line breaking down where its wall-clock time went
		 * (validateMs/installMs/reresolveMs, plus totalMs): the real, previously-invisible cost of
		 * installing/updating several packages one at a time (see SetupManager.apply()'s own
		 * sequential loop) is dominated by reresolveDependencyTree() -- a FULL `npm install` at
		 * piHome/npm re-run after every single package, not just the newly touched one. Surfacing
		 * that split here is what let service/test/perf/multi-install.perf.test.ts quantify it
		 * against a real daemon instead of guessing from wall-clock totals alone.
		 */
		private readonly logger: Logger = createLogger("install"),
		/**
		 * Optional real registry-mirror lookup (see daemon/watcher.ts's own
		 * checkUpdates(), which this shares its cross-check logic with via
		 * package.ts's isNewer) -- undefined by default so every existing
		 * caller/test keeps its old "already up to date means nothing to
		 * report" behavior unless a daemon explicitly wires its own mirror in.
		 */
		private readonly latestOf?: (name: string) => string | undefined,
	) {}

	private async run(args: string[]): Promise<string> {
		// env is explicit, not Bun.spawn's own default-inherited env: a caller that redirects Pi's
		// home via a runtime process.env mutation (e.g. PI_CODING_AGENT_DIR, set after this process
		// already started -- confirmed live from service/test/perf/multi-install.perf.test.ts) needs
		// that reflected in the CURRENT process.env object, not whatever snapshot Bun's own default
		// inheritance captured. Silently missing this sent a real run straight into the developer's
		// actual ~/.pi/agent instead of the intended isolated temp directory.
		const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(out || `exit ${code}`);
		return out;
	}

	/**
	 * `pi install`/`pi update --extension <source>` only resolve the target
	 * package's own subtree. npm's own `dedupe` docs (confirmed by
	 * npm/cli#5307 and npm/cli#7277) describe rearranging already-resolved
	 * versions, never installing a newer one -- so a sibling package's own
	 * declared range can go unsatisfied at the shared root and node's
	 * resolution silently walks up to a stale copy nothing wanted. A full
	 * `npm install` (no args) at piHome/npm is npm's own documented reliable
	 * fix: it re-resolves the whole tree, not just the last-touched package.
	 *
	 * Public (not private) so a batch caller -- see SetupManager.apply() -- can call this ONCE
	 * after committing every package in a batch via installOnly(), instead of install()/update()
	 * each calling it once per package. Safe to call as often as today regardless: re-resolving an
	 * already-consistent tree is a cheap no-op for npm, never itself a source of drift.
	 */
	async reresolveDependencyTree(): Promise<string> {
		const t0 = performance.now();
		const cwd = join(this.piHome, "npm");
		// See run()'s own comment: env is explicit for the identical reason.
		const proc = Bun.spawn([this.npmBin, "install"], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(`npm install failed to re-resolve the dependency tree at ${cwd} (exit ${code}): ${out || "no output"}`);
		this.logger.debug("reresolve timing", { reresolveMs: round1(performance.now() - t0) });
		return out;
	}

	/**
	 * Safe to run CONCURRENTLY across many sources -- see Installer.validate's own doc comment.
	 * Delegates to whatever InstallValidator this instance was constructed with (real:
	 * HeadlessInstallValidator, stages into its own throwaway temp dir per call).
	 */
	async validate(source: string): Promise<InstallValidationResult> {
		const t0 = performance.now();
		const result = await this.validator.validate(source);
		this.logger.debug("validate timing", { source, validateMs: round1(performance.now() - t0) });
		return result;
	}

	/**
	 * The real `pi install` mutation alone -- no validation (call validate() first; install()
	 * does both, in order, for a single ad hoc caller), no trailing reresolveDependencyTree() (a
	 * batch caller defers that to once per batch, not once per package). MUST be awaited
	 * sequentially across a batch, never run concurrently -- see Installer.installOnly's own doc
	 * comment for the confirmed settings.json/package.json corruption a naive Promise.all here
	 * produces.
	 */
	async installOnly(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		const t0 = performance.now();
		const output = await this.run(["install", ...(options?.local ? ["-l"] : []), source]);
		this.logger.debug("installOnly timing", { source, installMs: round1(performance.now() - t0) });
		return output;
	}

	async install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		const t0 = performance.now();
		const validation = await this.validate(source);
		const validateMs = performance.now() - t0;
		assertInstallValidationOk(validation);
		const t1 = performance.now();
		const output = await this.installOnly(source, options);
		const installMs = performance.now() - t1;
		const t2 = performance.now();
		await this.reresolveDependencyTree();
		const reresolveMs = performance.now() - t2;
		this.logger.debug("install timing", {
			source,
			validateMs: round1(validateMs),
			installMs: round1(installMs),
			reresolveMs: round1(reresolveMs),
			totalMs: round1(performance.now() - t0),
		});
		return output;
	}

	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		return this.run(["remove", ...(options?.local ? ["-l"] : []), source]);
	}

	/**
	 * The real `pi update --extension <source>` mutation alone -- no trailing reresolveDependencyTree()
	 * (a batch caller defers that to once per batch via updateManyPackages(), not once per package).
	 * Returns the full UpdateOutcome (unlike installOnly()'s raw string): a single package's own
	 * before/after version diff is already correct right after ITS OWN update -- reresolveDependencyTree()
	 * exists to fix a DIFFERENT sibling's drift, not this package's own resolved version. MUST be
	 * awaited sequentially across a batch, never run concurrently -- same shared settings.json/
	 * package.json mutation hazard as installOnly(), see its own doc comment.
	 */
	async updateOnly(source: string, options?: { approved?: boolean; local?: boolean; target?: string }): Promise<UpdateOutcome> {
		if (options?.target) return this.replace(source, options.target, options);
		const t0 = performance.now();
		const pinned = isPinnedNpmSource(source);
		const previousVersion = readResolvedVersion(this.piHome, source);
		const output = await this.run(["update", "--extension", source]);
		this.logger.debug("updateOnly timing", { source, updateMs: round1(performance.now() - t0) });
		const currentVersion = readResolvedVersion(this.piHome, source);
		// Only trust a "nothing changed" conclusion when we actually read a
		// real version both before and after (npm source, resolvable in
		// node_modules). Otherwise (git:/https: sources, or an unreadable
		// node_modules entry) fall back to the traditional "assume it may
		// have changed" signal instead of falsely claiming it didn't.
		const knowsBoth = previousVersion !== undefined && currentVersion !== undefined;
		const changed = !knowsBoth || previousVersion !== currentVersion;
		const alreadyUpToDate = !changed;
		// Only worth cross-checking when there's actually a "nothing changed"
		// conclusion to double-check, a real mirror lookup was wired in, and
		// there's a real bare npm name + resolved version to compare against.
		const name = alreadyUpToDate && this.latestOf ? npmPackageName(source) : undefined;
		const latest = name && currentVersion ? this.latestOf?.(name) : undefined;
		const outOfRangeUpdateAvailable = latest && currentVersion && isNewer(latest, currentVersion) ? latest : undefined;
		return {
			output,
			reloadRequired: changed,
			alreadyUpToDate,
			pinned,
			previousVersion,
			currentVersion,
			...(outOfRangeUpdateAvailable ? { outOfRangeUpdateAvailable } : {}),
			// A plain update() with no target can never move an exact pin --
			// `pi update --extension` itself intentionally skips it (npm's own
			// documented behavior for a versioned spec). alreadyUpToDate/pinned
			// above are already an honest, non-"false success" result; this adds
			// an unambiguous machine-readable nudge toward options.target instead
			// of a caller having to infer "pinned AND alreadyUpToDate means stuck"
			// itself. See replace() for the actual supervised pin-move workflow.
			...(pinned && alreadyUpToDate ? { pinnedSourceRequiresTarget: true } : {}),
		};
	}

	async update(source: string, options?: { approved?: boolean; local?: boolean; target?: string }): Promise<UpdateOutcome> {
		if (options?.target) return this.replace(source, options.target, options);
		const t0 = performance.now();
		const t1 = performance.now();
		const result = await this.updateOnly(source, options);
		const updateMs = performance.now() - t1;
		const t2 = performance.now();
		await this.reresolveDependencyTree();
		const reresolveMs = performance.now() - t2;
		this.logger.debug("update timing", {
			source,
			updateMs: round1(updateMs),
			reresolveMs: round1(reresolveMs),
			totalMs: round1(performance.now() - t0),
		});
		return result;
	}

	/**
	 * The alternate mutation path for a source classifyUpdateSource() flags as
	 * "daemon-dependency" -- genuinely installed and npm-resolvable, but NOT
	 * itself a pi:-configured extension, so `pi update --extension` can never
	 * find it (confirmed via a real failing-test repro of pi's own "No
	 * matching package found"). Runs a real, scoped `npm install
	 * <name>[@version]` at piHome/npm directly -- npm's own single-invocation
	 * dependency + lockfile update, no separate reresolveDependencyTree() call
	 * needed afterward. No `pi:` manifest exists for this package to validate
	 * against, so -- unlike install()/update() -- there is no validate() step
	 * here at all.
	 */
	async updateDaemonDependency(name: string, options?: { approved?: boolean; version?: string }): Promise<UpdateOutcome> {
		const t0 = performance.now();
		const previousVersion = readResolvedVersion(this.piHome, `npm:${name}`);
		const spec = `${name}@${options?.version ?? "latest"}`;
		const cwd = join(this.piHome, "npm");
		// See run()'s own comment: env is explicit for the identical reason.
		const proc = Bun.spawn([this.npmBin, "install", spec], { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(out || `exit ${code}`);
		const currentVersion = readResolvedVersion(this.piHome, `npm:${name}`);
		this.logger.debug("updateDaemonDependency timing", { name, totalMs: round1(performance.now() - t0) });
		// Same honesty discipline as update() above: only trust a "nothing
		// changed" conclusion when a real version was actually read both before
		// and after.
		const knowsBoth = previousVersion !== undefined && currentVersion !== undefined;
		const changed = !knowsBoth || previousVersion !== currentVersion;
		return {
			output: out,
			reloadRequired: changed,
			alreadyUpToDate: !changed,
			pinned: options?.version !== undefined,
			previousVersion,
			currentVersion,
		};
	}

	/**
	 * The supervised "move a pin" workflow `pi update --extension` can never
	 * perform by itself (it intentionally skips an exact pin) -- see the
	 * linked research doc (pinned-package-update-behavior-and-safe-
	 * replacement-research): a bare `pi install <newSource>` does not
	 * rewrite an already-configured entry for the same package, it requires
	 * an explicit remove-then-install sequence. Reuses install()/remove()
	 * (the same supported, already-tested primitives) rather than
	 * hand-rolling new subprocess calls, so validation/reresolve/timing
	 * behave identically to every other mutation.
	 *
	 * Order of operations: identity check (never touches disk on mismatch)
	 * -> capture `fromSource`'s own filter overrides (extensions/skills/
	 * prompts/themes) so remove() doesn't silently discard them -> remove
	 * `fromSource` -> install `toSource`, rolling back to `fromSource` on
	 * failure -> re-apply the captured filters onto the new entry -> verify
	 * BOTH postconditions (installed: readResolvedVersion; configured:
	 * present in settings.json) before reporting success.
	 */
	private async replace(fromSource: string, toSource: string, options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome> {
		const fromName = npmPackageName(fromSource);
		const toName = npmPackageName(toSource);
		if (!fromName || !toName || fromName !== toName) {
			throw new Error(`replace target must be the same package as the configured source: ${fromSource} -> ${toSource}`);
		}
		const settingsPath = resolveToggleSettingsPath(this.piHome);
		const before = { source: fromSource, version: readResolvedVersion(this.piHome, fromSource) };
		const filters = captureEntryFilters(settingsPath, fromSource);

		let removeOutput: string;
		try {
			removeOutput = await this.remove(fromSource, options);
		} catch (e) {
			throw new Error(`replace failed removing ${fromSource}: ${e instanceof Error ? e.message : String(e)}`);
		}

		let installOutput: string;
		try {
			installOutput = await this.install(toSource, options);
		} catch (installError) {
			const installMessage = installError instanceof Error ? installError.message : String(installError);
			let rollback: NonNullable<UpdateOutcome["rollback"]>;
			try {
				await this.install(fromSource, options);
				rollback = { attempted: true, ok: true };
			} catch (rollbackError) {
				rollback = {
					attempted: true,
					ok: false,
					message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
				};
			}
			const rollbackNote = rollback.ok
				? `rolled back to ${fromSource}`
				: `ROLLBACK TO ${fromSource} ALSO FAILED: ${rollback.message} -- ${fromName} may now be uninstalled entirely, reinstall manually`;
			throw new Error(`replace failed installing ${toSource}: ${installMessage} (${rollbackNote})`);
		}

		await applyEntryFilters(settingsPath, toSource, filters);

		const afterVersion = readResolvedVersion(this.piHome, toSource);
		const configuredAfter = readPackageDeclarations(this.piHome).includes(toSource);
		if (!configuredAfter) {
			// install() itself reported success, but settings.json doesn't show
			// toSource configured -- a real postcondition failure, not merely a
			// version mismatch. Never claim success on an unverified replace.
			throw new Error(`replace installed ${toSource} but settings.json does not show it configured -- verify manually before retrying`);
		}
		const after = { source: toSource, version: afterVersion };
		const changed = before.version !== after.version || before.source !== after.source;
		return {
			output: `${removeOutput}\n${installOutput}`.trim(),
			reloadRequired: changed,
			alreadyUpToDate: !changed,
			pinned: isPinnedNpmSource(toSource),
			previousVersion: before.version,
			currentVersion: after.version,
			replaced: true,
			before,
			after,
		};
	}
}

export interface UpdateManyOutcome {
	readonly source: string;
	readonly status: "succeeded" | "failed";
	readonly outcome?: UpdateOutcome;
	readonly error?: string;
}

export interface UpdateManyResult {
	readonly outcomes: readonly UpdateManyOutcome[];
	/** True whenever any succeeded source actually changed version -- one combined signal instead of a caller re-deriving it per outcome. */
	readonly reloadRequired: boolean;
	/** Set only when the final batch-wide reresolve itself failed -- every individual outcome above already reflects its own real result regardless. */
	readonly reresolveError?: string;
}

/**
 * Batch update over several sources at once -- same validate-concurrently/commit-sequentially/
 * reresolve-once shape as SetupManager.apply()'s own batch mode (see Installer.updateOnly's own
 * doc comment): every source is updated in turn via updateOnly() (no per-source reresolve), then
 * reresolveDependencyTree() runs exactly ONCE for the whole batch -- the real cost `packed update`
 * one source at a time was paying N times over (see ExecInstaller's own constructor doc comment).
 * Sequential across sources, never fanned out -- same shared-file mutation hazard as installOnly().
 * One source failing never stops the rest; each gets its own independent outcome. Falls back to
 * one update() call per source (each paying its own reresolve) when the installer doesn't
 * implement the updateOnly/reresolveDependencyTree batch trio -- matching SetupManager.apply()'s
 * own graceful degradation for a non-batch-capable Installer (e.g. a plain test double).
 */
export async function updateManyPackages(
	installer: Installer,
	sources: readonly string[],
	options?: { approved?: boolean },
): Promise<UpdateManyResult> {
	const batch = Boolean(installer.updateOnly && installer.reresolveDependencyTree);
	const outcomes: UpdateManyOutcome[] = [];
	for (const source of sources) {
		try {
			const outcome =
				batch && installer.updateOnly ? await installer.updateOnly(source, options) : await installer.update(source, options);
			outcomes.push({ source, status: "succeeded", outcome });
		} catch (error) {
			outcomes.push({ source, status: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	}
	const reloadRequired = outcomes.some((item) => item.status === "succeeded" && item.outcome?.reloadRequired);
	if (batch && installer.reresolveDependencyTree && outcomes.some((item) => item.status === "succeeded")) {
		try {
			await installer.reresolveDependencyTree();
		} catch (error) {
			return { outcomes, reloadRequired, reresolveError: error instanceof Error ? error.message : String(error) };
		}
	}
	return { outcomes, reloadRequired };
}
