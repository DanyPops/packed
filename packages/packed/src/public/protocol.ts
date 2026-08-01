export interface PackageEvidence {
	shape: "keyword-only" | "manifest" | "conventional";
	verified: boolean;
	evidence: string[];
}
export interface PublicationEvidence {
	integrity?: string;
	provenanceUrl?: string;
	trustedPublisher: "verified" | "not-verified" | "unknown";
}
export interface PackageSummary {
	name: string;
	version: string;
	description?: string;
	date?: string;
	packageEvidence?: PackageEvidence;
	publication?: PublicationEvidence;
}
export interface PackageInfo extends PackageSummary {
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	pi?: Record<string, unknown>;
	modified?: string;
	unpackedSize?: number;
	readme?: string;
	readmeAvailable?: boolean;
	bugs?: string;
	peerDependencies?: Record<string, string>;
}
export interface InstalledPackage {
	name: string;
	pinned?: string;
	installed?: string;
}
export interface UpdateEntry {
	name: string;
	installed: string;
	latest: string;
	detectedAt?: string;
}
export interface UpdateOutcome {
	output: string;
	reloadRequired: boolean;
	alreadyUpToDate: boolean;
	pinned: boolean;
	previousVersion?: string;
	currentVersion?: string;
}
export interface Diagnostic {
	code: string;
	severity: "error" | "warning" | "info";
	path: string;
	message: string;
	fix?: string;
}
export interface SetupOperation {
	kind: "install-package" | "update-package" | "remove-package" | "write-profile" | "remove-profile";
	packageName?: string;
	name?: string;
	scope: "global" | "project";
	source?: string;
	resolved?: string;
	fields?: string[];
}
export interface SetupPlan {
	ok: boolean;
	manifestPath: string;
	operations: SetupOperation[];
	manifestSha256?: string;
	prune?: boolean;
	diagnostics: Diagnostic[];
}
export interface SetupApplyResult {
	ok: boolean;
	manifestPath: string;
	operations: Array<{ kind: SetupOperation["kind"]; target: string; status: "succeeded" | "failed"; output?: string }>;
	reloadRequired: boolean;
	diagnostics: Diagnostic[];
}
export interface SecuritySettings {
	mutationApproval: "always" | "never";
}
export type ResourceField = "extensions" | "skills" | "prompts" | "themes";
export interface ResourceItem {
	path: string;
	enabled: boolean;
}
export type PackageResources = { source: string; name: string; scope: "global" | "project" } & Record<ResourceField, ResourceItem[]>;

export interface ServiceSpecSummary {
	name: string;
	binPath: string;
	descriptorPath: string;
}

/** Mirrors packages/packed/src/pi/pi-version.ts's CURRENT_PI_PACKAGE_NAME
 * literal -- not a shared import, since the public boundary deliberately
 * stays free of internal runtime-specific modules. Keep the two in sync by hand. */
export const PI_COMMAND_NAME = "@earendil-works/pi-coding-agent";

/** Mirrors pi/pi-version.ts's PiVersionReport. */
export interface PiStatus {
	current?: string;
	latest?: string;
	upToDate?: boolean;
	packageName?: string;
	note?: string;
}

export type ExtensionOperationName =
	| "package.search"
	| "package.info"
	| "package.installed"
	| "package.updates"
	| "package.security.get"
	| "package.security.set"
	| "package.install"
	| "package.install_service"
	| "package.remove"
	| "package.update"
	| "setup.plan"
	| "setup.apply"
	| "resources.list"
	| "resources.toggle"
	| "pi.status";
export interface ExtensionOperationInputs {
	"package.search": { query: string; limit: number; offline?: boolean };
	"package.info": { name: string };
	"package.installed": Record<string, never>;
	"package.updates": Record<string, never>;
	"pi.status": Record<string, never>;
	"package.security.get": Record<string, never>;
	"package.security.set": { mutationApproval: SecuritySettings["mutationApproval"]; approved?: boolean };
	"package.install": { source: string; approved?: boolean };
	"package.install_service": { source: string; approved?: boolean };
	"package.remove": { name: string; approved?: boolean };
	"package.update": { source: string; approved?: boolean };
	"setup.plan": { manifestPath: string; prune?: boolean };
	"setup.apply": { manifestPath: string; approved?: boolean; prune?: boolean };
	"resources.list": { projectRoot?: string };
	"resources.toggle": { source: string; field: ResourceField; path: string; enabled: boolean; projectRoot?: string; approved?: boolean };
}
export interface ExtensionOperationOutputs {
	"package.search": { query: string; total: number; results: PackageSummary[]; offline?: boolean };
	"package.info": PackageInfo;
	"package.installed": InstalledPackage[];
	"package.updates": { updates: UpdateEntry[] };
	"package.security.get": SecuritySettings;
	"package.security.set": SecuritySettings;
	"package.install": { ok: boolean; output: string };
	"package.install_service": { ok: boolean; output: string; spec?: ServiceSpecSummary; notADaemon?: boolean };
	"package.remove": { ok: boolean; output: string };
	"package.update": {
		ok: boolean;
		output: string;
		reloadRequired?: boolean;
		alreadyUpToDate?: boolean;
		pinned?: boolean;
		previousVersion?: string;
		currentVersion?: string;
	};
	"setup.plan": SetupPlan;
	"setup.apply": SetupApplyResult;
	"resources.list": { global: PackageResources[]; project: PackageResources[] };
	"resources.toggle": { ok: boolean; output: string };
	"pi.status": PiStatus;
}
