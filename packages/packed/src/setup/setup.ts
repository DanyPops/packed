import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { Diagnostic } from "../adoption/check.ts";
import { npmPackageName, readResolvedIntegrity, readResolvedVersion } from "../packages/installed.ts";
import type { Installer, Registry } from "../packages/package.ts";
import { writeJsonAtomic } from "../shared/atomic-json.ts";

export const SETUP_MANIFEST_FILE = "pi-setup.json";
export const SETUP_SCHEMA_PATH = "./schema/pi-setup-v1.schema.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROFILE_FILE_BYTES = 256 * 1024;
const MAX_PACKAGES = 20;
const MAX_PROFILES = 100;
const MAX_OPERATION_OUTPUT = 1_000;
const SECRET_PATTERN =
	/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+)/i;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT = /^[a-f0-9]{40}$/i;

const String128 = Type.String({ minLength: 1, maxLength: 128 });
const String256 = Type.String({ minLength: 1, maxLength: 256 });
const ScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const ProfileSchema = Type.Object(
	{
		scope: ScopeSchema,
		provider: Type.Optional(String128),
		model: Type.Optional(String256),
		thinkingLevel: Type.Optional(
			Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value))),
		),
		tools: Type.Optional(Type.Array(String128, { maxItems: 100, uniqueItems: true })),
		instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
		theme: Type.Optional(String128),
		allowedModels: Type.Optional(Type.Array(String256, { maxItems: 100, uniqueItems: true })),
	},
	{ additionalProperties: false },
);
const NpmPackageSchema = Type.Object(
	{
		kind: Type.Literal("npm"),
		scope: ScopeSchema,
		source: Type.String({ minLength: 5, maxLength: 512, pattern: "^npm:" }),
		resolved: String128,
		integrity: Type.String({ minLength: 8, maxLength: 512, pattern: "^sha(?:256|384|512)-[A-Za-z0-9+/=_-]+$" }),
	},
	{ additionalProperties: false },
);
const GitPackageSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("git"), Type.Literal("https")]),
		scope: ScopeSchema,
		requested: Type.String({ minLength: 8, maxLength: 1_024 }),
		source: Type.String({ minLength: 8, maxLength: 1_024 }),
		resolved: Type.String({ pattern: "^[a-fA-F0-9]{40}$" }),
	},
	{ additionalProperties: false },
);
const LocalPackageSchema = Type.Object(
	{
		kind: Type.Literal("local"),
		scope: ScopeSchema,
		source: Type.String({ minLength: 1, maxLength: 1_024 }),
		resolved: Type.String({ minLength: 1, maxLength: 1_024 }),
		machineLocal: Type.Literal(true),
	},
	{ additionalProperties: false },
);
export const SetupManifestSchema = Type.Object(
	{
		$schema: Type.Literal(SETUP_SCHEMA_PATH),
		schemaVersion: Type.Literal(1),
		packages: Type.Array(Type.Union([NpmPackageSchema, GitPackageSchema, LocalPackageSchema]), { maxItems: MAX_PACKAGES }),
		profiles: Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }), ProfileSchema, {
			maxProperties: MAX_PROFILES,
			additionalProperties: false,
		}),
		defaultProfile: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })),
	},
	{ additionalProperties: false },
);
const ManifestValidator = Compile(SetupManifestSchema);

export type SetupScope = "global" | "project";
export type SetupPackage =
	| { kind: "npm"; scope: SetupScope; source: string; resolved: string; integrity: string }
	| { kind: "git" | "https"; scope: SetupScope; requested: string; source: string; resolved: string }
	| { kind: "local"; scope: SetupScope; source: string; resolved: string; machineLocal: true };
export interface SetupProfile {
	scope: SetupScope;
	provider?: string;
	model?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: string[];
	instructions?: string;
	theme?: string;
	allowedModels?: string[];
}
export interface SetupManifest {
	$schema: typeof SETUP_SCHEMA_PATH;
	schemaVersion: 1;
	packages: SetupPackage[];
	profiles: Record<string, SetupProfile>;
	defaultProfile?: string;
}
export type SetupOperation =
	| { kind: "install-package" | "update-package"; packageName: string; scope: SetupScope; source: string; resolved: string }
	| { kind: "remove-package"; packageName: string; scope: SetupScope; source: string }
	| { kind: "write-profile" | "remove-profile"; name: string; scope: SetupScope; fields: string[] };
export interface SetupExportReport {
	ok: boolean;
	path: string;
	manifest: SetupManifest;
	diagnostics: Diagnostic[];
	wrote: boolean;
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
export interface SetupUpdateReport extends SetupExportReport {
	updated: number;
}
export interface GitResolutionPort {
	resolve(source: string): Promise<{ commit: string; source: string }>;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximum) {
				await reader.cancel();
				throw new Error(`process output exceeded ${maximum} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

class GitLsRemoteResolver implements GitResolutionPort {
	async resolve(source: string): Promise<{ commit: string; source: string }> {
		const { clone, ref } = splitGitSource(source);
		const proc = Bun.spawn(["git", "ls-remote", clone, ref ?? "HEAD"], {
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(30_000),
		});
		const [stdout, stderr, code] = await Promise.all([
			readBoundedStream(proc.stdout, 64 * 1024),
			readBoundedStream(proc.stderr, 64 * 1024),
			proc.exited,
		]);
		if (code !== 0) throw new Error((stderr || stdout || `git exited ${code}`).slice(0, 2_000));
		const commit = stdout.trim().split(/\s+/)[0] ?? "";
		if (!COMMIT.test(commit)) throw new Error("git ref did not resolve to one commit");
		return { commit, source: immutableGitSource(source, commit) };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}
export function canonicalSetupManifest(manifest: SetupManifest): string {
	return `${JSON.stringify(stableValue(manifest), null, 2)}\n`;
}

function sourceHasCredentials(source: string): boolean {
	try {
		const url = new URL(source.replace(/^git:/, ""));
		return Boolean(url.username || url.password || url.search);
	} catch {
		return /(?:https?:\/\/)[^/@\s]+@/i.test(source);
	}
}
function sourceKind(source: string): SetupPackage["kind"] {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:")) return "git";
	if (/^https:\/\//.test(source)) return "https";
	return "local";
}
function splitGitSource(source: string): { clone: string; ref?: string } {
	const raw = source.replace(/^git:/, "");
	const at = raw.lastIndexOf("@");
	const pathStart = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf(":"));
	const hasRef = at > pathStart;
	return { clone: hasRef ? raw.slice(0, at) : raw, ref: hasRef ? raw.slice(at + 1) : undefined };
}
function immutableGitSource(source: string, commit: string): string {
	const { clone } = splitGitSource(source);
	return `${source.startsWith("git:") ? "git:" : ""}${clone}@${commit}`;
}
function packageIdentity(source: string, scope: SetupScope, _root: string): string {
	const kind = sourceKind(source);
	if (kind === "npm") return `${scope}:npm:${npmPackageName(source) ?? source}`;
	if (kind === "local") return `${scope}:local:${source}`;
	return `${scope}:git:${splitGitSource(source).clone.replace(/\.git$/, "")}`;
}

export function decodeSetupManifest(text: string): SetupManifest {
	if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new Error("SETUP_MANIFEST_TOO_LARGE: manifest exceeds 1 MiB");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`SETUP_MANIFEST_JSON_INVALID: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!ManifestValidator.Check(value)) {
		const first = ManifestValidator.Errors(value)[0];
		throw new Error(`SETUP_MANIFEST_SCHEMA_INVALID: ${first?.instancePath || "/"} ${first?.message ?? "invalid manifest"}`);
	}
	const manifest = value as SetupManifest;
	if (manifest.defaultProfile && !manifest.profiles[manifest.defaultProfile])
		throw new Error("SETUP_DEFAULT_PROFILE_UNKNOWN: defaultProfile must name a declared profile");
	const identities = new Set<string>();
	for (const pkg of manifest.packages) {
		if (sourceHasCredentials(pkg.source) || (pkg.kind !== "npm" && pkg.kind !== "local" && sourceHasCredentials(pkg.requested)))
			throw new Error("SETUP_CREDENTIAL_SOURCE: credential-bearing package sources are forbidden");
		if (pkg.kind !== sourceKind(pkg.source)) throw new Error(`SETUP_SOURCE_KIND_MISMATCH: ${pkg.source}`);
		if ((pkg.kind === "git" || pkg.kind === "https") && (!COMMIT.test(pkg.resolved) || splitGitSource(pkg.source).ref !== pkg.resolved))
			throw new Error(`SETUP_GIT_NOT_IMMUTABLE: ${pkg.source}`);
		if (pkg.kind === "local" && (!pkg.machineLocal || !isAbsolute(pkg.resolved)))
			throw new Error(`SETUP_LOCAL_NOT_MACHINE_LOCAL: ${pkg.source}`);
		const identity = packageIdentity(pkg.source, pkg.scope, pkg.resolved);
		if (identities.has(identity)) throw new Error(`SETUP_PACKAGE_DUPLICATE: ${pkg.source}`);
		identities.add(identity);
	}
	for (const [name, profile] of Object.entries(manifest.profiles)) {
		if (!PROFILE_NAME.test(name)) throw new Error(`SETUP_PROFILE_NAME_INVALID: ${name}`);
		if (profile.instructions && SECRET_PATTERN.test(profile.instructions))
			throw new Error(`SETUP_PROFILE_SECRET: profile ${name} instructions contain secret-like material`);
	}
	return manifest;
}

function readBoundedJson(path: string, maxBytes: number): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SETUP_PATH_UNSAFE: ${path} must be a regular file`);
	if (stat.size > maxBytes) throw new Error(`SETUP_FILE_TOO_LARGE: ${path}`);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`SETUP_FILE_INVALID: ${path} must contain an object`);
	return parsed;
}
function extractSources(path: string): string[] {
	const raw = readBoundedJson(path, 256 * 1024).packages;
	if (!Array.isArray(raw)) return [];
	return raw
		.map((entry) => (typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : ""))
		.filter(Boolean)
		.slice(0, 500);
}
function declarations(piHome: string, root: string): Array<{ source: string; scope: SetupScope }> {
	return [
		...extractSources(join(piHome, "settings.json")).map((source) => ({ source, scope: "global" as const })),
		...extractSources(join(root, ".pi", "settings.json")).map((source) => ({ source, scope: "project" as const })),
	];
}
function profileValue(value: unknown): Omit<SetupProfile, "scope"> {
	if (!isRecord(value)) throw new Error("SETUP_PROFILE_INVALID: profile must be an object");
	const allowed = new Set(["provider", "model", "thinkingLevel", "tools", "instructions", "theme", "allowedModels"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("SETUP_PROFILE_INVALID: profile contains an unknown field");
	const result: Omit<SetupProfile, "scope"> = {};
	for (const field of ["provider", "model", "instructions", "theme"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`SETUP_PROFILE_INVALID: ${field} must be a string`);
		if (typeof value[field] === "string") result[field] = value[field];
	}
	if (
		value.thinkingLevel !== undefined &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thinkingLevel))
	)
		throw new Error("SETUP_PROFILE_INVALID: invalid thinkingLevel");
	if (value.thinkingLevel !== undefined) result.thinkingLevel = value.thinkingLevel as SetupProfile["thinkingLevel"];
	for (const field of ["tools", "allowedModels"] as const) {
		if (value[field] !== undefined && (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string")))
			throw new Error(`SETUP_PROFILE_INVALID: ${field} must contain strings`);
		if (Array.isArray(value[field])) result[field] = value[field] as string[];
	}
	return result;
}
function readProfiles(path: string): Record<string, Omit<SetupProfile, "scope">> {
	const raw = readBoundedJson(path, MAX_PROFILE_FILE_BYTES);
	const profiles: Record<string, Omit<SetupProfile, "scope">> = {};
	for (const [name, value] of Object.entries(raw).slice(0, MAX_PROFILES)) {
		if (!PROFILE_NAME.test(name)) throw new Error(`SETUP_PROFILE_NAME_INVALID: ${name}`);
		profiles[name] = profileValue(value);
	}
	return profiles;
}
async function atomicJson(path: string, value: unknown, mode: number): Promise<void> {
	await writeJsonAtomic(path, stableValue(value), { mode, pretty: true });
}
function bundledSchemaText(): string {
	return readFileSync(join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "schema", "pi-setup-v1.schema.json"), "utf8");
}
/** The curated @danypops ecosystem starter manifest, shipped in this same package (setup/danypops-ecosystem.pi-setup.json) -- resolves relative to this module's own on-disk location the same way bundledSchemaText() does, so `packed setup plan/apply --ecosystem` works immediately after `pi install npm:@danypops/pi-packed`, no separate download. */
export function bundledEcosystemManifestPath(): string {
	return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "setup", "danypops-ecosystem.pi-setup.json");
}
/** Deliberately NOT on writeJsonAtomic: this writes schemaText's exact bytes verbatim -- a
 * later drift check (readFileSync(schemaPath) !== schemaText) needs byte-for-byte fidelity,
 * which a JSON.parse+stringify round-trip through the JSON-specific atomic writer would break. */
function atomicText(path: string, text: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`SETUP_PATH_UNSAFE: refusing to replace symlink ${path}`);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { flag: "wx", mode });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
function manifestPath(input: string): string {
	const absolute = resolve(input);
	return absolute.endsWith(".json") ? absolute : join(absolute, SETUP_MANIFEST_FILE);
}
function readManifest(path: string): SetupManifest {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SETUP_PATH_UNSAFE: manifest must be a regular file");
	if (stat.size > MAX_MANIFEST_BYTES) throw new Error("SETUP_MANIFEST_TOO_LARGE: manifest exceeds 1 MiB");
	return decodeSetupManifest(readFileSync(path, "utf8"));
}
function diagnostic(code: string, severity: Diagnostic["severity"], path: string, message: string): Diagnostic {
	return { code, severity, path, message: message.slice(0, 2_000) };
}
function packageTarget(pkg: SetupPackage): string {
	if (pkg.kind === "npm") return `npm:${npmPackageName(pkg.source)}@${pkg.resolved}`;
	if (pkg.kind === "local") return pkg.resolved;
	return pkg.source;
}

export class SetupManager {
	constructor(
		private readonly registry: Registry,
		private readonly installer: Installer,
		private readonly piHome: string,
		private readonly git: GitResolutionPort = new GitLsRemoteResolver(),
	) {}

	private async resolvePackage(source: string, scope: SetupScope, root: string, machineLocal: boolean): Promise<SetupPackage> {
		const kind = sourceKind(source);
		if (sourceHasCredentials(source)) throw new Error("credential-bearing sources are forbidden");
		if (kind === "npm") {
			const name = npmPackageName(source);
			if (!name) throw new Error("invalid npm source");
			const installHome = scope === "global" ? this.piHome : join(root, ".pi");
			const installed = readResolvedVersion(installHome, source);
			const lockIntegrity = readResolvedIntegrity(installHome, source);
			const info = await this.registry.info(name);
			const resolved = installed ?? info.version;
			const integrity = lockIntegrity ?? (info.version === resolved ? info.publication?.integrity : undefined);
			if (!integrity) throw new Error(`exact registry integrity unavailable for ${name}@${resolved}`);
			return { kind, scope, source: `npm:${name}@${resolved}`, resolved, integrity };
		}
		if (kind === "local") {
			if (!machineLocal) throw new Error(`local source requires --machine-local: ${source}`);
			const base = scope === "global" ? this.piHome : root;
			const resolved = resolve(base, source);
			return { kind, scope, source, resolved, machineLocal: true };
		}
		const resolution = await this.git.resolve(source);
		return { kind, scope, requested: source, source: resolution.source, resolved: resolution.commit };
	}

	async export(projectRoot: string, options: { force?: boolean; machineLocal?: boolean } = {}): Promise<SetupExportReport> {
		const root = resolve(projectRoot),
			path = join(root, SETUP_MANIFEST_FILE),
			diagnostics: Diagnostic[] = [],
			packages: SetupPackage[] = [];
		for (const item of declarations(this.piHome, root).slice(0, MAX_PACKAGES)) {
			try {
				packages.push(await this.resolvePackage(item.source, item.scope, root, options.machineLocal === true));
			} catch (error) {
				diagnostics.push(
					diagnostic("SETUP_RESOLUTION_FAILED", "error", "settings.json", error instanceof Error ? error.message : String(error)),
				);
			}
		}
		const profiles: Record<string, SetupProfile> = {};
		try {
			for (const [name, profile] of Object.entries(readProfiles(join(this.piHome, "profiles.json"))))
				profiles[name] = { scope: "global", ...profile };
			for (const [name, profile] of Object.entries(readProfiles(join(root, ".pi", "profiles.json"))))
				profiles[name] = { scope: "project", ...profile };
		} catch (error) {
			diagnostics.push(
				diagnostic("SETUP_PROFILE_READ_FAILED", "error", "profiles.json", error instanceof Error ? error.message : String(error)),
			);
		}
		const manifest: SetupManifest = {
			$schema: SETUP_SCHEMA_PATH,
			schemaVersion: 1,
			packages: packages.sort((a, b) => `${a.scope}:${a.source}`.localeCompare(`${b.scope}:${b.source}`)),
			profiles: Object.fromEntries(Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b))),
		};
		try {
			decodeSetupManifest(canonicalSetupManifest(manifest));
		} catch (error) {
			diagnostics.push(diagnostic("SETUP_EXPORT_INVALID", "error", path, error instanceof Error ? error.message : String(error)));
		}
		const schemaPath = join(root, "schema", "pi-setup-v1.schema.json"),
			schemaText = bundledSchemaText();
		if (existsSync(path) && !options.force)
			diagnostics.push(
				diagnostic("SETUP_MANIFEST_EXISTS", "error", SETUP_MANIFEST_FILE, "manifest exists; use --force after reviewing it"),
			);
		if (existsSync(path) && lstatSync(path).isSymbolicLink())
			diagnostics.push(diagnostic("SETUP_PATH_UNSAFE", "error", SETUP_MANIFEST_FILE, "refusing to overwrite a manifest symlink"));
		if (existsSync(schemaPath) && lstatSync(schemaPath).isSymbolicLink())
			diagnostics.push(
				diagnostic("SETUP_PATH_UNSAFE", "error", "schema/pi-setup-v1.schema.json", "refusing to overwrite a schema symlink"),
			);
		else if (existsSync(schemaPath) && readFileSync(schemaPath, "utf8") !== schemaText && !options.force)
			diagnostics.push(
				diagnostic(
					"SETUP_SCHEMA_CONFLICT",
					"error",
					"schema/pi-setup-v1.schema.json",
					"project schema differs; use --force after reviewing it",
				),
			);
		if (diagnostics.some((item) => item.severity === "error")) return { ok: false, path, manifest, diagnostics, wrote: false };
		atomicText(schemaPath, schemaText, 0o644);
		await atomicJson(path, manifest, 0o644);
		return { ok: true, path, manifest, diagnostics, wrote: true };
	}

	async update(input: string): Promise<SetupUpdateReport> {
		const path = manifestPath(input);
		let manifest: SetupManifest;
		try {
			manifest = readManifest(path);
		} catch (error) {
			const empty: SetupManifest = { $schema: SETUP_SCHEMA_PATH, schemaVersion: 1, packages: [], profiles: {} };
			return {
				ok: false,
				path,
				manifest: empty,
				diagnostics: [diagnostic("SETUP_MANIFEST_INVALID", "error", path, error instanceof Error ? error.message : String(error))],
				wrote: false,
				updated: 0,
			};
		}
		let updated = 0;
		const packages: SetupPackage[] = [],
			diagnostics: Diagnostic[] = [];
		for (const pkg of manifest.packages) {
			try {
				let next: SetupPackage;
				if (pkg.kind === "local") next = pkg;
				else if (pkg.kind === "npm") {
					const name = npmPackageName(pkg.source)!;
					const info = await this.registry.info(name);
					if (!info.publication?.integrity) throw new Error(`integrity unavailable for ${name}@${info.version}`);
					next = { ...pkg, source: `npm:${name}@${info.version}`, resolved: info.version, integrity: info.publication.integrity };
				} else {
					const resolution = await this.git.resolve(pkg.requested);
					next = { ...pkg, source: resolution.source, resolved: resolution.commit };
				}
				if (canonicalSetupManifest({ ...manifest, packages: [pkg] }) !== canonicalSetupManifest({ ...manifest, packages: [next] }))
					updated++;
				packages.push(next);
			} catch (error) {
				packages.push(pkg);
				diagnostics.push(
					diagnostic("SETUP_UPDATE_RESOLUTION_FAILED", "error", pkg.source, error instanceof Error ? error.message : String(error)),
				);
			}
		}
		const next = { ...manifest, packages };
		if (diagnostics.length) return { ok: false, path, manifest: next, diagnostics, wrote: false, updated };
		await atomicJson(path, next, 0o644);
		return { ok: true, path, manifest: next, diagnostics: [], wrote: true, updated };
	}

	async plan(input: string, options: { prune?: boolean } = {}): Promise<SetupPlan> {
		const path = manifestPath(input),
			prune = options.prune === true;
		let manifest: SetupManifest;
		try {
			manifest = readManifest(path);
		} catch (error) {
			return {
				ok: false,
				manifestPath: path,
				operations: [],
				prune,
				diagnostics: [diagnostic("SETUP_MANIFEST_INVALID", "error", path, error instanceof Error ? error.message : String(error))],
			};
		}
		const root = dirname(path),
			current = declarations(this.piHome, root),
			operations: SetupOperation[] = [];
		for (const pkg of manifest.packages) {
			const identity = packageIdentity(pkg.source, pkg.scope, pkg.kind === "local" ? pkg.resolved : root);
			const found = current.find((item) => packageIdentity(item.source, item.scope, root) === identity);
			if (!found)
				operations.push({
					kind: "install-package",
					packageName: npmPackageName(pkg.source) ?? splitGitSource(pkg.source).clone,
					scope: pkg.scope,
					source: packageTarget(pkg),
					resolved: pkg.resolved,
				});
			else {
				const installHome = pkg.scope === "global" ? this.piHome : join(root, ".pi");
				const resolved =
					pkg.kind === "npm"
						? readResolvedVersion(installHome, found.source)
						: pkg.kind === "local"
							? resolve(pkg.scope === "global" ? this.piHome : root, found.source)
							: splitGitSource(found.source).ref;
				const integrityMismatch = pkg.kind === "npm" && readResolvedIntegrity(installHome, found.source) !== pkg.integrity;
				if (resolved !== pkg.resolved || integrityMismatch)
					operations.push({
						kind: "update-package",
						packageName: npmPackageName(pkg.source) ?? splitGitSource(pkg.source).clone,
						scope: pkg.scope,
						source: packageTarget(pkg),
						resolved: pkg.resolved,
					});
			}
		}
		if (prune) {
			const desired = new Set(
				manifest.packages.map((pkg) => packageIdentity(pkg.source, pkg.scope, pkg.kind === "local" ? pkg.resolved : root)),
			);
			for (const item of current)
				if (!desired.has(packageIdentity(item.source, item.scope, root)))
					operations.push({
						kind: "remove-package",
						packageName: npmPackageName(item.source) ?? item.source,
						scope: item.scope,
						source: item.source,
					});
		}
		let globals: Record<string, Omit<SetupProfile, "scope">>, projects: Record<string, Omit<SetupProfile, "scope">>;
		try {
			globals = readProfiles(join(this.piHome, "profiles.json"));
			projects = readProfiles(join(root, ".pi", "profiles.json"));
		} catch (error) {
			return {
				ok: false,
				manifestPath: path,
				operations: [],
				prune,
				diagnostics: [
					diagnostic("SETUP_PROFILE_READ_FAILED", "error", "profiles.json", error instanceof Error ? error.message : String(error)),
				],
			};
		}
		for (const [name, scoped] of Object.entries(manifest.profiles).sort(([a], [b]) => a.localeCompare(b))) {
			const { scope, ...profile } = scoped,
				existing = scope === "global" ? globals[name] : projects[name];
			if (JSON.stringify(stableValue(existing)) !== JSON.stringify(stableValue(profile)))
				operations.push({ kind: "write-profile", name, scope, fields: Object.keys(profile).sort() });
		}
		if (prune)
			for (const [scope, profiles] of [
				["global", globals],
				["project", projects],
			] as const)
				for (const name of Object.keys(profiles).sort())
					if (!manifest.profiles[name] || manifest.profiles[name].scope !== scope)
						operations.push({ kind: "remove-profile", name, scope, fields: [] });
		const order: Record<SetupOperation["kind"], number> = {
			"install-package": 0,
			"update-package": 0,
			"write-profile": 1,
			"remove-profile": 2,
			"remove-package": 3,
		};
		operations.sort((a, b) => order[a.kind] - order[b.kind] || JSON.stringify(a).localeCompare(JSON.stringify(b)));
		return {
			ok: true,
			manifestPath: path,
			operations,
			prune,
			manifestSha256: createHash("sha256").update(canonicalSetupManifest(manifest)).digest("hex"),
			diagnostics: [],
		};
	}

	async apply(input: string, options: { prune?: boolean } = {}): Promise<SetupApplyResult> {
		const plan = await this.plan(input, options);
		if (!plan.ok)
			return { ok: false, manifestPath: plan.manifestPath, operations: [], reloadRequired: false, diagnostics: plan.diagnostics };
		let manifest: SetupManifest;
		try {
			manifest = readManifest(plan.manifestPath);
		} catch (error) {
			return {
				ok: false,
				manifestPath: plan.manifestPath,
				operations: [],
				reloadRequired: false,
				diagnostics: [
					diagnostic("SETUP_MANIFEST_INVALID", "error", plan.manifestPath, error instanceof Error ? error.message : String(error)),
				],
			};
		}
		if (createHash("sha256").update(canonicalSetupManifest(manifest)).digest("hex") !== plan.manifestSha256)
			return {
				ok: false,
				manifestPath: plan.manifestPath,
				operations: [],
				reloadRequired: false,
				diagnostics: [diagnostic("SETUP_MANIFEST_CHANGED", "error", plan.manifestPath, "manifest changed after planning")],
			};
		const outcomes: SetupApplyResult["operations"] = [],
			packageChanges = plan.operations.filter(
				(item): item is Extract<SetupOperation, { kind: "install-package" | "update-package" }> =>
					item.kind === "install-package" || item.kind === "update-package",
			);
		for (const operation of packageChanges) {
			try {
				const output = await this.installer.install(operation.source, { local: operation.scope === "project" });
				outcomes.push({
					kind: operation.kind,
					target: operation.source,
					status: "succeeded",
					output: output.slice(0, MAX_OPERATION_OUTPUT),
				});
			} catch (error) {
				outcomes.push({
					kind: operation.kind,
					target: operation.source,
					status: "failed",
					output: (error instanceof Error ? error.message : String(error)).slice(0, MAX_OPERATION_OUTPUT),
				});
				return {
					ok: false,
					manifestPath: plan.manifestPath,
					operations: outcomes,
					reloadRequired: outcomes.some((item) => item.status === "succeeded"),
					diagnostics: [
						diagnostic(
							"SETUP_APPLY_FAILED",
							"error",
							operation.packageName,
							"package operation failed; profile writes and removals were not started",
						),
					],
				};
			}
		}
		const root = dirname(plan.manifestPath);
		for (const scope of ["global", "project"] as const) {
			const changes = plan.operations.filter(
				(item): item is Extract<SetupOperation, { kind: "write-profile" | "remove-profile" }> =>
					(item.kind === "write-profile" || item.kind === "remove-profile") && item.scope === scope,
			);
			if (!changes.length) continue;
			const path = scope === "global" ? join(this.piHome, "profiles.json") : join(root, ".pi", "profiles.json");
			try {
				const profiles = readProfiles(path);
				for (const operation of changes) {
					if (operation.kind === "remove-profile") delete profiles[operation.name];
					else {
						const scoped = manifest.profiles[operation.name];
						if (!scoped || scoped.scope !== scope) throw new Error(`profile ${operation.name} changed after planning`);
						const { scope: _scope, ...profile } = scoped;
						profiles[operation.name] = profile;
					}
				}
				await atomicJson(path, profiles, 0o600);
				for (const operation of changes) outcomes.push({ kind: operation.kind, target: `${scope}:${operation.name}`, status: "succeeded" });
			} catch (error) {
				return {
					ok: false,
					manifestPath: plan.manifestPath,
					operations: outcomes,
					reloadRequired: packageChanges.length > 0,
					diagnostics: [diagnostic("SETUP_PROFILE_WRITE_FAILED", "error", path, error instanceof Error ? error.message : String(error))],
				};
			}
		}
		for (const operation of plan.operations.filter(
			(item): item is Extract<SetupOperation, { kind: "remove-package" }> => item.kind === "remove-package",
		)) {
			try {
				const outcome = await this.installer.remove(operation.source, { local: operation.scope === "project" });
				outcomes.push({
					kind: operation.kind,
					target: operation.source,
					status: "succeeded",
					output: outcome.slice(0, MAX_OPERATION_OUTPUT),
				});
			} catch (error) {
				outcomes.push({
					kind: operation.kind,
					target: operation.source,
					status: "failed",
					output: (error instanceof Error ? error.message : String(error)).slice(0, MAX_OPERATION_OUTPUT),
				});
				return {
					ok: false,
					manifestPath: plan.manifestPath,
					operations: outcomes,
					reloadRequired: true,
					diagnostics: [
						diagnostic(
							"SETUP_PRUNE_FAILED",
							"error",
							operation.source,
							"package removal failed after desired packages and profiles were applied",
						),
					],
				};
			}
		}
		return {
			ok: true,
			manifestPath: plan.manifestPath,
			operations: outcomes,
			reloadRequired: outcomes.some((item) => item.kind.includes("package")),
			diagnostics: [],
		};
	}
}

export function formatSetupReport(report: SetupExportReport | SetupUpdateReport | SetupPlan | SetupApplyResult, json = false): string {
	if (json) return `${JSON.stringify(report)}\n`;
	if ("manifest" in report)
		return `${"updated" in report ? "updated" : report.ok ? "exported" : "not exported"}: ${report.path}\n${report.diagnostics.map((item) => `${item.severity} ${item.code}: ${item.message}`).join("\n")}${report.diagnostics.length ? "\n" : ""}`;
	if ("reloadRequired" in report)
		return `${report.ok ? "applied" : "failed"}: ${report.operations.length} operation(s)${report.reloadRequired ? "; reload required" : ""}\n${report.diagnostics.map((item) => `${item.severity} ${item.code}: ${item.message}`).join("\n")}${report.diagnostics.length ? "\n" : ""}`;
	return `${report.ok ? "plan" : "invalid"}: ${report.operations.length} operation(s)${report.prune ? "; prune" : ""}\n${report.operations.map((item) => `  ${item.kind} ${"packageName" in item ? item.packageName : `${item.scope}:${item.name}`}`).join("\n")}${report.operations.length ? "\n" : ""}`;
}
