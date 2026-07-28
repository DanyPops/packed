/**
 * reload.ts — one shared decision for whether a Pi package mutation needs a
 * reload to take effect, and the exact wording every mutation surface
 * (native tools, the /packages panel, and the resource overlay) uses to
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
