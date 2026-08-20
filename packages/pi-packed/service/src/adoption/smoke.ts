import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type SmokeStatus = "ok" | "timeout" | "crash" | "capability-denied" | "output-limit" | "sandbox-unavailable";

export interface SmokeRegistrations {
	tools: string[];
	commands: string[];
	shortcuts: string[];
	flags: string[];
	providers: string[];
	events: string[];
	renderers: string[];
	/**
	 * Names, within tools/commands/shortcuts/flags respectively, whose registration call carried an
	 * explicit `shared: true` marker -- see @danypops/vehicle-client-pi's own markSharedRegistration.
	 * doctor.ts only suppresses a name's conflict once EVERY one of its claimants marked it shared.
	 */
	sharedTools: string[];
	sharedCommands: string[];
	sharedShortcuts: string[];
	sharedFlags: string[];
}

export interface ExtensionSmokeResult {
	path: string;
	status: SmokeStatus;
	durationMs: number;
	registrations: SmokeRegistrations;
	message?: string;
}

export interface SmokeOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxProcesses?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_PROCESSES = 16;
const MAX_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESSES = 32;
const EMPTY_REGISTRATIONS: SmokeRegistrations = {
	tools: [],
	commands: [],
	shortcuts: [],
	flags: [],
	providers: [],
	events: [],
	renderers: [],
	sharedTools: [],
	sharedCommands: [],
	sharedShortcuts: [],
	sharedFlags: [],
};

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.min(Math.floor(value), maximum);
}

function addReadOnlyBind(args: string[], path: string): void {
	if (existsSync(path)) args.push("--ro-bind", path, path);
}

const MAX_ANCESTOR_WALK = 32;

/**
 * Every ancestor directory's own node_modules from packageRoot's parent up to
 * the filesystem root -- mirrors Node's real module-resolution walk
 * (require.resolve checks <dir>/node_modules at every level up to /).
 * Confirmed live: packed doctor's own widget reported real extensions
 * (pi-lector, pi-pipes, pi-tickets, pi-jittor, pi-web-spider) as "crash" on a
 * plain Cannot-find-module for a sibling dependency npm/bun hoisted to a
 * shared ancestor node_modules, though Pi's own real, unsandboxed process
 * resolves the exact same import fine -- the sandbox only ever bound the
 * package's own root, never the hoisted siblings one or more levels above it.
 * Bounded to MAX_ANCESTOR_WALK levels as a defensive cap; a real filesystem
 * hierarchy never gets remotely close to that before reaching /.
 */
function collectAncestorNodeModulesDirs(packageRoot: string): string[] {
	const dirs: string[] = [];
	let current = dirname(packageRoot);
	for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
		const candidate = join(current, "node_modules");
		if (existsSync(candidate)) dirs.push(realpathSync(candidate));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

/**
 * Resolves an installed dependency's real on-disk package directory via
 * Node's own module-resolution algorithm (require.resolve against its
 * package.json), starting from `fromDir` -- correct regardless of whether
 * the package manager nested it under fromDir's own node_modules or
 * hoisted it to a shared ancestor node_modules (npm's own hoisting
 * decision, driven by what else in the tree also depends on it).
 * Confirmed live: `packed doctor --json` crashed hard reconstructing a
 * fixed nested-only path (`<packageDirectory>/node_modules/jiti`) that
 * doesn't exist once jiti is hoisted to Pi's own npm prefix instead of
 * pi-packed's own node_modules. Never executes the resolved module --
 * require.resolve only locates a path, it never runs anything. undefined
 * (not a throw) when genuinely unresolvable from here.
 */
export function resolveDependencyModulesDir(fromDir: string, name: string): string | undefined {
	try {
		const req = createRequire(join(fromDir, "package.json"));
		return realpathSync(dirname(req.resolve(`${name}/package.json`)));
	} catch {
		return undefined;
	}
}

const MAX_PROCESS_SCAN_ENTRIES = 100_000;

/**
 * RLIMIT_NPROC (prlimit's own --nproc) is a per-real-UID, system-wide limit -- NOT scoped to
 * this sandbox's own process tree. A small absolute constant breaks the instant the invoking
 * user's REAL total process count already exceeds it (routine on a heavily-used workstation
 * with several long-running agent sessions): any further thread/fork Bun's own runtime needs
 * internally (confirmed live: its native TS transpiler spawns one) immediately fails, surfacing
 * as an unrecoverable SIGABRT (exit 134) with no output at all, not a catchable error. Correct
 * enforcement of "at most N NEW processes the sandboxed extension can spawn" requires an offset
 * from the CURRENT real count, not an absolute cap. Returns 0 (never throws) if /proc can't be
 * read at all -- the caller's own maxProcesses then applies as an absolute floor, same as before
 * this existed.
 */
function currentProcessCountForUid(uid: number): number {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return 0;
	}
	let count = 0;
	for (const entry of entries.slice(0, MAX_PROCESS_SCAN_ENTRIES)) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const status = readFileSync(`/proc/${entry}/status`, "utf8");
			const match = status.match(/^Uid:\s+(\d+)/m);
			if (match && Number(match[1]) === uid) count++;
		} catch {
			// The process exited mid-scan, or is otherwise unreadable -- not this sandbox's concern.
		}
	}
	return count;
}

function sandboxCommand(packageRoot: string, extensionPath: string, maxProcesses: number): string[] | undefined {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/prlimit")) return undefined;
	const serviceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	const packageDirectory = dirname(serviceRoot);
	const childHarness = join(serviceRoot, "src/adoption/smoke-child.ts");
	const jitiModules = resolveDependencyModulesDir(packageDirectory, "jiti");
	if (!jitiModules) return undefined;
	const bun = realpathSync(process.execPath);
	const args = [
		"/usr/bin/bwrap",
		"--unshare-user",
		"--disable-userns",
		"--unshare-pid",
		"--unshare-net",
		"--unshare-ipc",
		"--unshare-uts",
		"--cap-drop",
		"ALL",
		"--die-with-parent",
		"--new-session",
	];
	addReadOnlyBind(args, "/usr");
	addReadOnlyBind(args, "/lib");
	addReadOnlyBind(args, "/lib64");
	args.push(
		"--dir",
		"/runner",
		"--dir",
		"/runner/src",
		"--ro-bind",
		childHarness,
		"/runner/src/smoke-child.ts",
		"--dir",
		"/runner/node_modules",
		"--ro-bind",
		jitiModules,
		"/runner/node_modules/jiti",
		"--ro-bind",
		bun,
		"/bun",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--size",
		"16777216",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tmp/home",
	);
	// Package-related identity binds go AFTER the virtual/tmpfs mounts above --
	// bwrap applies mounts in argument order, so a bind whose real path happens
	// to sit under one of those special mounts (e.g. a test fixture under
	// /tmp, which --tmpfs /tmp would otherwise shadow) must come later to win.
	addReadOnlyBind(args, packageRoot);
	// Real-path identity binds so a hoisted sibling dependency resolves exactly
	// as it would in Pi's own real, unsandboxed process -- see
	// collectAncestorNodeModulesDirs's own doc comment for why this is needed.
	for (const dir of collectAncestorNodeModulesDirs(packageRoot)) addReadOnlyBind(args, dir);
	args.push(
		"--remount-ro",
		"/",
		"--clearenv",
		"--setenv",
		"HOME",
		"/tmp/home",
		"--setenv",
		"TMPDIR",
		"/tmp",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"NODE_PATH",
		"/runner/node_modules",
		"--chdir",
		packageRoot,
		"--",
		"/usr/bin/prlimit",
		`--nproc=${(typeof process.getuid === "function" ? currentProcessCountForUid(process.getuid()) : 0) + maxProcesses}`,
		"--nofile=64",
		"--fsize=16777216",
		"--as=8589934592",
		"--cpu=5",
		"--",
		"/bun",
		"/runner/src/smoke-child.ts",
		extensionPath,
	);
	return args;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onLimit: () => void): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				onLimit();
				break;
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const output = new Uint8Array(Math.min(bytes, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		const remaining = output.byteLength - offset;
		if (remaining <= 0) break;
		output.set(chunk.subarray(0, remaining), offset);
		offset += Math.min(chunk.byteLength, remaining);
	}
	return new TextDecoder().decode(output.subarray(0, offset));
}

function normalizeRegistrations(value: unknown): SmokeRegistrations {
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	let remaining = 100;
	const names = (kind: keyof SmokeRegistrations): string[] => {
		if (!Array.isArray(record[kind]) || remaining === 0) return [];
		const result = record[kind]
			.filter((item): item is string => typeof item === "string")
			.slice(0, remaining)
			.map((item) => item.slice(0, 128));
		remaining -= result.length;
		return result;
	};
	return {
		tools: names("tools"),
		commands: names("commands"),
		shortcuts: names("shortcuts"),
		flags: names("flags"),
		providers: names("providers"),
		events: names("events"),
		renderers: names("renderers"),
		sharedTools: names("sharedTools"),
		sharedCommands: names("sharedCommands"),
		sharedShortcuts: names("sharedShortcuts"),
		sharedFlags: names("sharedFlags"),
	};
}

export async function runExtensionSmoke(
	packagePath: string,
	extensionFile: string,
	options: SmokeOptions = {},
): Promise<ExtensionSmokeResult> {
	const startedAt = Date.now();
	const packageRoot = realpathSync(resolve(packagePath));
	const extensionPath = realpathSync(resolve(extensionFile));
	const relativePath = relative(packageRoot, extensionPath).split(sep).join("/");
	if (relativePath.startsWith("../") || relativePath === "..")
		return {
			path: relativePath,
			status: "capability-denied",
			durationMs: Date.now() - startedAt,
			registrations: { ...EMPTY_REGISTRATIONS },
			message: "extension resolves outside the package",
		};
	const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
	const maxProcesses = bounded(options.maxProcesses, DEFAULT_MAX_PROCESSES, MAX_PROCESSES);
	const command = sandboxCommand(packageRoot, extensionPath, maxProcesses);
	if (!command)
		return {
			path: relativePath,
			status: "sandbox-unavailable",
			durationMs: Date.now() - startedAt,
			registrations: { ...EMPTY_REGISTRATIONS },
			message: "bubblewrap and prlimit are required for smoke mode",
		};

	let timedOut = false;
	let outputLimited = false;
	const process = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const kill = () => {
		try {
			process.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, timeoutMs);
	const stdoutPromise = readBounded(process.stdout, maxOutputBytes, () => {
		outputLimited = true;
		kill();
	});
	const stderrPromise = readBounded(process.stderr, maxOutputBytes, () => {
		outputLimited = true;
		kill();
	});
	const [exitCode, stdout, stderr] = await Promise.all([process.exited, stdoutPromise, stderrPromise]);
	clearTimeout(timer);
	const durationMs = Date.now() - startedAt;
	if (timedOut)
		return {
			path: relativePath,
			status: "timeout",
			durationMs,
			registrations: { ...EMPTY_REGISTRATIONS },
			message: `extension exceeded ${timeoutMs}ms`,
		};
	if (outputLimited)
		return {
			path: relativePath,
			status: "output-limit",
			durationMs,
			registrations: { ...EMPTY_REGISTRATIONS },
			message: `extension exceeded ${maxOutputBytes} output bytes`,
		};
	const line = stdout.trim().split("\n").at(-1) ?? "";
	try {
		const payload = JSON.parse(line) as { status?: unknown; message?: unknown; registrations?: unknown };
		const status =
			payload.status === "ok" || payload.status === "capability-denied" || payload.status === "crash" ? payload.status : "crash";
		return {
			path: relativePath,
			status,
			durationMs,
			registrations: normalizeRegistrations(payload.registrations),
			...(typeof payload.message === "string" ? { message: payload.message.slice(0, 1_000) } : {}),
		};
	} catch {
		const message = (stderr.trim() || `smoke child exited ${exitCode}`).slice(0, 1_000);
		const status: SmokeStatus = /^(?:bwrap:|prlimit:)/i.test(message) ? "sandbox-unavailable" : "crash";
		return { path: relativePath, status, durationMs, registrations: { ...EMPTY_REGISTRATIONS }, message };
	}
}
