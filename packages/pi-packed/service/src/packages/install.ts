/** install.ts — driven adapter: pi CLI mutations via Bun.spawn. */

import { join } from "node:path";
import { HeadlessInstallValidator, type InstallValidator } from "../adoption/install-validation.ts";
import { defaultPiHome, isPinnedNpmSource, readResolvedVersion } from "./installed.ts";
import type { Installer, UpdateOutcome } from "./package.ts";

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
	) {}

	private async run(args: string[]): Promise<string> {
		const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
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
	 */
	private async reresolveDependencyTree(): Promise<string> {
		const cwd = join(this.piHome, "npm");
		const proc = Bun.spawn([this.npmBin, "install"], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(`npm install failed to re-resolve the dependency tree at ${cwd} (exit ${code}): ${out || "no output"}`);
		return out;
	}

	async install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		const validation = await this.validator.validate(source);
		if (!validation.ok) {
			const detail = validation.extensions
				.filter((extension) => !extension.ok)
				.map((extension) => `${extension.path}: ${extension.message}`)
				.join("; ");
			throw new Error(`install refused -- ${detail || validation.message || "extension failed a headless load check"}`);
		}
		const output = await this.run(["install", ...(options?.local ? ["-l"] : []), source]);
		await this.reresolveDependencyTree();
		return output;
	}

	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		return this.run(["remove", ...(options?.local ? ["-l"] : []), source]);
	}

	async update(source: string, _options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome> {
		const pinned = isPinnedNpmSource(source);
		const previousVersion = readResolvedVersion(this.piHome, source);
		const output = await this.run(["update", "--extension", source]);
		await this.reresolveDependencyTree();
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
