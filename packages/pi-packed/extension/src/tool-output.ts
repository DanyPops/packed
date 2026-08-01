import type { PackageSummary as Pkg, PackageInfo as PkgInfo } from "@danypops/packed/protocol";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	TOOL_COLLAPSED_PACKAGE_PREVIEW,
	TOOL_DETAILS_MAX_CAPABILITIES,
	TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS,
	TOOL_DETAILS_MAX_KEYWORDS,
	TOOL_DETAILS_MAX_OUTPUT_CHARACTERS,
	TOOL_DETAILS_MAX_PACKAGES,
	TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
	TOOL_MODEL_CONTENT_MAX_CHARACTERS,
} from "./constants.js";

const DETAILS_VERSION = 2 as const;
const MUTATION_OPERATIONS = new Set(["install", "update", "remove"]);
const MUTATION_STATUSES = new Set(["succeeded", "cancelled", "denied"]);
const PACKAGE_SHAPES = new Set(["keyword-only", "manifest", "conventional"]);
const TRUSTED_PUBLISHER_STATES = new Set(["verified", "not-verified", "unknown"]);

export interface PackageSummaryDetails {
	name: string;
	version: string;
	description: string;
	shape: "keyword-only" | "manifest" | "conventional";
	verified: boolean;
}

export interface SearchToolDetails {
	version: typeof DETAILS_VERSION;
	kind: "search";
	operation: "search";
	query: string;
	total: number;
	items: PackageSummaryDetails[];
	truncated: boolean;
}

export interface InfoToolDetails {
	version: typeof DETAILS_VERSION;
	kind: "info";
	operation: "info";
	package: PackageSummaryDetails & {
		homepage?: string;
		repository?: string;
		license?: string;
		keywords: string[];
		capabilities: string[];
		provenance?: string;
		trustedPublisher: "verified" | "not-verified" | "unknown";
	};
}

export interface MutationToolDetails {
	version: typeof DETAILS_VERSION;
	kind: "mutation";
	operation: "install" | "update" | "remove";
	target: string;
	status: "succeeded" | "cancelled" | "denied";
	output: string;
	reloadRequired: boolean;
}

export type PackageToolDetails = SearchToolDetails | InfoToolDetails | MutationToolDetails;

export interface BoundedModelContent {
	text: string;
	truncated: boolean;
	omitted: number;
}

function bounded(value: unknown, maximum: number): string {
	const text = typeof value === "string" ? value : "";
	return text.length <= maximum ? text : text.slice(0, maximum);
}

export function safePackageTarget(value: unknown): string {
	const target = bounded(value, TOOL_DETAILS_MAX_OUTPUT_CHARACTERS);
	const gitPrefix = target.startsWith("git+http://") || target.startsWith("git+https://") ? "git+" : "";
	const candidate = gitPrefix ? target.slice(gitPrefix.length) : target;
	if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) return target;
	try {
		const url = new URL(candidate);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		const safe = url.toString().replace(/\/$/, candidate.endsWith("/") ? "/" : "");
		return `${gitPrefix}${safe}`;
	} catch {
		return `${gitPrefix}https://[invalid-package-source]`;
	}
}

function safeDisplayText(value: unknown, maximum: number): string {
	const text = bounded(value, maximum);
	return text.replace(/(?:git\+)?https?:\/\/[^\s]+/gu, (url) => safePackageTarget(url));
}

export function createModelContent(value: string): BoundedModelContent {
	const safe = safeDisplayText(value, value.length);
	if (safe.length <= TOOL_MODEL_CONTENT_MAX_CHARACTERS) {
		return { text: safe, truncated: false, omitted: 0 };
	}
	let omitted = safe.length - TOOL_MODEL_CONTENT_MAX_CHARACTERS;
	let marker = "";
	let kept = 0;
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const nextMarker = `\n[truncated ${omitted} characters]`;
		const nextKept = Math.max(0, TOOL_MODEL_CONTENT_MAX_CHARACTERS - nextMarker.length);
		const nextOmitted = safe.length - nextKept;
		marker = nextMarker;
		kept = nextKept;
		if (nextOmitted === omitted) break;
		omitted = nextOmitted;
	}
	return { text: `${safe.slice(0, kept)}${marker}`, truncated: true, omitted: safe.length - kept };
}

function packageSummary(pkg: Pkg): PackageSummaryDetails {
	return {
		name: bounded(pkg.name, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS),
		version: bounded(pkg.version, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS),
		description: bounded(pkg.description, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS),
		shape: pkg.packageEvidence?.shape ?? "keyword-only",
		verified: pkg.packageEvidence?.verified === true,
	};
}

export function createSearchDetails(query: string, total: number, packages: Pkg[]): SearchToolDetails {
	return {
		version: DETAILS_VERSION,
		kind: "search",
		operation: "search",
		query: bounded(query, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS),
		total: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : packages.length,
		items: packages.slice(0, TOOL_DETAILS_MAX_PACKAGES).map(packageSummary),
		truncated: packages.length > TOOL_DETAILS_MAX_PACKAGES || total > packages.length,
	};
}

export function createInfoDetails(info: PkgInfo): InfoToolDetails {
	return {
		version: DETAILS_VERSION,
		kind: "info",
		operation: "info",
		package: {
			...packageSummary(info),
			...(info.homepage ? { homepage: safePackageTarget(info.homepage) } : {}),
			...(info.repository ? { repository: safePackageTarget(info.repository) } : {}),
			...(info.license ? { license: bounded(info.license, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS) } : {}),
			keywords: (info.keywords ?? [])
				.slice(0, TOOL_DETAILS_MAX_KEYWORDS)
				.map((keyword) => bounded(keyword, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS)),
			capabilities: Object.keys(info.pi ?? {})
				.slice(0, TOOL_DETAILS_MAX_CAPABILITIES)
				.map((name) => bounded(name, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS)),
			...(info.publication?.provenanceUrl ? { provenance: safePackageTarget(info.publication.provenanceUrl) } : {}),
			trustedPublisher: info.publication?.trustedPublisher ?? "unknown",
		},
	};
}

export function createMutationDetails(
	operation: MutationToolDetails["operation"],
	target: string,
	status: MutationToolDetails["status"],
	output: string,
	// update's reloadRequired is not always "succeeded implies true" -- pi
	// update exits 0 whether or not a pinned/already-latest package actually
	// changed. Callers that know the real outcome (updatePackageWithPolicy)
	// pass it explicitly; install/remove keep the old succeeded-implies-true
	// default, which is accurate for them.
	reloadRequired: boolean = operation === "update" && status === "succeeded",
): MutationToolDetails {
	return {
		version: DETAILS_VERSION,
		kind: "mutation",
		operation,
		target: safePackageTarget(target),
		status,
		output: safeDisplayText(output, TOOL_DETAILS_MAX_OUTPUT_CHARACTERS),
		reloadRequired,
	};
}

function isShortString(value: unknown, maximum = TOOL_DETAILS_MAX_OUTPUT_CHARACTERS): value is string {
	return typeof value === "string" && value.length <= maximum;
}

export function parsePackageToolDetails(value: unknown): PackageToolDetails | undefined {
	try {
		if (!value || typeof value !== "object") return undefined;
		if (JSON.stringify(value).length > TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS) return undefined;
		const candidate = value as Record<string, unknown>;
		if (candidate.version !== DETAILS_VERSION || typeof candidate.kind !== "string") return undefined;
		if (candidate.kind === "search") {
			if (
				candidate.operation !== "search" ||
				!isShortString(candidate.query, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS) ||
				typeof candidate.total !== "number" ||
				!Number.isSafeInteger(candidate.total) ||
				candidate.total < 0 ||
				typeof candidate.truncated !== "boolean"
			)
				return undefined;
			if (!Array.isArray(candidate.items) || candidate.items.length > TOOL_DETAILS_MAX_PACKAGES) return undefined;
			if (!candidate.items.every((item) => isPackageSummary(item))) return undefined;
			return value as SearchToolDetails;
		}
		if (candidate.kind === "info") {
			if (candidate.operation !== "info" || !candidate.package || typeof candidate.package !== "object") return undefined;
			const pkg = candidate.package as Record<string, unknown>;
			if (
				!isPackageSummary(pkg) ||
				!Array.isArray(pkg.keywords) ||
				pkg.keywords.length > TOOL_DETAILS_MAX_KEYWORDS ||
				!pkg.keywords.every((item) => isShortString(item, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS))
			)
				return undefined;
			if (
				!Array.isArray(pkg.capabilities) ||
				pkg.capabilities.length > TOOL_DETAILS_MAX_CAPABILITIES ||
				!pkg.capabilities.every((item) => isShortString(item, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS))
			)
				return undefined;
			for (const field of ["homepage", "repository", "license", "provenance"] as const) {
				if (pkg[field] !== undefined && !isShortString(pkg[field])) return undefined;
			}
			if (typeof pkg.trustedPublisher !== "string" || !TRUSTED_PUBLISHER_STATES.has(pkg.trustedPublisher)) return undefined;
			return value as InfoToolDetails;
		}
		if (candidate.kind === "mutation") {
			if (typeof candidate.operation !== "string" || !MUTATION_OPERATIONS.has(candidate.operation)) return undefined;
			if (typeof candidate.status !== "string" || !MUTATION_STATUSES.has(candidate.status)) return undefined;
			if (!isShortString(candidate.target) || !isShortString(candidate.output) || typeof candidate.reloadRequired !== "boolean")
				return undefined;
			return value as MutationToolDetails;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function isPackageSummary(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		isShortString(item.name, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS) &&
		isShortString(item.version, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS) &&
		isShortString(item.description, TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS) &&
		typeof item.shape === "string" &&
		PACKAGE_SHAPES.has(item.shape) &&
		typeof item.verified === "boolean"
	);
}

function contentFallback(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function renderPackageToolCall(label: string, args: Record<string, unknown>, theme: Theme) {
	const target = safePackageTarget(args.query ?? args.name ?? args.source ?? "");
	return new Text(`${theme.fg("accent", label)}${target ? theme.fg("muted", ` · ${target}`) : ""}`, 0, 0);
}

export function renderPackageToolResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { isPartial: boolean },
) {
	if (options.isPartial || context.isPartial) return new Text(theme.fg("muted", "Working…"), 0, 0);
	const details = parsePackageToolDetails(result.details);
	if (!details) return new Text(contentFallback(result), 0, 0);
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			if (details.kind === "search") {
				const shown = options.expanded ? details.items : details.items.slice(0, TOOL_COLLAPSED_PACKAGE_PREVIEW);
				const heading = `${theme.bold(String(details.total))} packages · showing ${details.items.length}${details.truncated ? " · bounded" : ""}`;
				const rows = shown.map((pkg) => {
					const evidence = pkg.verified ? ` [verified ${pkg.shape}]` : " [keyword candidate]";
					return truncateToWidth(
						`${theme.fg("accent", `${pkg.name}@${pkg.version}`)}${theme.fg("muted", evidence)}${options.expanded && pkg.description ? ` — ${pkg.description}` : ""}`,
						safeWidth,
					);
				});
				if (!options.expanded && details.items.length > shown.length)
					rows.push(theme.fg("muted", `… ${details.items.length - shown.length} more`));
				return [truncateToWidth(heading, safeWidth), ...rows];
			}
			if (details.kind === "info") {
				const pkg = details.package;
				const lines = [theme.bold(`${pkg.name}@${pkg.version}`), pkg.description];
				if (options.expanded) {
					if (pkg.license) lines.push(`license: ${pkg.license}`);
					if (pkg.repository) lines.push(`repository: ${pkg.repository}`);
					if (pkg.homepage) lines.push(`homepage: ${pkg.homepage}`);
					lines.push(`shape: ${pkg.shape}${pkg.verified ? " (tarball verified)" : " (metadata only)"}`);
					if (pkg.provenance) lines.push(`provenance: ${pkg.provenance}`);
					lines.push(`trusted publisher: ${pkg.trustedPublisher}`);
					if (pkg.capabilities.length) lines.push(`provides: ${pkg.capabilities.join(", ")}`);
					if (pkg.keywords.length) lines.push(`keywords: ${pkg.keywords.join(", ")}`);
				}
				return lines.filter(Boolean).map((line) => truncateToWidth(line, safeWidth));
			}
			const statusColor = details.status === "succeeded" ? "success" : "warning";
			const lines = [`${theme.fg(statusColor, details.status === "succeeded" ? "✓" : "○")} ${details.operation} ${details.target}`];
			if (options.expanded && details.output) lines.push(details.output);
			if (details.reloadRequired) lines.push(theme.fg("warning", "Reload Pi with /reload to activate the update."));
			return lines.map((line) => truncateToWidth(line, safeWidth));
		},
		invalidate() {},
	};
}
