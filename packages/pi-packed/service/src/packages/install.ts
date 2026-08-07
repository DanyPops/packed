/** install.ts — driven adapter: pi CLI mutations via Bun.spawn. */

import { join } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	assertInstallValidationOk,
	HeadlessInstallValidator,
	type InstallValidationResult,
	type InstallValidator,
} from "../adoption/install-validation.ts";
import { createLogger } from "../shared/log.ts";
import { defaultPiHome, isPinnedNpmSource, readResolvedVersion } from "./installed.ts";
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

	async update(source: string, _options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome> {
		const t0 = performance.now();
		const pinned = isPinnedNpmSource(source);
		const previousVersion = readResolvedVersion(this.piHome, source);
		const t1 = performance.now();
		const output = await this.run(["update", "--extension", source]);
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
		const currentVersion = readResolvedVersion(this.piHome, source);
		// Only trust a "nothing changed" conclusion when we actually read a
		// real version both before and after (npm source, resolvable in
		// node_modules). Otherwise (git:/https: sources, or an unreadable
		// node_modules entry) fall back to the traditional "assume it may
		// have changed" signal instead of falsely claiming it didn't.
		const knowsBoth = previousVersion !== undefined && currentVersion !== undefined;
		const changed = !knowsBoth || previousVersion !== currentVersion;
		return { output, reloadRequired: changed, alreadyUpToDate: !changed, pinned, previousVersion, currentVersion };
	}
}
