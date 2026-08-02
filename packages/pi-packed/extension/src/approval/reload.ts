/**
 * reload.ts — one shared decision for whether a Pi package mutation needs a
 * reload to take effect, and the exact wording every mutation surface
 * (native tools, the /packed panel, and the resource overlay) uses to
 * warn about it. Keeps three independent implementations from drifting
 * apart on when and how they say a reload is coming.
 */
import type { PackageOperation } from "./permission.js";

/** Inline warning appended to a mutation's pre-confirmation dialog, before
 * the operation runs -- the moment the user is actually deciding. */
export function reloadWarning(operation: PackageOperation): string {
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
export async function confirmReload(ctx: ReloadConfirmContext): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm("Reload Pi now?", "This change only takes effect after a reload.");
}
