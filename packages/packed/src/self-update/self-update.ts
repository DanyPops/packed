/**
 * self-update.ts — updates Packed's own installation and restarts its
 * supervised systemd service, mirroring pi-version.ts's established
 * pattern: orchestrate the real package manager's own update command,
 * never reimplement version resolution.
 *
 * Detects how this CLI is actually running first. An npm-global install
 * (the real end-user case) gets a real `npm install --global` update. A
 * local git checkout (this repo's own dev setup: the shell wrapper execs
 * `bun .../packed/packages/packed/src/cli/cli.ts` directly, no npm layer at
 * all) skips the update step entirely rather than guessing at a git
 * workflow -- but still restarts the service, which is the actual
 * point for that case: pick up already-committed local source changes
 * without a manual `systemctl restart`.
 */
import { fileURLToPath } from "node:url";
import { type InteractiveRunResult, runInherited } from "../publish/publish.ts";
import type { Registry } from "../shared/ports.ts";
import { VERSION } from "../shared/version.ts";

export const PACKED_PACKAGE_NAME = "@danypops/packed";

export type SelfInstallMethod = { kind: "npm-global" } | { kind: "bun-global" } | { kind: "local-checkout"; path: string };

/** cli.ts's own resolved real path tells us how it's running: Bun's global
 * install layout is `$BUN_INSTALL/install/global/node_modules/<pkg>/...`
 * (confirmed live against a real `bun add -g` install -- distinct from a
 * plain npm-global tree, which has no `install/global` segment at all), an
 * ordinary node_modules/@danypops/packed tree (npm-managed), or anywhere
 * else (a plain checkout). Bun-global is checked first since its path also
 * contains the broader npm-global substring. */
export function detectSelfInstallMethod(cliUrl: string = import.meta.url): SelfInstallMethod {
	const path = fileURLToPath(cliUrl);
	if (path.includes(`/install/global/node_modules/${PACKED_PACKAGE_NAME}/`)) return { kind: "bun-global" };
	if (path.includes(`node_modules/${PACKED_PACKAGE_NAME}/`)) return { kind: "npm-global" };
	return { kind: "local-checkout", path };
}

export interface SelfUpdateReport {
	ok: boolean;
	previousVersion: string;
	latestVersion?: string;
	updated: boolean;
	restarted: boolean;
	message: string;
}

export interface SelfUpdateDeps {
	registry: Pick<Registry, "info">;
	installMethod?: SelfInstallMethod;
	/** Defaults to `npm install --global @danypops/packed@latest` via
	 * runInherited -- real npm output, no timeout, matching
	 * runPiUpdateSelf's exact pattern for pi's own self-update. */
	runNpmInstall?: (args: string[]) => Promise<InteractiveRunResult>;
	/** Defaults to `bun add --global @danypops/packed@latest` via
	 * runInherited -- Bun's own documented way to force-update a global
	 * install (re-adding with an explicit version); `bun update` has no
	 * --global flag at all. */
	runBunInstall?: (args: string[]) => Promise<InteractiveRunResult>;
	/** Undefined when the current platform has no supported restart
	 * mechanism (only Linux/systemd today, matching `packed service`'s
	 * own Linux-only scope) -- never guessed at. */
	restartService?: () => Promise<InteractiveRunResult>;
	isServiceInstalled?: () => boolean;
}

export async function runSelfUpdate(deps: SelfUpdateDeps): Promise<SelfUpdateReport> {
	const previousVersion = VERSION;
	const method = deps.installMethod ?? detectSelfInstallMethod();
	let latestVersion: string | undefined;
	let updated = false;
	let updateNote: string;

	if (method.kind === "local-checkout") {
		updateNote = `skipped update: running from a local checkout at ${method.path} (update it with your own git workflow, e.g. git pull)`;
	} else {
		try {
			latestVersion = (await deps.registry.info(PACKED_PACKAGE_NAME)).version;
		} catch {
			/* best-effort; the package manager's own install resolves latest either way */
		}
		if (method.kind === "bun-global") {
			const runBunInstall = deps.runBunInstall ?? ((args) => runInherited(["bun", ...args]));
			const install = await runBunInstall(["add", "--global", `${PACKED_PACKAGE_NAME}@latest`]);
			if (!install.ok) {
				return {
					ok: false,
					previousVersion,
					latestVersion,
					updated: false,
					restarted: false,
					message: `bun add --global ${PACKED_PACKAGE_NAME}@latest failed (exit ${install.code})`,
				};
			}
			updated = true;
			updateNote = "updated via bun";
		} else {
			const runNpmInstall = deps.runNpmInstall ?? ((args) => runInherited(["npm", ...args]));
			const install = await runNpmInstall(["install", "--global", `${PACKED_PACKAGE_NAME}@latest`]);
			if (!install.ok) {
				return {
					ok: false,
					previousVersion,
					latestVersion,
					updated: false,
					restarted: false,
					message: `npm install --global ${PACKED_PACKAGE_NAME}@latest failed (exit ${install.code})`,
				};
			}
			updated = true;
			updateNote = "updated via npm";
		}
	}

	const isServiceInstalled = deps.isServiceInstalled ?? (() => false);
	if (!isServiceInstalled()) {
		return {
			ok: true,
			previousVersion,
			latestVersion,
			updated,
			restarted: false,
			message: `${updateNote}; no supervised pi-packed service was found -- restart any running daemon manually`,
		};
	}
	if (!deps.restartService) {
		return {
			ok: true,
			previousVersion,
			latestVersion,
			updated,
			restarted: false,
			message: `${updateNote}; restarting the service isn't supported on this platform yet -- restart it manually: systemctl --user restart pi-packed.service`,
		};
	}
	const restart = await deps.restartService();
	if (!restart.ok) {
		return {
			ok: updated,
			previousVersion,
			latestVersion,
			updated,
			restarted: false,
			message: `${updateNote}; restarting pi-packed.service failed (exit ${restart.code}) -- restart it manually: systemctl --user restart pi-packed.service`,
		};
	}
	return { ok: true, previousVersion, latestVersion, updated, restarted: true, message: `${updateNote}; restarted the pi-packed service` };
}
