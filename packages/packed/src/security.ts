import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECURITY_FILE } from "./constants.ts";

export const MUTATION_APPROVAL_VALUES = ["always", "never"] as const;
export type MutationApproval = typeof MUTATION_APPROVAL_VALUES[number];

export const PACKAGE_OPERATIONS = [
	"search",
	"info",
	"installed",
	"catalog",
	"updates",
	"check",
	"setup.plan",
	"security.read",
	"mirror",
	"setup.export",
	"setup.update",
	"install",
	"install_service",
	"setup.apply",
	"update",
	"remove",
	"resources.list",
	"resources.toggle",
	"security.write",
	"pi.status",
] as const;
export type PackageOperation = typeof PACKAGE_OPERATIONS[number];
export type PackageOperationClassification = "read" | "maintenance" | "code-execution" | "settings-mutation" | "security-mutation";

export interface SecuritySettings { mutationApproval: MutationApproval }
export interface SecuritySettingsPort {
	security(): Promise<SecuritySettings>;
	setMutationApproval(value: MutationApproval, options?: { approved?: boolean }): Promise<SecuritySettings>;
}

export interface PackagePermissionDecision {
	operation: PackageOperation;
	classification: PackageOperationClassification;
	approvalRequired: boolean;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { mutationApproval: "always" };

const CLASSIFICATIONS: Record<PackageOperation, PackageOperationClassification> = {
	search: "read",
	info: "read",
	installed: "read",
	catalog: "read",
	updates: "read",
	check: "read",
	"setup.plan": "read",
	"security.read": "read",
	mirror: "maintenance",
	"setup.export": "maintenance",
	"setup.update": "maintenance",
	install: "code-execution",
	install_service: "code-execution",
	"setup.apply": "code-execution",
	update: "code-execution",
	remove: "settings-mutation",
	"resources.list": "read",
	"resources.toggle": "settings-mutation",
	"security.write": "security-mutation",
	"pi.status": "read",
};

export class PackageApprovalRequiredError extends Error {
	readonly code = "approval_required";
	constructor(readonly operation: PackageOperation) {
		super(`approval required for package operation ${operation}`);
		this.name = "PackageApprovalRequiredError";
	}
}

export function packageOperationClassification(operation: PackageOperation): PackageOperationClassification {
	return CLASSIFICATIONS[operation];
}

export function packagePermissionDecision(settings: SecuritySettings, operation: PackageOperation): PackagePermissionDecision {
	const classification = packageOperationClassification(operation);
	const guarded = classification === "code-execution" || classification === "settings-mutation" || classification === "security-mutation";
	return { operation, classification, approvalRequired: guarded && settings.mutationApproval === "always" };
}

export function assertPackagePermission(settings: SecuritySettings, operation: PackageOperation, approved = false): void {
	if (packagePermissionDecision(settings, operation).approvalRequired && !approved) {
		throw new PackageApprovalRequiredError(operation);
	}
}

export function readSecuritySettings(stateDir: string): SecuritySettings {
	try {
		const value = JSON.parse(readFileSync(join(stateDir, SECURITY_FILE), "utf8")) as {
			mutationApproval?: unknown;
			installApproval?: unknown;
		};
		const stored = value.mutationApproval ?? value.installApproval;
		return MUTATION_APPROVAL_VALUES.includes(stored as MutationApproval)
			? { mutationApproval: stored as MutationApproval }
			: { ...DEFAULT_SECURITY_SETTINGS };
	} catch {
		return { ...DEFAULT_SECURITY_SETTINGS };
	}
}

export function writeSecuritySettings(stateDir: string, settings: SecuritySettings): SecuritySettings {
	if (!MUTATION_APPROVAL_VALUES.includes(settings.mutationApproval)) throw new Error("mutationApproval must be always or never");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const target = join(stateDir, SECURITY_FILE);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
	renameSync(temporary, target);
	return { ...settings };
}
