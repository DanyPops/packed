import { createHash } from "node:crypto";

export type AgentToolPackageKind = "extension" | "vehicle";
export type AgentToolResourceKind = "extension" | "skill" | "prompt" | "theme" | "vehicle-manifest";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentToolsBlueprintPackage {
	readonly id: string;
	readonly kind: AgentToolPackageKind;
	readonly source: string;
}

export interface AgentToolsBlueprint {
	readonly schemaVersion: 1;
	readonly packages: readonly AgentToolsBlueprintPackage[];
	readonly enabledTools?: readonly string[];
}

export interface AgentToolResource {
	readonly kind: AgentToolResourceKind;
	readonly path: string;
}

export interface AgentToolCompatibility {
	readonly host: string;
	readonly range: string;
}

export interface ResolvedAgentToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonValue;
	readonly permissions: readonly string[];
	readonly limits?: Readonly<Record<string, number>>;
	readonly effects?: readonly string[];
}

export interface ResolvedAgentToolPackage extends AgentToolsBlueprintPackage {
	readonly version: string;
	readonly integrity: string;
	readonly resources: readonly AgentToolResource[];
	readonly permissions: readonly string[];
	readonly compatibility: readonly AgentToolCompatibility[];
	readonly tools: readonly ResolvedAgentToolDescriptor[];
}

export interface LockedAgentToolDescriptor extends ResolvedAgentToolDescriptor {
	readonly owner: string;
}

export interface AgentToolsLock {
	readonly schemaVersion: 1;
	readonly packages: readonly Omit<ResolvedAgentToolPackage, "tools">[];
	readonly tools: readonly LockedAgentToolDescriptor[];
	readonly contentHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
	return sorted;
}

export function hashAgentTools(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function assertUnique(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
		seen.add(value);
	}
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

export function compileAgentToolsLock(
	blueprint: AgentToolsBlueprint,
	resolvedPackages: readonly ResolvedAgentToolPackage[],
): AgentToolsLock {
	assertUnique(
		blueprint.packages.map((entry) => entry.id),
		"blueprint package",
	);
	assertUnique(
		resolvedPackages.map((entry) => entry.id),
		"resolved package",
	);

	const declarations = new Map(blueprint.packages.map((entry) => [entry.id, entry]));
	const resolved = new Map(resolvedPackages.map((entry) => [entry.id, entry]));
	for (const packageId of resolved.keys()) {
		if (!declarations.has(packageId)) throw new Error(`undeclared resolved package: ${packageId}`);
	}
	for (const packageId of declarations.keys()) {
		if (!resolved.has(packageId)) throw new Error(`missing resolved package: ${packageId}`);
	}

	const packages = [...resolvedPackages]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((entry) => {
			const declaration = declarations.get(entry.id)!;
			if (entry.kind !== declaration.kind || entry.source !== declaration.source) {
				throw new Error(`resolved package identity mismatch: ${entry.id}`);
			}
			return {
				id: entry.id,
				kind: entry.kind,
				source: entry.source,
				version: entry.version,
				integrity: entry.integrity,
				resources: [...entry.resources].sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`)),
				permissions: sortedUnique(entry.permissions),
				compatibility: [...entry.compatibility].sort((left, right) =>
					`${left.host}:${left.range}`.localeCompare(`${right.host}:${right.range}`),
				),
			};
		});

	const allTools = resolvedPackages.flatMap((entry) =>
		entry.tools.map((tool) => ({
			...tool,
			owner: entry.id,
			permissions: sortedUnique(tool.permissions),
			effects: tool.effects ? sortedUnique(tool.effects) : undefined,
		})),
	);
	assertUnique(
		allTools.map((tool) => tool.name),
		"tool",
	);
	const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
	const enabledTools = blueprint.enabledTools ?? [...toolsByName.keys()];
	assertUnique(enabledTools, "enabled tool");
	for (const toolName of enabledTools) {
		if (!toolsByName.has(toolName)) throw new Error(`unknown enabled tool: ${toolName}`);
	}
	const tools = enabledTools.map((toolName) => toolsByName.get(toolName)!).sort((left, right) => left.name.localeCompare(right.name));

	const content = { schemaVersion: 1 as const, packages, tools };
	return deepFreeze({ ...content, contentHash: hashAgentTools(content) });
}

export interface SpdxPackage {
	readonly SPDXID: string;
	readonly name: string;
	readonly versionInfo: string;
	readonly externalRefs: readonly {
		readonly referenceCategory: "PACKAGE-MANAGER";
		readonly referenceType: "source";
		readonly referenceLocator: string;
	}[];
	readonly checksums: readonly { readonly algorithm: "SHA512" | "SHA256"; readonly checksumValue: string }[];
}

export interface AgentToolsSpdx {
	readonly spdxVersion: "SPDX-2.3";
	readonly dataLicense: "CC0-1.0";
	readonly SPDXID: "SPDXRef-DOCUMENT";
	readonly name: "agent-tools";
	readonly documentNamespace: string;
	readonly documentDescribes: readonly string[];
	readonly packages: readonly SpdxPackage[];
}

function spdxChecksum(integrity: string): SpdxPackage["checksums"] {
	const match = /^(sha256|sha512)-(.+)$/.exec(integrity);
	if (!match) return [];
	return [{ algorithm: match[1] === "sha256" ? "SHA256" : "SHA512", checksumValue: match[2]! }];
}

export function toSpdx(lock: AgentToolsLock): AgentToolsSpdx {
	const packages = lock.packages.map((entry) => ({
		SPDXID: `SPDXRef-${entry.id.replace(/[^A-Za-z0-9-.]/g, "-")}`,
		name: entry.id,
		versionInfo: entry.version,
		externalRefs: [
			{
				referenceCategory: "PACKAGE-MANAGER" as const,
				referenceType: "source" as const,
				referenceLocator: entry.source,
			},
		],
		checksums: spdxChecksum(entry.integrity),
	}));
	return deepFreeze({
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: "agent-tools",
		documentNamespace: `https://danypops.dev/packed/agent-tools/${lock.contentHash}`,
		documentDescribes: packages.map((entry) => entry.SPDXID),
		packages,
	});
}
