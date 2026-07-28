import { existsSync, lstatSync, opendirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { publint } from "publint";
import { formatMessage } from "publint/utils";
import { runExtensionSmoke, type ExtensionSmokeResult } from "./smoke.ts";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
	code: string;
	severity: DiagnosticSeverity;
	path: string;
	message: string;
	fix?: string;
}

export interface CheckReport {
	root: string;
	ok: boolean;
	diagnostics: Diagnostic[];
	summary: { errors: number; warnings: number; info: number };
	checkedFiles: number;
	truncated: boolean;
	smoke?: { extensions: ExtensionSmokeResult[] };
}

export interface CheckOptions {
	generic?: boolean;
	smoke?: boolean;
	maxDiagnostics?: number;
	maxFiles?: number;
}

export interface PackageChecker {
	check(packagePath: string, options?: CheckOptions): Promise<CheckReport>;
}

export class StaticPackageChecker implements PackageChecker {
	check(packagePath: string, options?: CheckOptions): Promise<CheckReport> {
		return checkPackage(packagePath, options);
	}
}

interface Context {
	root: string;
	pkg: Record<string, unknown>;
	files: string[];
	add(diagnostic: Diagnostic): void;
	markTruncated(): void;
}

type Check = (context: Context) => void | Promise<void>;

const DEFAULT_MAX_DIAGNOSTICS = 200;
const DEFAULT_MAX_FILES = 2_000;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_GENERIC_BYTES = 5 * 1024 * 1024;
const MAX_HUMAN_OUTPUT = 8_000;
const MAX_JSON_OUTPUT = 32_000;
const CORE_PACKAGES = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const RESOURCE_EXTENSIONS: Record<(typeof RESOURCE_FIELDS)[number], RegExp> = {
	extensions: /\.[cm]?[jt]s$/,
	skills: /(?:SKILL\.md|\.md)$/i,
	prompts: /\.md$/i,
	themes: /\.json$/i,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredBundledRoots(pkg: Record<string, unknown>): string[] {
	if (!isRecord(pkg.pi)) return [];
	const roots = new Set<string>();
	for (const field of RESOURCE_FIELDS) {
		for (const raw of patternsFor(pkg.pi[field]) ?? []) {
			const normalized = normalizePattern(raw.replace(/^!/, ""));
			if (!normalized.startsWith("node_modules/")) continue;
			const parts = normalized.split("/");
			roots.add(parts[1]!.startsWith("@") ? parts.slice(0, 3).join("/") : parts.slice(0, 2).join("/"));
		}
	}
	return [...roots];
}

export function walk(root: string, maxFiles: number, bundledRoots: string[]): { files: string[]; truncated: boolean } {
	const files: string[] = [];
	const queue = [root];
	const maxEntries = maxFiles * 4;
	let visitedEntries = 0;
	while (queue.length > 0) {
		const directory = queue.shift()!;
		const handle = opendirSync(directory);
		try {
			let entry;
			while ((entry = handle.readSync()) !== null) {
				visitedEntries++;
				if (visitedEntries > maxEntries) return { files, truncated: true };
				if (entry.name === ".git") continue;
				if (entry.name === "node_modules" && directory === root) {
					for (const bundledRoot of bundledRoots) {
						const absolute = join(root, bundledRoot);
						if (existsSync(absolute)) queue.push(absolute);
					}
					continue;
				}
				if (entry.name === "node_modules") continue;
				const absolute = join(directory, entry.name);
				const path = relative(root, absolute).split(sep).join("/");
				if (entry.isDirectory()) queue.push(absolute);
				else {
					files.push(path);
					if (files.length >= maxFiles) return { files, truncated: true };
				}
			}
		} finally {
			handle.closeSync();
		}
	}
	return { files, truncated: false };
}

function patternsFor(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function normalizePattern(pattern: string): string {
	return pattern.replace(/^\.\//, "").replaceAll("\\", "/");
}

function hasMagic(pattern: string): boolean {
	return /[*?{[\]]/.test(pattern);
}

function isValidGlob(pattern: string): boolean {
	for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
		let depth = 0;
		for (let index = 0; index < pattern.length; index++) {
			if (pattern[index] === "\\") { index++; continue; }
			if (pattern[index] === open) depth++;
			if (pattern[index] === close && --depth < 0) return false;
		}
		if (depth !== 0) return false;
	}
	try { new Bun.Glob(pattern); return true; } catch { return false; }
}

export function matchesPattern(file: string, pattern: string): boolean {
	const normalized = normalizePattern(pattern);
	if (!hasMagic(normalized)) return file === normalized || file.startsWith(`${normalized.replace(/\/$/, "")}/`);
	return new Bun.Glob(normalized).match(file);
}

export function isContainedFile(root: string, file: string): boolean {
	try {
		const target = realpathSync(join(root, file));
		return target.startsWith(`${root}${sep}`);
	} catch {
		return false;
	}
}

function resolvePatterns(files: string[], patterns: string[]): string[] {
	const selected = new Set<string>();
	for (const raw of patterns) {
		const exclude = raw.startsWith("!");
		const pattern = exclude ? raw.slice(1) : raw;
		for (const file of files) {
			if (!matchesPattern(file, pattern)) continue;
			if (exclude) selected.delete(file);
			else selected.add(file);
		}
	}
	return [...selected];
}

function shippedFiles(context: Context): string[] {
	const configured = patternsFor(context.pkg.files);
	if (!configured) return context.files;
	const selected = new Set(resolvePatterns(context.files, configured));
	for (const file of context.files) {
		if (file === "package.json" || /^readme(?:\.|$)/i.test(basename(file)) || /^(?:licen[cs]e|copying)(?:\.|$)/i.test(basename(file))) selected.add(file);
	}
	return [...selected];
}

function manifestCheck(context: Context): void {
	const { pkg, add } = context;
	if (typeof pkg.name !== "string" || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name)) {
		add({ code: "PKG_NAME_INVALID", severity: "error", path: "package.json#name", message: "name must be a valid lowercase npm package name" });
	}
	if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
		add({ code: "PKG_VERSION_INVALID", severity: "error", path: "package.json#version", message: "version must be valid SemVer" });
	}
	for (const [field, code] of [["license", "PKG_LICENSE_MISSING"], ["repository", "PKG_REPOSITORY_MISSING"], ["homepage", "PKG_HOMEPAGE_MISSING"], ["bugs", "PKG_BUGS_MISSING"]] as const) {
		if (pkg[field] === undefined) add({ code, severity: "warning", path: `package.json#${field}`, message: `${field} metadata is missing` });
	}
	const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
	if (!keywords.includes("pi-package")) add({ code: "PI_KEYWORD_MISSING", severity: "warning", path: "package.json#keywords", message: "add pi-package for Pi gallery discovery", fix: "Add pi-package to keywords." });
	if (!context.files.some((file) => /^readme(?:\.|$)/i.test(basename(file)))) add({ code: "PACKAGE_README_MISSING", severity: "warning", path: "README.md", message: "the package has no README" });
	if (!context.files.some((file) => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(basename(file)))) add({ code: "PACKAGE_LICENSE_FILE_MISSING", severity: "warning", path: "LICENSE", message: "the package has no license file" });
}

/** Resolves a resource field's configured or default patterns without
 * validating or diagnosing them -- undefined means "this field does not
 * apply" (an explicit pi manifest exists but omits the field). */
function resourceFieldPatterns(pi: unknown, field: (typeof RESOURCE_FIELDS)[number]): string[] | undefined {
	const configured = isRecord(pi) ? pi[field] : undefined;
	if (configured !== undefined) return patternsFor(configured);
	if (pi === undefined) return [`${field}/`];
	return undefined;
}

/** Matches a resource field's patterns against the file list and applies
 * the extension filter -- containment is the caller's call (diagnosed as
 * an error in resourcesCheck, silently dropped in discoverPackageResources). */
function matchResourceFiles(files: string[], field: (typeof RESOURCE_FIELDS)[number], patterns: string[]): string[] {
	let matched: string[] = [];
	try { matched = resolvePatterns(files, patterns.filter((pattern) => !pattern.includes("..") && !isAbsolute(pattern) && isValidGlob(normalizePattern(pattern.replace(/^!/, ""))))); } catch { /* invalid glob already reported */ }
	return matched.filter((file) => RESOURCE_EXTENSIONS[field].test(file));
}

export type ResourceField = (typeof RESOURCE_FIELDS)[number];

/** Pure discovery: which shipped files a package's own manifest (or
 * conventional-directory fallback) declares as extensions/skills/prompts/
 * themes, after the same extension-type and containment filtering
 * resourcesCheck diagnoses -- without the diagnostics. Used by the
 * package-resource overlay to know what there is to enable or disable. */
export function discoverPackageResources(root: string, pkg: Record<string, unknown>, files: string[]): Record<ResourceField, string[]> {
	const pi = pkg.pi;
	const result = {} as Record<ResourceField, string[]>;
	if (pi !== undefined && !isRecord(pi)) {
		for (const field of RESOURCE_FIELDS) result[field] = [];
		return result;
	}
	for (const field of RESOURCE_FIELDS) {
		const patterns = resourceFieldPatterns(pi, field);
		result[field] = patterns ? matchResourceFiles(files, field, patterns).filter((file) => isContainedFile(root, file)) : [];
	}
	return result;
}

function resourcesCheck(context: Context): void {
	const pi = context.pkg.pi;
	let resourceCount = 0;
	if (pi !== undefined && !isRecord(pi)) {
		context.add({ code: "PI_MANIFEST_INVALID", severity: "error", path: "package.json#pi", message: "pi must be an object" });
		return;
	}
	for (const field of RESOURCE_FIELDS) {
		const configured = isRecord(pi) ? pi[field] : undefined;
		let patterns: string[];
		if (configured !== undefined) {
			const parsed = patternsFor(configured);
			if (!parsed) {
				context.add({ code: "PI_MANIFEST_FIELD_INVALID", severity: "error", path: `package.json#pi.${field}`, message: `${field} must be an array of glob strings` });
				continue;
			}
			patterns = parsed;
		} else if (pi === undefined) {
			patterns = [`${field}/`];
		} else {
			continue;
		}
		for (const raw of patterns) {
			const pattern = raw.startsWith("!") ? raw.slice(1) : raw;
			const normalized = normalizePattern(pattern);
			if (isAbsolute(normalized) || normalized.split("/").includes("..")) {
				context.add({ code: "PI_RESOURCE_OUTSIDE_PACKAGE", severity: "error", path: `package.json#pi.${field}`, message: `resource pattern escapes the package: ${raw}` });
				continue;
			}
			if (!isValidGlob(normalized)) context.add({ code: "PI_RESOURCE_GLOB_INVALID", severity: "error", path: `package.json#pi.${field}`, message: `invalid resource glob: ${raw}` });
		}
		const matched = matchResourceFiles(context.files, field, patterns).filter((file) => {
			if (isContainedFile(context.root, file)) return true;
			context.add({ code: "PI_RESOURCE_OUTSIDE_PACKAGE", severity: "error", path: file, message: `resource resolves outside the package: ${file}` });
			return false;
		});
		resourceCount += matched.length;
		const packageFiles = patternsFor(context.pkg.files);
		if (packageFiles) {
			for (const file of matched) {
				if (!resolvePatterns([file], packageFiles).includes(file)) context.add({ code: "PI_RESOURCE_NOT_PUBLISHED", severity: "error", path: file, message: "declared Pi resource is excluded by package.json files" });
			}
		}
		const dependencies = isRecord(context.pkg.dependencies) ? context.pkg.dependencies : {};
		const bundled = Array.isArray(context.pkg.bundledDependencies) ? context.pkg.bundledDependencies : Array.isArray(context.pkg.bundleDependencies) ? context.pkg.bundleDependencies : [];
		for (const raw of patterns) {
			const normalized = normalizePattern(raw.replace(/^!/, ""));
			if (!normalized.startsWith("node_modules/")) continue;
			const parts = normalized.slice("node_modules/".length).split("/");
			const dependency = parts[0]!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
			if (dependencies[dependency] === undefined || !bundled.includes(dependency)) context.add({ code: "PI_PACKAGE_NOT_BUNDLED", severity: "error", path: `package.json#pi.${field}`, message: `${dependency} resources require dependencies plus bundledDependencies` });
		}
		if (patterns.some((pattern) => !pattern.startsWith("!")) && matched.length === 0) {
			context.add({ code: "PI_RESOURCE_NO_MATCH", severity: "error", path: `package.json#pi.${field}`, message: `${field} patterns match no supported resources` });
		}
	}
	if (resourceCount === 0) context.add({ code: "PI_NO_RESOURCES", severity: "error", path: "package.json#pi", message: "package declares or contains no Pi resources" });
	if (isRecord(pi)) {
		if (pi.image !== undefined && typeof pi.image !== "string") context.add({ code: "PI_IMAGE_INVALID", severity: "error", path: "package.json#pi.image", message: "gallery image must be a URL string" });
		else if (typeof pi.image === "string" && !/\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(pi.image)) context.add({ code: "PI_IMAGE_FORMAT_INVALID", severity: "error", path: "package.json#pi.image", message: "gallery image must be PNG, JPEG, GIF, or WebP" });
		if (pi.video !== undefined && typeof pi.video !== "string") context.add({ code: "PI_VIDEO_INVALID", severity: "error", path: "package.json#pi.video", message: "gallery video must be a URL string" });
		else if (typeof pi.video === "string" && !/\.mp4(?:[?#].*)?$/i.test(pi.video)) context.add({ code: "PI_VIDEO_FORMAT_INVALID", severity: "error", path: "package.json#pi.video", message: "gallery video must be MP4" });
	}
}

// Mirrors cleanup.ts's own MAX_CLEANUP_ENTRIES/MAX_CLEANUP_PATH_BYTES --
// duplicated as plain literals rather than imported to avoid a circular
// module dependency (cleanup.ts already imports isContainedFile from here).
const MAX_CLEANUP_ENTRIES = 50;
const MAX_CLEANUP_PATH_BYTES = 512;

/** Statically validates an optional pi.cleanup declaration at authoring
 * time, before a package is ever installed or removed -- the same
 * escape discipline packed remove itself enforces at removal time
 * (cleanup.ts's runCleanup), just catchable earlier via packed check. */
function cleanupManifestCheck(context: Context): void {
	const pi = context.pkg.pi;
	if (!isRecord(pi) || pi.cleanup === undefined) return;
	const declared = pi.cleanup;
	if (!Array.isArray(declared) || !declared.every((item) => typeof item === "string")) {
		context.add({ code: "PI_CLEANUP_INVALID", severity: "error", path: "package.json#pi.cleanup", message: "pi.cleanup must be an array of relative path strings" });
		return;
	}
	if (declared.length > MAX_CLEANUP_ENTRIES) {
		context.add({ code: "PI_CLEANUP_TOO_LARGE", severity: "warning", path: "package.json#pi.cleanup", message: `pi.cleanup declares ${declared.length} entries; only the first ${MAX_CLEANUP_ENTRIES} are honored at removal time` });
	}
	for (const raw of declared) {
		if (raw.length > MAX_CLEANUP_PATH_BYTES) {
			context.add({ code: "PI_CLEANUP_TOO_LARGE", severity: "warning", path: "package.json#pi.cleanup", message: `pi.cleanup entry exceeds ${MAX_CLEANUP_PATH_BYTES} characters and will be ignored at removal time: ${raw.slice(0, 80)}...` });
			continue;
		}
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			context.add({ code: "PI_CLEANUP_ESCAPES_PACKAGE", severity: "error", path: "package.json#pi.cleanup", message: "pi.cleanup entries must not be empty" });
		} else if (isAbsolute(trimmed) || trimmed.split("/").includes("..")) {
			context.add({ code: "PI_CLEANUP_ESCAPES_PACKAGE", severity: "error", path: "package.json#pi.cleanup", message: `pi.cleanup entry escapes the package and will never be removed: ${raw}` });
		}
	}
}

function dependencyCheck(context: Context): void {
	const dependencies = isRecord(context.pkg.dependencies) ? context.pkg.dependencies : {};
	const optional = isRecord(context.pkg.optionalDependencies) ? context.pkg.optionalDependencies : {};
	const peers = isRecord(context.pkg.peerDependencies) ? context.pkg.peerDependencies : {};
	const dev = isRecord(context.pkg.devDependencies) ? context.pkg.devDependencies : {};
	for (const core of CORE_PACKAGES) {
		if (dependencies[core] !== undefined || optional[core] !== undefined || (peers[core] !== undefined && peers[core] !== "*")) {
			context.add({ code: "PI_CORE_DEPENDENCY_PLACEMENT", severity: "error", path: `package.json#peerDependencies.${core}`, message: `${core} must be a peerDependency with range *` });
		}
	}
	for (const file of shippedFiles(context).filter((path) => /\.[cm]?[jt]s$/.test(path) && isContainedFile(context.root, path))) {
		const absolute = join(context.root, file);
		if (lstatSync(absolute).size > MAX_SOURCE_BYTES) continue;
		const source = readFileSync(absolute, "utf8");
		for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
			const specifier = match[1]!;
			if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
			const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
			if (CORE_PACKAGES.has(name)) {
				if (peers[name] !== "*") context.add({ code: "PI_CORE_DEPENDENCY_PLACEMENT", severity: "error", path: file, message: `${name} must be declared as peerDependencies[${name}] = *` });
			} else if (dependencies[name] === undefined && optional[name] === undefined) {
				const misplaced = dev[name] !== undefined ? "devDependency" : peers[name] !== undefined ? "peerDependency" : undefined;
				context.add({ code: "RUNTIME_DEPENDENCY_MISSING", severity: "error", path: file, message: `${name} is imported by shipped code but is not in dependencies${misplaced ? `; it is only a ${misplaced}` : ""}` });
			}
		}
	}
}

function parseFrontmatter(source: string): Record<string, string> {
	if (!source.startsWith("---\n")) return {};
	const end = source.indexOf("\n---", 4);
	if (end < 0) return {};
	const fields: Record<string, string> = {};
	for (const line of source.slice(4, end).split("\n")) {
		const match = /^([a-zA-Z0-9-]+):\s*(.*)$/.exec(line);
		if (match) fields[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, "");
	}
	return fields;
}

function skillsCheck(context: Context): void {
	for (const file of context.files.filter((path) => (basename(path) === "SKILL.md" || /^skills\/[^/]+\.md$/.test(path)) && isContainedFile(context.root, path))) {
		const source = readFileSync(join(context.root, file), "utf8");
		const fields = parseFrontmatter(source);
		if (typeof fields.name !== "string" || !/^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/.test(fields.name)) context.add({ code: "SKILL_NAME_INVALID", severity: "error", path: file, message: "skill name must use 1-64 lowercase letters, numbers, and single hyphens" });
		if (!fields.description) context.add({ code: "SKILL_DESCRIPTION_MISSING", severity: "error", path: file, message: "skill frontmatter requires a description" });
		else if (fields.description.length > 1024) context.add({ code: "SKILL_DESCRIPTION_TOO_LONG", severity: "warning", path: file, message: "skill description exceeds 1024 characters" });
		const references = new Set<string>();
		for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) references.add(match[1]!.split("#")[0]!);
		for (const match of source.matchAll(/`((?:scripts|references?|assets)\/[^`\s]+)`/g)) references.add(match[1]!);
		for (const target of references) {
			if (!target || /^(?:[a-z]+:|#|\/)/i.test(target)) continue;
			let decoded: string;
			try { decoded = decodeURIComponent(target); } catch {
				context.add({ code: "SKILL_REFERENCE_INVALID", severity: "error", path: file, message: `skill reference is not a valid path: ${target}` });
				continue;
			}
			const absolute = resolve(context.root, dirname(file), decoded);
			if (!absolute.startsWith(`${context.root}${sep}`) || !existsSync(absolute)) context.add({ code: "SKILL_REFERENCE_MISSING", severity: "error", path: file, message: `skill reference does not exist: ${target}` });
		}
	}
}

function extensionFiles(context: Context): string[] {
	const pi = isRecord(context.pkg.pi) ? context.pkg.pi : undefined;
	const configured = patternsFor(pi?.extensions);
	return (configured ? resolvePatterns(context.files, configured) : context.files.filter((path) => /^extensions\/.*\.[cm]?[jt]s$/.test(path)))
		.filter((path) => /\.[cm]?[jt]s$/.test(path) && isContainedFile(context.root, path));
}

function extensionsCheck(context: Context): void {
	const extensions = extensionFiles(context);
	for (const file of extensions) {
		const absolute = join(context.root, file);
		if (lstatSync(absolute).size > MAX_SOURCE_BYTES) continue;
		const source = readFileSync(absolute, "utf8");
		if (!/export\s+default\s+(?:async\s+)?(?:function|\(?[A-Za-z_$][\w$]*\)?\s*=>)/.test(source)) context.add({ code: "PI_EXTENSION_DEFAULT_EXPORT_MISSING", severity: "error", path: file, message: "extension must statically expose a default factory export" });
		if (!/\.register(?:Tool|Command|Shortcut|Flag|MessageRenderer|Provider)\s*\(|\.on\s*\(/.test(source)) context.add({ code: "PI_EXTENSION_REGISTRATION_NOT_DETECTED", severity: "info", path: file, message: "no statically recognizable Pi registration was found" });
	}
}

async function genericCheck(context: Context): Promise<void> {
	try {
		const files = [];
		let totalBytes = 0;
		for (const name of shippedFiles(context)) {
			if (!isContainedFile(context.root, name)) continue;
			const size = lstatSync(join(context.root, name)).size;
			if (size > MAX_SOURCE_BYTES || totalBytes + size > MAX_GENERIC_BYTES) {
				context.markTruncated();
				context.add({ code: "NPM_INPUT_TRUNCATED", severity: "warning", path: name, message: "file was omitted from generic npm checks by the static input bound" });
				continue;
			}
			const data = readFileSync(join(context.root, name));
			totalBytes += data.byteLength;
			files.push({ name: `package/${name}`, data });
		}
		const result = await publint({ pkgDir: "package", pack: { files }, level: "suggestion" });
		for (const message of result.messages) {
			context.add({
				code: `NPM_${message.code}`,
				severity: message.type === "error" ? "error" : message.type === "warning" ? "warning" : "info",
				path: message.path.length > 0 ? `package.json#${message.path.join(".")}` : "package.json",
				message: formatMessage(message, result.pkg, { color: false }) ?? message.code,
			});
		}
	} catch (error) {
		context.add({ code: "NPM_PUBLINT_FAILED", severity: "warning", path: "package.json", message: `publint failed: ${error instanceof Error ? error.message : String(error)}` });
	}
}

export async function checkPackage(packagePath: string, options: CheckOptions = {}): Promise<CheckReport> {
	const requestedRoot = resolve(packagePath);
	let root: string;
	try {
		root = realpathSync(requestedRoot);
		if (!lstatSync(root).isDirectory()) throw new Error("path is not a directory");
	} catch (error) {
		const diagnostic: Diagnostic = { code: "PKG_PATH_INVALID", severity: "error", path: requestedRoot, message: `cannot inspect package path: ${error instanceof Error ? error.message : String(error)}` };
		return { root: requestedRoot, ok: false, diagnostics: [diagnostic], summary: { errors: 1, warnings: 0, info: 0 }, checkedFiles: 0, truncated: false };
	}
	const maxDiagnostics = Math.max(1, Math.min(options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS, 1_000));
	const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, 10_000));
	const manifestPath = join(root, "package.json");
	let pkg: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (!isRecord(parsed)) throw new Error("root must be an object");
		pkg = parsed;
	} catch (error) {
		const diagnostic: Diagnostic = { code: "PKG_JSON_INVALID", severity: "error", path: "package.json", message: `cannot parse package.json: ${error instanceof Error ? error.message : String(error)}` };
		return { root, ok: false, diagnostics: [diagnostic], summary: { errors: 1, warnings: 0, info: 0 }, checkedFiles: 0, truncated: false };
	}
	const walked = walk(root, maxFiles, declaredBundledRoots(pkg));
	const diagnostics: Diagnostic[] = [];
	const totals = { errors: 0, warnings: 0, info: 0 };
	let diagnosticOverflow = false;
	const context: Context = {
		root,
		pkg,
		files: walked.files,
		markTruncated() { diagnosticOverflow = true; },
		add(diagnostic) {
			if (diagnostic.severity === "error") totals.errors++;
			else if (diagnostic.severity === "warning") totals.warnings++;
			else totals.info++;
			const bounded = { ...diagnostic, path: diagnostic.path.slice(0, 512), message: diagnostic.message.slice(0, 1_000), fix: diagnostic.fix?.slice(0, 1_000) };
			if (diagnostics.length < maxDiagnostics) diagnostics.push(bounded);
			else diagnosticOverflow = true;
		},
	};
	const checks: Check[] = [manifestCheck, resourcesCheck, cleanupManifestCheck, dependencyCheck, skillsCheck, extensionsCheck];
	if (options.generic !== false) checks.push(genericCheck);
	for (const check of checks) await check(context);
	let smoke: CheckReport["smoke"];
	if (options.smoke) {
		const extensions = extensionFiles(context).slice(0, 10);
		if (extensionFiles(context).length > extensions.length) context.markTruncated();
		const results: ExtensionSmokeResult[] = [];
		for (const file of extensions) {
			const result = await runExtensionSmoke(root, join(root, file));
			results.push(result);
			const suffix = result.status.replaceAll("-", "_").toUpperCase();
			context.add({
				code: `PI_EXTENSION_SMOKE_${suffix}`,
				severity: result.status === "ok" ? "info" : "error",
				path: file,
				message: result.status === "ok" ? `extension loaded; registrations: ${JSON.stringify(result.registrations)}` : result.message ?? `extension smoke failed: ${result.status}`,
			});
		}
		smoke = { extensions: results };
	}
	const severityRank: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
	diagnostics.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.code.localeCompare(b.code) || a.path.localeCompare(b.path));
	return { root, ok: totals.errors === 0, diagnostics, summary: totals, checkedFiles: walked.files.length, truncated: walked.truncated || diagnosticOverflow, ...(smoke ? { smoke } : {}) };
}

export function formatCheckReport(report: CheckReport, json: boolean): string {
	if (json) {
		let diagnostics = report.diagnostics;
		let output = JSON.stringify(report);
		while (output.length + 1 > MAX_JSON_OUTPUT && diagnostics.length > 0) {
			diagnostics = diagnostics.slice(0, Math.floor(diagnostics.length / 2));
			output = JSON.stringify({ ...report, diagnostics, truncated: true });
		}
		if (output.length + 1 > MAX_JSON_OUTPUT) output = JSON.stringify({ root: report.root.slice(0, 4_096), ok: report.ok, diagnostics: [], summary: report.summary, checkedFiles: report.checkedFiles, truncated: true });
		return `${output}\n`;
	}
	let output = `${report.ok ? "PASS" : "FAIL"} ${report.root} — ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.info} info\n`;
	for (const diagnostic of report.diagnostics) output += `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}${diagnostic.fix ? ` Fix: ${diagnostic.fix}` : ""}\n`;
	if (report.truncated) output += "Output truncated by configured bounds.\n";
	return output.slice(0, MAX_HUMAN_OUTPUT);
}
