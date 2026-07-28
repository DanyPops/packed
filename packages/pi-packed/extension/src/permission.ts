import type { SecuritySettings } from "@danypops/packed/protocol";

export type PackageOperation = "install" | "update" | "remove" | "toggle";

const GUARDED: readonly PackageOperation[] = ["install", "update", "remove", "toggle"];

export function packagePermissionDecision(settings: SecuritySettings, operation: PackageOperation): { approvalRequired: boolean } {
	return { approvalRequired: settings.mutationApproval === "always" && GUARDED.includes(operation) };
}
