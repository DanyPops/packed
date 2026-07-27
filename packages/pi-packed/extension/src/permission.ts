import type { SecuritySettings } from "@danypops/packed/protocol";

export type PackageOperation = "install" | "update" | "remove";

export function packagePermissionDecision(settings: SecuritySettings, operation: PackageOperation): { approvalRequired: boolean } {
	return { approvalRequired: settings.mutationApproval === "always" && (operation === "install" || operation === "update" || operation === "remove") };
}
