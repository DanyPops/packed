/**
 * reload.ts — one shared decision for whether a Pi package mutation needs a
 * reload to take effect, and the exact wording every mutation surface
 * (native tools, the /packed panel, and the resource overlay) uses to
 * warn about it. Keeps three independent implementations from drifting
 * apart on when and how they say a reload is coming.
 */
import type { PackageOperation } from "./permission.js";

/**
 * Packed's own npm package name -- the one target where install/update/
 * remove has a real, confirmed hazard plain /reload cannot fix: this
 * extension's own already-loaded code (e.g. vehicle-target.ts importing
 * @danypops/pi-packed/client) keeps a stale reference to the pre-mutation
 * module even after /reload re-evaluates the extension's own source files.
 * Confirmed live: updating pi-packed mid-session, then /reload, threw
 * "resolveVehicleClientTarget is not a function" -- a brand-new process
 * importing the exact same on-disk files resolved it fine. Node/Bun cache
 * an ES module by resolved file path for the life of the process; an
 * in-place npm overwrite never invalidates an already-loaded entry, and
 * /reload only re-executes the extension's own entry file, not every
 * transitively-cached dependency. Only a full process restart re-imports
 * everything fresh.
 */
export const PACKED_NPM_PACKAGE_NAME = "@danypops/pi-packed";

/**
 * True when a pkg_install/pkg_update source (npm:@danypops/pi-packed,
 * npm:@danypops/pi-packed@1.2.3, git:/https: sources never match) or a
 * pkg_remove bare name refers to Packed's own npm package. Deliberately
 * narrow -- this is the one case Packed can be CERTAIN has the stale-
 * module-cache hazard above, since it's the package whose own code is
 * running the mutation. Any other package's extension could in principle
 * have the same self-import pattern, but Packed has no way to know that
 * about third-party code, so it never guesses there.
 */
export function targetsPackedItself(sourceOrName: string): boolean {
	const withoutScheme = sourceOrName.startsWith("npm:") ? sourceOrName.slice(4) : sourceOrName;
	const bare = withoutScheme.startsWith("@") ? withoutScheme.split("@").slice(0, 2).join("@") : withoutScheme.split("@")[0];
	return bare === PACKED_NPM_PACKAGE_NAME;
}

export interface ReloadWarningOptions {
	/** True when the target is Packed's own package -- see targetsPackedItself(). */
	restartRequired?: boolean;
}

/** Inline warning appended to a mutation's pre-confirmation dialog, before
 * the operation runs -- the moment the user is actually deciding. */
export function reloadWarning(operation: PackageOperation, options: ReloadWarningOptions = {}): string {
	if (options.restartRequired) {
		return operation === "remove"
			? "Packed's own code is already running inside this Pi process -- deactivating it needs a full restart (exit and relaunch Pi), not just /reload."
			: "Packed's own code is already running inside this Pi process -- its updated code can only be picked up by a full restart (exit and relaunch Pi), not just /reload.";
	}
	return operation === "remove"
		? "This will require a Pi reload (/reload) to deactivate it."
		: "This will likely require a Pi reload (/reload) to activate its resources.";
}

export interface ReloadConfirmContext {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}

/**
 * The second, separate decision point: reloadWarning above is a still-just-
 * likely warning shown before a mutation runs; this is asked only once the
 * mutation has actually succeeded and a reload is now definitely needed,
 * not merely predicted. Declining defers it -- the mutation itself already
 * happened (the package really did install/update/toggle); only Pi's own
 * currently-loaded resources are stale until /reload runs later. No-UI
 * contexts reload immediately: there's no one to ask, and staying silently
 * stale forever is worse than reloading.
 *
 * Extracted from resource-config.ts's own pre-existing pendingReload gate
 * (the first surface to implement this pattern) so every mutation surface
 * shares identical wording and behavior instead of drifting apart --
 * reload.ts's whole reason for existing.
 */
export async function confirmReload(ctx: ReloadConfirmContext, options: ReloadWarningOptions = {}): Promise<boolean> {
	if (!ctx.hasUI) return true;
	if (options.restartRequired) {
		return ctx.ui.confirm(
			"Restart Pi now?",
			"Packed's own code changed and cannot be hot-reloaded from inside itself -- exit and relaunch Pi to pick it up. /reload alone will not work.",
		);
	}
	return ctx.ui.confirm("Reload Pi now?", "This change only takes effect after a reload.");
}
