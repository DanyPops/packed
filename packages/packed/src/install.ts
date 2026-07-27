/** install.ts — driven adapter: pi CLI mutations via Bun.spawn. */
import { defaultPiHome, isPinnedNpmSource, readResolvedVersion } from "./installed.ts";
import type { Installer, UpdateOutcome } from "./ports.ts";

/** Bare npm package name (for `packed remove`). */
export const NAME_RE = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;

export function defaultPiBin(): string {
	return process.env["PI_PACKED_PI_BIN"] ?? process.env["PI_BIN"] ?? "pi";
}

export class ExecInstaller implements Installer {
	constructor(
		private bin = defaultPiBin(),
		private piHome = defaultPiHome(),
	) {}

	private async run(args: string[]): Promise<string> {
		const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		const code = await proc.exited;
		if (code !== 0) throw new Error(out || `exit ${code}`);
		return out;
	}

	install(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		return this.run(["install", ...(options?.local ? ["-l"] : []), source]);
	}

	remove(source: string, options?: { approved?: boolean; local?: boolean }): Promise<string> {
		return this.run(["remove", ...(options?.local ? ["-l"] : []), source]);
	}

	async update(source: string, _options?: { approved?: boolean; local?: boolean }): Promise<UpdateOutcome> {
		const pinned = isPinnedNpmSource(source);
		const previousVersion = readResolvedVersion(this.piHome, source);
		const output = await this.run(["update", "--extension", source]);
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
