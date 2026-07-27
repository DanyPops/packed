import { existsSync, realpathSync } from "node:fs";
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
const EMPTY_REGISTRATIONS: SmokeRegistrations = { tools: [], commands: [], shortcuts: [], flags: [], providers: [], events: [], renderers: [] };

function bounded(value: number | undefined, fallback: number, maximum: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
	return Math.min(Math.floor(value), maximum);
}

function addReadOnlyBind(args: string[], path: string): void {
	if (existsSync(path)) args.push("--ro-bind", path, path);
}

function sandboxCommand(packageRoot: string, extensionPath: string, maxProcesses: number): string[] | undefined {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/prlimit")) return undefined;
	const runnerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const childHarness = join(runnerRoot, "src/smoke-child.ts");
	const runnerModules = join(runnerRoot, "node_modules");
	const jitiModules = realpathSync(join(runnerModules, "jiti"));
	const bun = realpathSync(process.execPath);
	const relativeExtension = relative(packageRoot, extensionPath).split(sep).join("/");
	const args = [
		"/usr/bin/bwrap",
		"--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
		"--cap-drop", "ALL", "--die-with-parent", "--new-session",
	];
	addReadOnlyBind(args, "/usr");
	addReadOnlyBind(args, "/lib");
	addReadOnlyBind(args, "/lib64");
	args.push(
		"--dir", "/runner", "--dir", "/runner/src",
		"--ro-bind", childHarness, "/runner/src/smoke-child.ts",
		"--dir", "/runner/node_modules",
		"--ro-bind", jitiModules, "/runner/node_modules/jiti",
		"--ro-bind", packageRoot, "/package",
		"--ro-bind", bun, "/bun",
		"--dev", "/dev", "--proc", "/proc", "--size", "16777216", "--tmpfs", "/tmp", "--dir", "/tmp/home",
		"--remount-ro", "/",
		"--clearenv",
		"--setenv", "HOME", "/tmp/home",
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "NODE_PATH", "/runner/node_modules",
		"--chdir", "/package",
		"--",
		"/usr/bin/prlimit", `--nproc=${maxProcesses}`, "--nofile=64", "--fsize=16777216", "--as=8589934592", "--cpu=5",
		"--", "/bun", "/runner/src/smoke-child.ts", `/package/${relativeExtension}`,
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
	const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
	let remaining = 100;
	const names = (kind: keyof SmokeRegistrations): string[] => {
		if (!Array.isArray(record[kind]) || remaining === 0) return [];
		const result = record[kind].filter((item): item is string => typeof item === "string").slice(0, remaining).map((item) => item.slice(0, 128));
		remaining -= result.length;
		return result;
	};
	return { tools: names("tools"), commands: names("commands"), shortcuts: names("shortcuts"), flags: names("flags"), providers: names("providers"), events: names("events"), renderers: names("renderers") };
}

export async function runExtensionSmoke(packagePath: string, extensionFile: string, options: SmokeOptions = {}): Promise<ExtensionSmokeResult> {
	const startedAt = Date.now();
	const packageRoot = realpathSync(resolve(packagePath));
	const extensionPath = realpathSync(resolve(extensionFile));
	const relativePath = relative(packageRoot, extensionPath).split(sep).join("/");
	if (relativePath.startsWith("../") || relativePath === "..") return { path: relativePath, status: "capability-denied", durationMs: Date.now() - startedAt, registrations: { ...EMPTY_REGISTRATIONS }, message: "extension resolves outside the package" };
	const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
	const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
	const maxProcesses = bounded(options.maxProcesses, DEFAULT_MAX_PROCESSES, MAX_PROCESSES);
	const command = sandboxCommand(packageRoot, extensionPath, maxProcesses);
	if (!command) return { path: relativePath, status: "sandbox-unavailable", durationMs: Date.now() - startedAt, registrations: { ...EMPTY_REGISTRATIONS }, message: "bubblewrap and prlimit are required for smoke mode" };

	let timedOut = false;
	let outputLimited = false;
	const process = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const kill = () => { try { process.kill("SIGKILL"); } catch { /* already exited */ } };
	const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
	const stdoutPromise = readBounded(process.stdout, maxOutputBytes, () => { outputLimited = true; kill(); });
	const stderrPromise = readBounded(process.stderr, maxOutputBytes, () => { outputLimited = true; kill(); });
	const [exitCode, stdout, stderr] = await Promise.all([process.exited, stdoutPromise, stderrPromise]);
	clearTimeout(timer);
	const durationMs = Date.now() - startedAt;
	if (timedOut) return { path: relativePath, status: "timeout", durationMs, registrations: { ...EMPTY_REGISTRATIONS }, message: `extension exceeded ${timeoutMs}ms` };
	if (outputLimited) return { path: relativePath, status: "output-limit", durationMs, registrations: { ...EMPTY_REGISTRATIONS }, message: `extension exceeded ${maxOutputBytes} output bytes` };
	const line = stdout.trim().split("\n").at(-1) ?? "";
	try {
		const payload = JSON.parse(line) as { status?: unknown; message?: unknown; registrations?: unknown };
		const status = payload.status === "ok" || payload.status === "capability-denied" || payload.status === "crash" ? payload.status : "crash";
		return { path: relativePath, status, durationMs, registrations: normalizeRegistrations(payload.registrations), ...(typeof payload.message === "string" ? { message: payload.message.slice(0, 1_000) } : {}) };
	} catch {
		const message = (stderr.trim() || `smoke child exited ${exitCode}`).slice(0, 1_000);
		const status: SmokeStatus = /^(?:bwrap:|prlimit:)/i.test(message) ? "sandbox-unavailable" : "crash";
		return { path: relativePath, status, durationMs, registrations: { ...EMPTY_REGISTRATIONS }, message };
	}
}
