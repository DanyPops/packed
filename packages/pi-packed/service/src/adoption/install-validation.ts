/**
 * install-validation.ts — a headless "does this extension even load" gate
 * for ExecInstaller.install(), so a package that crashes at registration
 * time never gets fully wired into ~/.pi/npm and ~/.pi/agent in the first
 * place. Stages the real npm tarball into a throwaway temp dir (never the
 * live piHome), installs its own declared dependencies there, then runs
 * @danypops/pi-extension-harness's own mock-pi-cli
 * subprocess -- a real, isolated process exercising the same production
 * jiti load path Pi's own binary uses -- against every declared
 * pi.extensions entry. Also runs @danypops/vehicle-client-pi's
 * pi-load-harness (native ESM, jiti tryNative:false) in its own isolated
 * subprocess as non-gating, observational evidence alongside that gating
 * check -- see ExtensionLoadResult.additionalLoadPaths.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ExtensionLoadResult {
	path: string;
	ok: boolean;
	message?: string;
	/** Non-gating: @danypops/vehicle-client-pi's pi-load-harness checks two
	 * further Pi extension load paths (native ESM, jiti tryNative:false)
	 * beyond the one path above (jiti tryNative:true) already gates install.
	 * Surfaced as observational evidence only, for two independent reasons:
	 * (1) native-esm can legitimately fail for a perfectly loadable extension
	 * on an older Node without TS type-stripping support, with no real-world
	 * signal yet on how often that's a false alarm; (2) this check only
	 * verifies the module *imports* cleanly -- unlike the gating check above,
	 * it never calls the extension's exported factory, so it cannot catch a
	 * factory that throws once actually registered (confirmed directly: the
	 * BROKEN test fixture, whose factory always throws, reports ok:true on
	 * every one of these paths). Complementary evidence for an import-time
	 * failure class, not a broader replacement for the gating check. */
	additionalLoadPaths?: PiLoadPathResult[];
}

export interface PiLoadPathResult {
	path: "native-esm" | "jiti-try-native-false" | "jiti-try-native-true";
	ok: boolean;
	error?: string;
}

export interface InstallValidationResult {
	ok: boolean;
	source: string;
	extensions: ExtensionLoadResult[];
	message?: string;
}

export interface InstallValidator {
	validate(source: string): Promise<InstallValidationResult>;
}

/**
 * Shared with ExecInstaller.install() (the single ad hoc path, which validates then commits
 * itself) and SetupManager.apply() (the batch path, which validates every package change
 * concurrently via Installer.validate() before ever calling installOnly() on any of them) --
 * one formatting rule for "why was this install refused", not two copies that could drift.
 */
export function assertInstallValidationOk(validation: InstallValidationResult): void {
	if (validation.ok) return;
	const detail = validation.extensions
		.filter((extension) => !extension.ok)
		.map((extension) => `${extension.path}: ${extension.message}`)
		.join("; ");
	throw new Error(`install refused -- ${detail || validation.message || "extension failed a headless load check"}`);
}

const DEFAULT_LOAD_TIMEOUT_MS = 8_000;
const MAX_LOAD_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 60_000;
const MAX_EXTENSIONS = 20;
/** Bounds directoryHasMatchingFile's own recursive walk -- a real Pi package's
 * resource directories are small; this only exists so an adversarial or
 * accidentally enormous tarball can't make the convention-directory scan
 * itself expensive. */
const MAX_CONVENTION_SCAN_ENTRIES = 500;

/** The four resource kinds a package.json's own `pi` manifest key, or (absent
 * a manifest) pi's own convention directories, can declare -- see
 * @earendil-works/pi-coding-agent's docs/packages.md "Package Structure". */
const MANIFEST_RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

/** Loosely mirrors (not a byte-for-byte port -- pi's own walker is
 * .gitignore-aware via the `ignore` package, this isn't) pi's own
 * convention-directory file matching from @earendil-works/pi-coding-agent's
 * package-manager.js: extensions/ take .ts/.js recursively, skills/ take
 * SKILL.md or any .md recursively, prompts/ and themes/ take top-level
 * .md/.json respectively. Close enough to answer "would pi's own loader ever
 * find anything to load here", which is all a pre-install admission check
 * needs. */
const CONVENTION_RESOURCE_DIRS: Record<string, { match: (name: string) => boolean; recursive: boolean }> = {
	extensions: { match: (name) => name.endsWith(".ts") || name.endsWith(".js"), recursive: true },
	skills: { match: (name) => name === "SKILL.md" || name.endsWith(".md"), recursive: true },
	prompts: { match: (name) => name.endsWith(".md"), recursive: false },
	themes: { match: (name) => name.endsWith(".json"), recursive: false },
};

function hasNonEmptyStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
}

/** True if the package's own `pi` manifest key declares at least one
 * non-empty resource array of any of the four kinds -- not just
 * `extensions`, which the caller already checked separately. */
function hasAnyManifestResource(pi: Record<string, unknown> | undefined): boolean {
	if (!pi) return false;
	return MANIFEST_RESOURCE_FIELDS.some((field) => hasNonEmptyStringArray(pi[field]));
}

/** Bounded recursive scan for at least one file matching `match` under `dir`.
 * `remaining` is a shared mutable budget across the whole call tree so a
 * pathological directory structure can't make this unbounded work. */
function directoryHasMatchingFile(dir: string, match: (name: string) => boolean, recursive: boolean, remaining: { count: number }): boolean {
	if (!existsSync(dir) || remaining.count <= 0) return false;
	let entries: import("node:fs").Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (remaining.count-- <= 0) return false;
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isFile() && match(entry.name)) return true;
		if (recursive && entry.isDirectory() && directoryHasMatchingFile(full, match, recursive, remaining)) return true;
	}
	return false;
}

/** True if the staged package root has any of pi's own convention resource
 * directories (extensions/, skills/, prompts/, themes/) containing at least
 * one file pi's own loader would actually pick up -- the fallback pi itself
 * uses when a package declares no `pi` manifest at all. */
function hasConventionResources(root: string): boolean {
	const remaining = { count: MAX_CONVENTION_SCAN_ENTRIES };
	return Object.entries(CONVENTION_RESOURCE_DIRS).some(([dirName, { match, recursive }]) =>
		directoryHasMatchingFile(join(root, dirName), match, recursive, remaining),
	);
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.min(Math.floor(value), maximum);
}

/** Strips packed's own "npm:" scheme -- what npm pack itself expects is a
 * bare registry spec (name, name@version) or a local path. Returns
 * undefined for git:/https:/local sources: nothing here to stage from an
 * npm tarball, so headless validation is out of scope for them. */
export function bareNpmSpec(source: string): string | undefined {
	return source.startsWith("npm:") ? source.slice(4) : undefined;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

async function runCommand(command: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
	// env explicit, not Bun.spawn's own default-inherited env -- see install.ts's ExecInstaller.run()
	// for why a runtime process.env mutation (e.g. a caller redirecting Pi's home directory) must be
	// threaded through explicitly rather than trusted to Bun's own default inheritance.
	const proc = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			/* already exited */
		}
	}, timeoutMs);
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	return { code, stdout, stderr, timedOut };
}

type StageResult = { ok: true; root: string } | { ok: false; message: string };

/** Downloads (or, for a local path spec, packs) the real tarball into
 * stageDir and extracts it -- never touches the live piHome. */
async function stageNpmTarball(spec: string, stageDir: string): Promise<StageResult> {
	const pack = await runCommand(["npm", "pack", spec, "--json"], stageDir, PACK_TIMEOUT_MS);
	if (pack.timedOut) return { ok: false, message: `npm pack exceeded ${PACK_TIMEOUT_MS}ms` };
	if (pack.code !== 0) return { ok: false, message: (pack.stderr.trim() || `npm pack exited ${pack.code}`).slice(0, 2_000) };
	let filename: string | undefined;
	try {
		const parsed = JSON.parse(pack.stdout) as Array<{ filename?: string }>;
		filename = parsed[0]?.filename;
	} catch (e) {
		return { ok: false, message: `npm pack produced unparseable JSON: ${e instanceof Error ? e.message : e}` };
	}
	if (!filename) return { ok: false, message: "npm pack reported no tarball filename" };
	const tarPath = join(stageDir, filename);
	if (!existsSync(tarPath)) return { ok: false, message: `expected tarball ${filename} is missing after npm pack` };
	const extract = await runCommand(["tar", "-xzf", tarPath, "-C", stageDir], stageDir, PACK_TIMEOUT_MS);
	if (extract.code !== 0) return { ok: false, message: (extract.stderr.trim() || `tar exited ${extract.code}`).slice(0, 2_000) };
	const root = join(stageDir, "package"); // npm's own tarball layout convention
	if (!existsSync(join(root, "package.json"))) return { ok: false, message: "extracted tarball has no package.json at its expected root" };
	return { ok: true, root };
}

/** Installs the staged tarball's own declared dependencies -- npm pack +
 * tar only extract the package's own files, never fetch what its
 * package.json requires. --ignore-scripts keeps an untrusted candidate's
 * lifecycle scripts from running during a headless check nobody explicitly
 * approved; --omit=dev matches what the entry point actually needs at
 * runtime (jiti loads its TS source directly, no separate build step). */
async function installStagedDependencies(root: string): Promise<{ ok: true } | { ok: false; message: string }> {
	const install = await runCommand(["npm", "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], root, INSTALL_TIMEOUT_MS);
	if (install.timedOut) return { ok: false, message: `npm install exceeded ${INSTALL_TIMEOUT_MS}ms installing the staged package's own dependencies` };
	if (install.code !== 0) return { ok: false, message: (install.stderr.trim() || `npm install exited ${install.code}`).slice(0, 2_000) };
	return { ok: true };
}

/** Runs pi-extension-harness's mock-pi-cli against one extension entry
 * point, in its own load-only mode (--tool omitted): a real, isolated
 * subprocess exercising Pi's own production jiti load path. */
export async function validateExtensionLoadsHeadless(entryPath: string, timeoutMs?: number): Promise<ExtensionLoadResult> {
	const bound = bounded(timeoutMs, DEFAULT_LOAD_TIMEOUT_MS, MAX_LOAD_TIMEOUT_MS);
	let cliPath: string;
	try {
		cliPath = createRequire(import.meta.url).resolve("@danypops/pi-extension-harness/mock-pi-cli");
	} catch (e) {
		return { path: entryPath, ok: false, message: `pi-extension-harness is not resolvable: ${e instanceof Error ? e.message : e}` };
	}
	const result = await runCommand(["node", cliPath, "--extension", entryPath], tmpdir(), bound);
	if (result.timedOut) return { path: entryPath, ok: false, message: `extension load exceeded ${bound}ms` };
	const lastEvent = result.stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.at(-1);
	if (lastEvent) {
		try {
			const event = JSON.parse(lastEvent) as { type?: string; error?: string };
			if (event.type === "load_ok") return { path: entryPath, ok: true };
			if (event.type === "load_error") {
				return {
					path: entryPath,
					ok: false,
					message: (typeof event.error === "string" ? event.error : "extension failed to load").slice(0, 1_000),
				};
			}
		} catch {
			// Falls through to the generic failure below.
		}
	}
	return {
		path: entryPath,
		ok: false,
		message: (result.stderr.trim() || `mock-pi-cli exited ${result.code} with no recognizable event`).slice(0, 1_000),
	};
}

/** Runs the extra two Pi extension load paths @danypops/vehicle-client-pi's
 * pi-load-harness knows about (native ESM, jiti tryNative:false) against
 * one entry point, in their own isolated subprocess -- same trust boundary
 * as validateExtensionLoadsHeadless, never inside the daemon process.
 * Returns undefined (not a failure) when the probe subprocess itself
 * couldn't run at all -- vehicle-client-pi is an optional enrichment here,
 * not a hard requirement the way pi-extension-harness is. */
async function verifyAllLoadPathsHeadless(entryPath: string, timeoutMs?: number): Promise<PiLoadPathResult[] | undefined> {
	const bound = bounded(timeoutMs, DEFAULT_LOAD_TIMEOUT_MS, MAX_LOAD_TIMEOUT_MS);
	const childPath = new URL("verify-load-paths-child.mjs", import.meta.url).pathname;
	const result = await runCommand(["node", childPath, "--extension", entryPath], tmpdir(), bound);
	if (result.timedOut) return undefined;
	const lastLine = result.stdout.trim().split("\n").at(-1);
	if (!lastLine) return undefined;
	try {
		const parsed = JSON.parse(lastLine) as { results?: PiLoadPathResult[]; error?: string };
		return Array.isArray(parsed.results) ? parsed.results : undefined;
	} catch {
		return undefined;
	}
}

/** Stages the real npm tarball in isolation and headlessly load-checks
 * every pi.extensions entry it declares. A non-npm source has nothing to
 * stage and passes through as ok. A package with no pi.extensions passes
 * only if it declares some other pi manifest resource (skills/prompts/
 * themes) or has a matching pi convention directory on disk -- otherwise
 * it isn't a Pi package at all (a plain npm dependency like is-number or
 * is-buffer) and is refused rather than silently admitted as a dead
 * `packages` entry pi itself would never load anything from. */
export class HeadlessInstallValidator implements InstallValidator {
	constructor(private readonly timeoutMs?: number) {}

	async validate(source: string): Promise<InstallValidationResult> {
		const spec = bareNpmSpec(source);
		if (!spec) return { ok: true, source, extensions: [] };

		const stageDir = mkdtempSync(join(tmpdir(), "packed-install-validate-"));
		try {
			const staged = await stageNpmTarball(spec, stageDir);
			if (!staged.ok) return { ok: false, source, extensions: [], message: staged.message };

			let manifest: Record<string, unknown>;
			try {
				manifest = JSON.parse(readFileSync(join(staged.root, "package.json"), "utf8")) as Record<string, unknown>;
			} catch (e) {
				return { ok: false, source, extensions: [], message: `package.json unreadable: ${e instanceof Error ? e.message : e}` };
			}

			const pi = typeof manifest.pi === "object" && manifest.pi !== null ? (manifest.pi as Record<string, unknown>) : undefined;
			const declared = Array.isArray(pi?.extensions)
				? pi.extensions.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_EXTENSIONS)
				: [];
			if (declared.length === 0) {
				// No pi.extensions to headlessly load-check -- but that alone isn't
				// license to wave the package through. A real Pi package with only
				// skills/prompts/themes (declared in the manifest or found via pi's
				// own convention directories) still passes here unexamined; a
				// package that is neither -- e.g. `is-number`, `is-buffer`, any
				// plain leaf npm dependency someone points `pkg_install` at
				// directly -- gets refused instead of silently becoming a dead
				// `packages` entry that pi itself will never load anything from.
				if (hasAnyManifestResource(pi) || hasConventionResources(staged.root)) {
					return { ok: true, source, extensions: [] };
				}
				return {
					ok: false,
					source,
					extensions: [],
					message:
						"package declares no pi.extensions/skills/prompts/themes and has no extensions/skills/prompts/themes directory -- not a Pi package",
				};
			}

			const installed = await installStagedDependencies(staged.root);
			if (!installed.ok) return { ok: false, source, extensions: [], message: installed.message };

			const extensions: ExtensionLoadResult[] = [];
			for (const entry of declared) {
				const entryPath = resolve(staged.root, entry);
				if (!existsSync(entryPath)) {
					extensions.push({ path: entry, ok: false, message: "declared pi.extensions entry is absent from the tarball" });
					continue;
				}
				// Report the declared manifest entry, not the resolved absolute
				// path into a throwaway temp stage dir -- meaningful to a caller,
				// matches what package.json itself says.
				const loadResult = await validateExtensionLoadsHeadless(entryPath, this.timeoutMs);
				const additionalLoadPaths = await verifyAllLoadPathsHeadless(entryPath, this.timeoutMs);
				extensions.push({ ...loadResult, path: entry, ...(additionalLoadPaths ? { additionalLoadPaths } : {}) });
			}
			const ok = extensions.every((extension) => extension.ok);
			return { ok, source, extensions, ...(ok ? {} : { message: "one or more declared extensions failed a headless load check" }) };
		} finally {
			rmSync(stageDir, { recursive: true, force: true });
		}
	}
}
