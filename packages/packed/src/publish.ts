import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Diagnostic } from "./check.ts";
import type { Registry } from "./ports.ts";

export const TRUST_NPM_VERSION = "11.15.0";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKFLOW_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT = 8 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const PACKAGE_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const MAX_WORKSPACE_WALK = 8;
const MAX_WORKSPACE_PACKAGES = 50;

/** Derives the per-package staged-publish workflow filename from a package
 * name, so sibling packages in one workspace never collide on one file. */
export function stageWorkflowSlug(packageName: string): string {
	const bare = packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName;
	const slug = bare.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "package";
}

export function stageWorkflowFile(packageName: string): string {
	return `${stageWorkflowSlug(packageName)}-stage-publish.yml`;
}

export interface PackageManagerSelection {
	name: "bun" | "npm" | "pnpm" | "yarn";
	version?: string;
}

export interface WorkflowInput {
	packageManager: PackageManagerSelection;
	scripts: string[];
	/** Relative package directory to build/test from, when the workflow lives
	 * at a monorepo root rather than the package root itself. */
	packageDir?: string;
	/** Sibling workspace packages (name -> declared range) that must already
	 * be published on npm before this package's own stage can succeed. */
	coreFirst?: Record<string, string>;
	/** Package name slug used to scope this package's own release tag
	 * ($tagPrefix-v*), so two workspace siblings never share one trigger. */
	tagPrefix?: string;
}

export interface VersionCommandResult { code: number; stdout: string; stderr: string }
export type VersionCommand = () => Promise<VersionCommandResult>;
export type TrustStatusCommand = (packageName: string) => Promise<VersionCommandResult>;

export interface PublishSetupReport {
	root: string;
	ok: boolean;
	wrote: boolean;
	workflowPath: string;
	packageName?: string;
	repository?: string;
	trustCommand?: string;
	statusCommand?: string;
	webUrl?: string;
	diagnostics: Diagnostic[];
}

export interface PublishStatusReport {
	root: string;
	ready: boolean;
	packageName?: string;
	repository?: string;
	workflowPath: string;
	checks: {
		packageExists: boolean;
		repository: boolean;
		workflow: boolean;
		lockfile: boolean;
		node: boolean;
		npm: boolean;
		trustedPublisher: "verified" | "not-verified" | "unknown";
		/** true when every internal (workspace-sibling) dependency this package
		 * declares is already published on npm at a satisfying version. */
		coreFirst: boolean;
		/** Local machine login state (npm whoami) -- informative only, never
		 * blocks ready: CI publishes over OIDC trusted-publisher config, not
		 * local login. Surfaced so an interactive caller knows what to offer. */
		loggedIn: boolean;
	};
	diagnostics: Diagnostic[];
	nextSteps: string[];
}

interface PackageManifest {
	name?: unknown;
	version?: unknown;
	repository?: unknown;
	packageManager?: unknown;
	scripts?: unknown;
	publishConfig?: unknown;
	private?: unknown;
	workspaces?: unknown;
	dependencies?: unknown;
}

interface WorkspaceContext {
	workspaceRoot: string;
	packageRelative: string;
	isMonorepo: boolean;
	rootManifest?: PackageManifest;
}

/** Sibling package name -> its directory relative to the workspace root. */
type WorkspaceSiblings = Map<string, string>;

const CHECKOUT_SHA = "d23441a48e516b6c34aea4fa41551a30e30af803";
const SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_BUN_SHA = "0c5077e51419868618aeaa5fe8019c62421857d6";

function installSteps(manager: PackageManagerSelection): string[] {
	if (manager.name === "bun") return [
		`      - uses: oven-sh/setup-bun@${SETUP_BUN_SHA} # v2`,
		"        with:",
		`          bun-version: "${manager.version ?? "1.3.14"}"`,
		"      - run: bun install --frozen-lockfile --ignore-scripts",
	];
	if (manager.name === "npm") return ["      - run: npm ci --ignore-scripts"];
	const version = manager.version ?? (manager.name === "pnpm" ? "10" : "1.22.22");
	return [
		`      - run: npm install --global ${manager.name}@${version}`,
		`      - run: ${manager.name} install --frozen-lockfile --ignore-scripts`,
	];
}

function scriptStep(manager: PackageManagerSelection, script: string, packageDir?: string): string {
	const cwd = packageDir && packageDir !== "." ? ` --cwd ${packageDir}` : "";
	if (manager.name === "npm") return `      - run: npm run ${script}${packageDir && packageDir !== "." ? ` --prefix ${packageDir}` : ""}`;
	if (manager.name === "bun") return `      - run: bun run${cwd} ${script}`;
	if (manager.name === "pnpm") return `      - run: pnpm --dir ${packageDir ?? "."} run ${script}`;
	return `      - run: yarn --cwd ${packageDir ?? "."} run ${script}`;
}

/** One preflight step per internal dependency: reads the resolved version
 * Just installed and fails the job outright if npm doesn't already carry a
 * compatible published version -- mechanical core-first ordering, not a
 * convention that can be skipped. */
function coreFirstSteps(coreFirst: Record<string, string>): string[] {
	return Object.entries(coreFirst).flatMap(([name, range]) => [
		`      - name: Verify ${name}@${range} is already published (core-first ordering)`,
		"        run: |",
		`          version=$(node -p "require('./node_modules/${name}/package.json').version")`,
		`          npm view "${name}@$version" version`,
	]);
}

export function renderStageWorkflow(input: WorkflowInput): string {
	const coreFirst = input.coreFirst && Object.keys(input.coreFirst).length > 0 ? coreFirstSteps(input.coreFirst) : [];
	const steps = input.scripts.map((script) => scriptStep(input.packageManager, script, input.packageDir));
	// A monorepo package gets a slug-scoped tag ($slug-v*) so one tag push can
	// never ambiguously trigger a sibling package's stage; a single-repo
	// package keeps the original plain "v*" it always used.
	const tagPattern = input.packageDir && input.packageDir !== "." && input.tagPrefix ? `${input.tagPrefix}-v*` : "v*";
	const publishDir = input.packageDir && input.packageDir !== "." ? `\n        working-directory: ${input.packageDir}` : "";
	return [
		"name: Stage npm package",
		"",
		"on:",
		"  workflow_dispatch:",
		"  push:",
		"    tags:",
		`      - "${tagPattern}"`,
		"",
		"permissions:",
		"  contents: read",
		"  id-token: write",
		"",
		"concurrency:",
		"  group: stage-npm-${{ github.ref }}",
		"  cancel-in-progress: false",
		"",
		"jobs:",
		"  stage:",
		"    runs-on: ubuntu-latest",
		"    timeout-minutes: 20",
		"    steps:",
		`      - uses: actions/checkout@${CHECKOUT_SHA} # v6`,
		`      - uses: actions/setup-node@${SETUP_NODE_SHA} # v6`,
		"        with:",
		'          node-version: "24"',
		'          registry-url: "https://registry.npmjs.org"',
		"          package-manager-cache: false",
		...installSteps(input.packageManager),
		...coreFirst,
		...steps,
		...(input.packageManager.name === "bun" ? [] : [
			`      - uses: oven-sh/setup-bun@${SETUP_BUN_SHA} # v2`,
			"        with:",
			'          bun-version: "1.3.14"',
		]),
		// "latest", not VERSION: the version currently being staged cannot exist
		// on npm yet, and one already-published packed release exists by the
		// time this workflow can be generated at all (setup requires it).
		`      - run: bunx --bun @danypops/packed@latest check ${input.packageDir ?? "."}`,
		`      - run: npm install --global npm@${TRUST_NPM_VERSION}`,
		"      - run: npm --version",
		`      - run: npm stage publish --access public --provenance --ignore-scripts${publishDir}`,
		"",
	].join("\n");
}

function parseVersion(value: string): [number, number, number] | undefined {
	const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function versionAtLeast(actual: string, minimum: string): boolean {
	const left = parseVersion(actual);
	const right = parseVersion(minimum);
	if (!left || !right) return false;
	for (let index = 0; index < 3; index++) {
		if (left[index]! > right[index]!) return true;
		if (left[index]! < right[index]!) return false;
	}
	return true;
}

/** Supports the two range shapes this workspace actually uses (exact, ^, ~);
 * returns undefined rather than guessing for anything broader. */
export function satisfiesRange(version: string, range: string): boolean | undefined {
	const actual = parseVersion(version);
	if (!actual) return undefined;
	const trimmed = range.trim();
	const exact = parseVersion(trimmed);
	if (exact) return actual[0] === exact[0] && actual[1] === exact[1] && actual[2] === exact[2];
	const caret = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)/);
	if (caret) {
		const min: [number, number, number] = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
		if (actual[0] !== min[0]) return false;
		if (min[0] === 0) return actual[1] === min[1] && actual[2] >= min[2];
		return actual[1] > min[1] || (actual[1] === min[1] && actual[2] >= min[2]);
	}
	const tilde = trimmed.match(/^~(\d+)\.(\d+)\.(\d+)/);
	if (tilde) {
		const min: [number, number, number] = [Number(tilde[1]), Number(tilde[2]), Number(tilde[3])];
		return actual[0] === min[0] && actual[1] === min[1] && actual[2] >= min[2];
	}
	return undefined;
}

export async function runBounded(command: string[]): Promise<VersionCommandResult> {
	const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), VERSION_TIMEOUT_MS);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
	]);
	clearTimeout(timer);
	return { code, stdout: stdout.slice(0, MAX_COMMAND_OUTPUT), stderr: stderr.slice(0, MAX_COMMAND_OUTPUT) };
}

export const readNpmVersion: VersionCommand = () => runBounded(["npm", "--version"]);
export const readTrustStatus: TrustStatusCommand = (packageName) => runBounded(["npm", "trust", "list", packageName, "--json"]);
export const readNpmWhoami: VersionCommand = () => runBounded(["npm", "whoami"]);

export interface InteractiveRunResult { ok: boolean; code: number }

export async function runInherited(command: string[]): Promise<InteractiveRunResult> {
	try {
		const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		const code = await proc.exited;
		return { ok: code === 0, code };
	} catch {
		// no such binary, or the platform opener isn't installed -- the caller
		// always has the raw URL/command to fall back to, never blocks on this.
		return { ok: false, code: -1 };
	}
}

/** Runs the real, interactive `npm login --auth-type=web`. npm's own
 * process polls for completion and writes ~/.npmrc itself -- no token ever
 * passes through Packed. Headless by default (`--no-browser`, npm's own
 * documented config: print the URL, never auto-launch anything); pass
 * `openBrowserAuto: true` only when a human on their own desktop terminal
 * explicitly opted in. Only ever invoked after the caller's own explicit
 * confirmation; never from a non-TTY or scripted context. */
export function runNpmLoginWeb(openBrowserAuto = false): Promise<InteractiveRunResult> {
	const args = ["npm", "login", "--auth-type=web"];
	if (!openBrowserAuto) args.push("--no-browser");
	return runInherited(args);
}

/** Pure command construction, kept separate from the actual spawn so tests
 * never risk invoking a real browser. */
export function browserOpenCommand(url: string): string[] {
	return process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
}

/** Best-effort browser open for a human-driven web handoff (npm's own
 * Trusted Publisher configuration UI, not a CLI command Packed constructs
 * itself). Only ever called when a human explicitly opted in -- the default
 * interactive path never spawns this, it only prints the URL. Failure is
 * silent and non-fatal -- the caller always prints the URL too, so a
 * missing/unknown opener never blocks the human. */
export function openBrowser(url: string): Promise<InteractiveRunResult> {
	return runInherited(browserOpenCommand(url));
}

function readManifest(root: string): PackageManifest {
	const path = join(root, "package.json");
	const bytes = readFileSync(path);
	if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("package.json exceeds 1 MiB");
	const value = JSON.parse(bytes.toString()) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("package.json must contain an object");
	return value as PackageManifest;
}

function isWorkspaceManifest(manifest: PackageManifest): boolean {
	return Array.isArray(manifest.workspaces) || (Boolean(manifest.workspaces) && typeof manifest.workspaces === "object");
}

/** Walks up from a package directory, bounded, looking for the nearest
 * ancestor package.json declaring `workspaces`. Falls back to treating the
 * package itself as the root -- the original, still-supported single-repo
 * shape. */
function resolveWorkspace(packageDir: string): WorkspaceContext {
	let current = packageDir;
	for (let step = 0; step < MAX_WORKSPACE_WALK; step++) {
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
		try {
			const manifest = readManifest(current);
			if (isWorkspaceManifest(manifest)) {
				return { workspaceRoot: current, packageRelative: relative(current, packageDir) || ".", isMonorepo: true, rootManifest: manifest };
			}
		} catch { /* not a manifest here; keep walking */ }
	}
	return { workspaceRoot: packageDir, packageRelative: ".", isMonorepo: false };
}

/** Bounded scan of workspaceRoot/packages/* for sibling package names --
 * used only to detect internal (workspace-to-workspace) dependencies that
 * need core-first ordering, never to walk arbitrary depth. */
function workspaceSiblings(workspaceRoot: string): WorkspaceSiblings {
	const siblings: WorkspaceSiblings = new Map();
	let entries: string[];
	try { entries = readdirSync(join(workspaceRoot, "packages")); } catch { return siblings; }
	for (const entry of entries.slice(0, MAX_WORKSPACE_PACKAGES)) {
		try {
			const manifest = readManifest(join(workspaceRoot, "packages", entry));
			if (typeof manifest.name === "string") siblings.set(manifest.name, join("packages", entry));
		} catch { continue; }
	}
	return siblings;
}

function dependencyRanges(manifest: PackageManifest): Record<string, string> {
	if (!manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies)) return {};
	const ranges: Record<string, string> = {};
	for (const [name, value] of Object.entries(manifest.dependencies as Record<string, unknown>)) if (typeof value === "string") ranges[name] = value;
	return ranges;
}

/** Internal (workspace-sibling) dependency ranges only -- the subset that
 * needs core-first publish ordering, as opposed to ordinary external deps. */
function internalDependencyRanges(manifest: PackageManifest, siblings: WorkspaceSiblings): Record<string, string> {
	const ranges = dependencyRanges(manifest);
	return Object.fromEntries(Object.entries(ranges).filter(([name]) => siblings.has(name)));
}
function repositoryString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof (value as Record<string, unknown>).url === "string") return (value as Record<string, unknown>).url as string;
	return undefined;
}

export function githubRepository(value: unknown): string | undefined {
	const raw = repositoryString(value)?.trim();
	if (!raw || /[?#]/.test(raw)) return undefined;
	const normalized = raw
		.replace(/^git\+/, "")
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
		.replace(/\.git$/, "");
	let url: URL;
	try { url = new URL(normalized); } catch { return undefined; }
	if (url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return undefined;
	return `${parts[0]}/${parts[1]}`;
}

function selectPackageManager(root: string, value: unknown): PackageManagerSelection {
	if (typeof value === "string") {
		const match = value.match(/^(bun|npm|pnpm|yarn)@(.+)$/);
		if (match) return { name: match[1] as PackageManagerSelection["name"], version: match[2]!.slice(0, 32) };
	}
	if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return { name: "bun", version: "1.3.14" };
	if (existsSync(join(root, "pnpm-lock.yaml"))) return { name: "pnpm" };
	if (existsSync(join(root, "yarn.lock"))) return { name: "yarn" };
	return { name: "npm" };
}

function hasRestrictedAccess(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const access = (value as Record<string, unknown>).access;
	return access === "restricted" || access === "private";
}

function hasLockfile(root: string, manager: PackageManagerSelection): boolean {
	if (manager.name === "bun") return existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
	if (manager.name === "pnpm") return existsSync(join(root, "pnpm-lock.yaml"));
	if (manager.name === "yarn") return existsSync(join(root, "yarn.lock"));
	return existsSync(join(root, "package-lock.json")) || existsSync(join(root, "npm-shrinkwrap.json"));
}

function selectedScripts(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const scripts = value as Record<string, unknown>;
	return ["build", "check", "typecheck", "test"].filter((name) => typeof scripts[name] === "string");
}

function trustCommand(packageName: string, workflowFile: string, repository: string): string {
	return `npm trust github ${packageName} --repo ${repository} --file ${workflowFile} --allow-stage-publish`;
}

export function npmWebUrl(packageName: string): string {
	return `https://www.npmjs.com/package/${packageName}/access`;
}

function diagnostic(code: string, severity: Diagnostic["severity"], path: string, message: string, fix?: string): Diagnostic {
	return { code, severity, path, message: message.slice(0, 2_000), ...(fix ? { fix: fix.slice(0, 2_000) } : {}) };
}

async function packageExists(registry: Registry, name: string): Promise<boolean> {
	try { return (await registry.info(name)).name === name; } catch { return false; }
}

function workflowInput(ws: WorkspaceContext, manifest: PackageManifest, siblings: WorkspaceSiblings): WorkflowInput {
	const manager = selectPackageManager(ws.workspaceRoot, manifest.packageManager ?? ws.rootManifest?.packageManager);
	const packageName = typeof manifest.name === "string" ? manifest.name : undefined;
	return {
		packageManager: manager,
		scripts: selectedScripts(manifest.scripts),
		packageDir: ws.isMonorepo ? ws.packageRelative : undefined,
		coreFirst: ws.isMonorepo ? internalDependencyRanges(manifest, siblings) : undefined,
		tagPrefix: ws.isMonorepo && packageName ? stageWorkflowSlug(packageName) : undefined,
	};
}

function workflowIsExpected(path: string, expected: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_WORKFLOW_BYTES) return false;
		return readFileSync(path, "utf8") === expected;
	} catch { return false; }
}

export class PublishManager {
	constructor(
		private readonly registry: Registry,
		private readonly versionCommand: VersionCommand = readNpmVersion,
		private readonly trustStatusCommand: TrustStatusCommand = readTrustStatus,
		private readonly whoamiCommand: VersionCommand = readNpmWhoami,
	) {}

	async setup(projectPath: string, options: { force?: boolean } = {}): Promise<PublishSetupReport> {
		const root = resolve(projectPath);
		const ws = resolveWorkspace(root);
		const diagnostics: Diagnostic[] = [];
		let manifest: PackageManifest;
		try { manifest = readManifest(root); }
		catch (error) {
			return { root, ok: false, wrote: false, workflowPath: join(ws.workspaceRoot, ".github/workflows/stage-publish.yml"), diagnostics: [diagnostic("PUBLISH_MANIFEST_INVALID", "error", "package.json", error instanceof Error ? error.message : String(error))] };
		}
		const packageName = typeof manifest.name === "string" && PACKAGE_NAME.test(manifest.name) ? manifest.name : undefined;
		const workflowFile = stageWorkflowFile(packageName ?? basename(root));
		const workflowRelativePath = `.github/workflows/${workflowFile}`;
		const workflowPath = join(ws.workspaceRoot, workflowRelativePath);
		if (!packageName) diagnostics.push(diagnostic("PUBLISH_PACKAGE_NAME_INVALID", "error", "package.json", "package name is missing or invalid"));
		if (manifest.private === true || hasRestrictedAccess(manifest.publishConfig)) diagnostics.push(diagnostic("PUBLISH_PRIVATE_PACKAGE", "error", "package.json", "the generated public staged-publish workflow does not support private or restricted packages"));
		const repository = githubRepository(manifest.repository);
		if (!repository) diagnostics.push(diagnostic("PUBLISH_GITHUB_REPOSITORY_REQUIRED", "error", "package.json", "repository must identify one credential-free GitHub owner/repository"));
		const exists = packageName ? await packageExists(this.registry, packageName) : false;
		if (packageName && !exists) diagnostics.push(diagnostic("PUBLISH_PACKAGE_NOT_FOUND", "error", "package.json", "trusted publishing can only be configured after the package exists on npm", `Complete the first authenticated publish in npm, then rerun packed publish setup. Open ${npmWebUrl(packageName)}`));
		const manager = selectPackageManager(ws.workspaceRoot, manifest.packageManager ?? ws.rootManifest?.packageManager);
		if (!hasLockfile(ws.workspaceRoot, manager)) diagnostics.push(diagnostic("PUBLISH_LOCKFILE_REQUIRED", "error", "package.json", `a committed ${manager.name} lockfile is required for deterministic CI installation`));
		const npm = await this.versionCommand().catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
		if (npm.code !== 0 || !versionAtLeast(npm.stdout, TRUST_NPM_VERSION)) diagnostics.push(diagnostic("PUBLISH_NPM_VERSION_LOW", "warning", "npm", `npm ${TRUST_NPM_VERSION} or newer is required for trust management`, `npm install --global npm@^${TRUST_NPM_VERSION}`));
		if (existsSync(workflowPath) && !options.force) diagnostics.push(diagnostic("PUBLISH_WORKFLOW_EXISTS", "error", workflowRelativePath, "workflow already exists; Packed will not overwrite it without --force"));
		if (existsSync(workflowPath) && lstatSync(workflowPath).isSymbolicLink()) diagnostics.push(diagnostic("PUBLISH_WORKFLOW_SYMLINK", "error", workflowRelativePath, "refusing to overwrite a workflow symlink"));
		if (diagnostics.some((item) => item.severity === "error")) {
			return { root, ok: false, wrote: false, workflowPath, packageName, repository, trustCommand: packageName && repository ? trustCommand(packageName, workflowFile, repository) : undefined, webUrl: packageName ? npmWebUrl(packageName) : undefined, diagnostics };
		}
		const siblings = ws.isMonorepo ? workspaceSiblings(ws.workspaceRoot) : new Map<string, string>();
		const workflow = renderStageWorkflow(workflowInput(ws, manifest, siblings));
		mkdirSync(dirname(workflowPath), { recursive: true });
		if (options.force && existsSync(workflowPath)) {
			const temporary = join(dirname(workflowPath), `.${basename(workflowPath)}.${process.pid}.tmp`);
			try { writeFileSync(temporary, workflow, { flag: "wx", mode: 0o644 }); renameSync(temporary, workflowPath); }
			finally { rmSync(temporary, { force: true }); }
		} else writeFileSync(workflowPath, workflow, { flag: "wx", mode: 0o644 });
		return {
			root, ok: true, wrote: true, workflowPath, packageName, repository,
			trustCommand: trustCommand(packageName!, workflowFile, repository!), statusCommand: `packed publish status ${root}`,
			webUrl: npmWebUrl(packageName!), diagnostics,
		};
	}

	async status(projectPath: string): Promise<PublishStatusReport> {
		const root = resolve(projectPath);
		const ws = resolveWorkspace(root);
		const diagnostics: Diagnostic[] = [];
		let manifest: PackageManifest;
		try { manifest = readManifest(root); }
		catch (error) {
			return { root, ready: false, workflowPath: join(ws.workspaceRoot, ".github/workflows/stage-publish.yml"), checks: { packageExists: false, repository: false, workflow: false, lockfile: false, node: false, npm: false, trustedPublisher: "unknown", coreFirst: false, loggedIn: false }, diagnostics: [diagnostic("PUBLISH_MANIFEST_INVALID", "error", "package.json", error instanceof Error ? error.message : String(error))], nextSteps: [] };
		}
		const packageName = typeof manifest.name === "string" && PACKAGE_NAME.test(manifest.name) ? manifest.name : undefined;
		const workflowFile = stageWorkflowFile(packageName ?? basename(root));
		const workflowRelativePath = `.github/workflows/${workflowFile}`;
		const workflowPath = join(ws.workspaceRoot, workflowRelativePath);
		const repository = githubRepository(manifest.repository);
		const exists = packageName ? await packageExists(this.registry, packageName) : false;
		const manager = selectPackageManager(ws.workspaceRoot, manifest.packageManager ?? ws.rootManifest?.packageManager);
		const lockfile = hasLockfile(ws.workspaceRoot, manager);
		const siblings = ws.isMonorepo ? workspaceSiblings(ws.workspaceRoot) : new Map<string, string>();
		const internal = ws.isMonorepo ? internalDependencyRanges(manifest, siblings) : {};
		const expected = renderStageWorkflow(workflowInput(ws, manifest, siblings));
		const workflow = workflowIsExpected(workflowPath, expected);
		const npmResult = await this.versionCommand().catch(() => ({ code: 1, stdout: "", stderr: "" }));
		const npm = npmResult.code === 0 && versionAtLeast(npmResult.stdout, TRUST_NPM_VERSION);
		const node = workflow && expected.includes('node-version: "24"');
		const trustedPublisher = packageName && repository && npm
			? await this.trustedPublisherStatus(packageName, workflowFile, repository)
			: "unknown";
		const coreFirst = await this.coreFirstStatus(internal, diagnostics);
		const loggedIn = (await this.whoamiCommand().catch(() => ({ code: 1, stdout: "", stderr: "" }))).code === 0;
		if (!loggedIn) diagnostics.push(diagnostic("PUBLISH_NPM_NOT_LOGGED_IN", "warning", "npm", "not logged in to npm on this machine; trust configuration requires an authenticated npm session", "npm login --auth-type=web"));
		if (!packageName) diagnostics.push(diagnostic("PUBLISH_PACKAGE_NAME_INVALID", "error", "package.json", "package name is missing or invalid"));
		if (!exists) diagnostics.push(diagnostic("PUBLISH_PACKAGE_NOT_FOUND", "error", "package.json", "package does not exist on npm"));
		if (!repository) diagnostics.push(diagnostic("PUBLISH_GITHUB_REPOSITORY_REQUIRED", "error", "package.json", "valid GitHub repository metadata is required"));
		if (!lockfile) diagnostics.push(diagnostic("PUBLISH_LOCKFILE_REQUIRED", "error", "package.json", `a committed ${manager.name} lockfile is required for deterministic CI installation`));
		if (!workflow) diagnostics.push(diagnostic("PUBLISH_WORKFLOW_MISSING_OR_STALE", "error", workflowRelativePath, "generated staged-publish workflow is missing or differs from current policy", "rerun packed publish setup --force after reviewing the diff"));
		if (!npm) diagnostics.push(diagnostic("PUBLISH_NPM_VERSION_LOW", "warning", "npm", `local npm ${TRUST_NPM_VERSION} or newer is required to configure trust`, `npm install --global npm@^${TRUST_NPM_VERSION}`));
		if (trustedPublisher === "not-verified") diagnostics.push(diagnostic("PUBLISH_TRUST_MISMATCH", "error", "npm", "npm trusted publisher does not match the GitHub repository, workflow file, and stage-only permission"));
		if (trustedPublisher === "unknown") diagnostics.push(diagnostic("PUBLISH_TRUST_UNKNOWN", "warning", "npm", "trusted publisher status could not be read; authenticate npm or use the web handoff"));
		const command = packageName && repository ? trustCommand(packageName, workflowFile, repository) : undefined;
		const nextSteps = [
			...(command ? [`Run: ${command}`] : []),
			...(packageName ? [`Or configure Trusted Publisher in npm: ${npmWebUrl(packageName)}`] : []),
			"Enable account-level 2FA, allow staged publishing only, then trigger the workflow.",
			...(!coreFirst ? ["Publish the internal core dependency at a compatible version before staging this package."] : []),
			"Review with npm stage list/view/download and approve the chosen stage with 2FA.",
		];
		return {
			root, ready: Boolean(packageName && exists && repository && workflow && lockfile && node && npm && trustedPublisher === "verified" && coreFirst), packageName, repository, workflowPath,
			checks: { packageExists: exists, repository: Boolean(repository), workflow, lockfile, node, npm, trustedPublisher, coreFirst, loggedIn }, diagnostics, nextSteps,
		};
	}

	/** Local, informative mirror of the CI-side ordering guard: every internal
	 * (workspace-sibling) dependency must already be published on npm at a
	 * version its declared range accepts. Empty when there are none. */
	private async coreFirstStatus(internal: Record<string, string>, diagnostics: Diagnostic[]): Promise<boolean> {
		let ok = true;
		for (const [name, range] of Object.entries(internal)) {
			let latest: string | undefined;
			try { latest = (await this.registry.info(name)).version; } catch { latest = undefined; }
			if (!latest) {
				diagnostics.push(diagnostic("PUBLISH_DEPENDENCY_NOT_PUBLISHED", "error", "package.json#dependencies", `${name} must be published on npm before staging this package (core-first ordering)`));
				ok = false;
				continue;
			}
			const satisfies = satisfiesRange(latest, range);
			if (satisfies === false) {
				diagnostics.push(diagnostic("PUBLISH_DEPENDENCY_RANGE_MISMATCH", "error", "package.json#dependencies", `${name}@${range} does not accept npm's published ${latest}; align the range or publish a compatible core release first`));
				ok = false;
			} else if (satisfies === undefined) {
				diagnostics.push(diagnostic("PUBLISH_DEPENDENCY_RANGE_UNKNOWN", "warning", "package.json#dependencies", `could not evaluate whether ${name}@${range} accepts npm's published ${latest}`));
			}
		}
		return ok;
	}

	private async trustedPublisherStatus(packageName: string, workflowFile: string, repository: string): Promise<"verified" | "not-verified" | "unknown"> {
		let result: VersionCommandResult;
		try { result = await this.trustStatusCommand(packageName); } catch { return "unknown"; }
		if (result.code !== 0) return "unknown";
		if (result.stdout.trim() === "") return "not-verified";
		try {
			const value = JSON.parse(result.stdout) as Record<string, unknown>;
			const permissions = Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === "string") : [];
			const matches = value.type === "github"
				&& value.repository === repository
				&& value.file === workflowFile
				&& permissions.includes("createStagedPackage")
				&& !permissions.includes("createPackage");
			return matches ? "verified" : "not-verified";
		} catch { return "unknown"; }
	}
}

export function formatPublishReport(report: PublishSetupReport | PublishStatusReport, json = false): string {
	if (json) return JSON.stringify(report) + "\n";
	if ("wrote" in report) {
		let out = `${report.ok ? "ready" : "not ready"}: ${report.packageName ?? report.root}\n`;
		if (report.wrote) out += `wrote ${report.workflowPath}\n`;
		for (const item of report.diagnostics) out += `${item.severity} ${item.code}: ${item.message}${item.fix ? `\n  fix: ${item.fix}` : ""}\n`;
		if (report.trustCommand) out += `next: ${report.trustCommand}\n`;
		if (report.webUrl) out += `web: ${report.webUrl}\n`;
		return out.slice(0, 16 * 1024);
	}
	let out = `${report.ready ? "ready" : "not ready"}: ${report.packageName ?? report.root}\n`;
	for (const [name, value] of Object.entries(report.checks)) out += `${name}: ${String(value)}\n`;
	for (const item of report.diagnostics) out += `${item.severity} ${item.code}: ${item.message}${item.fix ? `\n  fix: ${item.fix}` : ""}\n`;
	for (const step of report.nextSteps) out += `${step}\n`;
	return out.slice(0, 16 * 1024);
}
