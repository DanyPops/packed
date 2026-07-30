import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Diagnostic } from "./check.ts";

export type PackageShapeKind = "keyword-only" | "manifest" | "conventional";

export interface PackageShapeEvidence {
	kind: PackageShapeKind;
	verified: boolean;
	evidence: string[];
}

export interface PackedFile {
	path: string;
	size: number;
	mode?: number;
}

export interface PackReport {
	root: string;
	ok: boolean;
	command: string[];
	name?: string;
	version?: string;
	filename?: string;
	size?: number;
	unpackedSize?: number;
	shasum?: string;
	integrity?: string;
	files: PackedFile[];
	shape: PackageShapeEvidence;
	diagnostics: Diagnostic[];
	truncated: boolean;
}

export interface PackCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	truncated?: boolean;
	timedOut?: boolean;
}

export type PackCommand = (cwd: string, args: string[]) => Promise<PackCommandResult>;

const PACK_ARGS = ["pack", "--dry-run", "--json", "--ignore-scripts"] as const;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|\.npmrc$|\.git(?:\/|$)|id_rsa$|id_ed25519$|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/i;
const CONVENTIONAL_RESOURCE = /^(extensions?|skills?|prompts?|themes?)\//i;

interface NpmPackEntry {
	name?: string;
	version?: string;
	filename?: string;
	size?: number;
	unpackedSize?: number;
	shasum?: string;
	integrity?: string;
	files?: Array<{ path?: string; size?: number; mode?: number }>;
}

function boundedText(stream: ReadableStream<Uint8Array>, maxBytes: number, onLimit: () => void): Promise<{ text: string; truncated: boolean }> {
	return (async () => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		let truncated = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (bytes + value.byteLength > maxBytes) {
				const remaining = Math.max(0, maxBytes - bytes);
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				truncated = true;
				onLimit();
				break;
			}
			chunks.push(value);
			bytes += value.byteLength;
		}
		const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
		return { text: new TextDecoder().decode(merged), truncated };
	})();
}

export const runNpmPack: PackCommand = async (cwd, args) => {
	const proc = Bun.spawn(["npm", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; proc.kill(); }, TIMEOUT_MS);
	const kill = () => proc.kill();
	const [stdout, stderr, code] = await Promise.all([
		boundedText(proc.stdout, MAX_OUTPUT_BYTES, kill),
		boundedText(proc.stderr, 64 * 1024, kill),
		proc.exited,
	]);
	clearTimeout(timer);
	return { code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated, timedOut };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringPatterns(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
}

function normalize(path: string): string {
	return path.replace(/^\.\//, "").replaceAll("\\", "/");
}

function matches(path: string, pattern: string): boolean {
	const normalized = normalize(pattern);
	try {
		return /[*?{[\]]/.test(normalized)
			? new Bun.Glob(normalized).match(path)
			: path === normalized || path.startsWith(`${normalized.replace(/\/$/, "")}/`);
	} catch {
		return false;
	}
}

function inspectShape(pkg: Record<string, unknown>, files: PackedFile[]): PackageShapeEvidence {
	const paths = files.map((file) => file.path);
	const pi = isRecord(pkg.pi) ? pkg.pi : undefined;
	const evidence: string[] = [];
	if (pi) {
		for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
			if (stringPatterns(pi[field]).some((pattern) => paths.some((path) => matches(path, pattern)))) evidence.push(`pi.${field}`);
		}
	}
	if (evidence.length > 0) return { kind: "manifest", verified: true, evidence };
	const conventional = [...new Set(paths.filter((path) => CONVENTIONAL_RESOURCE.test(path)).map((path) => path.split("/")[0]!))].slice(0, 20);
	if (conventional.length > 0) return { kind: "conventional", verified: true, evidence: conventional };
	return { kind: "keyword-only", verified: true, evidence: ["no Pi manifest resources or conventional resource directories in tarball"] };
}

function failed(root: string, code: string, message: string): PackReport {
	return {
		root, ok: false, command: ["npm", ...PACK_ARGS], files: [],
		shape: { kind: "keyword-only", verified: false, evidence: [] },
		diagnostics: [{ code, severity: "error", path: "package.json", message: message.slice(0, 4_000) }], truncated: false,
	};
}

export class NpmPackVerifier {
	constructor(private readonly command: PackCommand = runNpmPack) {}

	async verify(packagePath: string): Promise<PackReport> {
		let root: string;
		let pkg: Record<string, unknown>;
		try {
			root = realpathSync(resolve(packagePath));
			const raw = readFileSync(resolve(root, "package.json"));
			if (raw.byteLength > MAX_MANIFEST_BYTES) return failed(root, "PACK_MANIFEST_TOO_LARGE", "package.json exceeds the 1 MiB verification bound");
			pkg = JSON.parse(raw.toString()) as Record<string, unknown>;
		} catch (error) {
			return failed(resolve(packagePath), "PACK_MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
		}

		let result: PackCommandResult;
		try { result = await this.command(root, [...PACK_ARGS]); }
		catch (error) { return failed(root, "PACK_COMMAND_FAILED", error instanceof Error ? error.message : String(error)); }
		if (result.timedOut) return failed(root, "PACK_TIMEOUT", `npm pack exceeded ${TIMEOUT_MS} ms`);
		if (result.code !== 0) return failed(root, "PACK_COMMAND_FAILED", (result.stderr || `npm pack exited ${result.code}`).slice(0, 4_000));
		if (result.truncated) return failed(root, "PACK_OUTPUT_LIMIT", "npm pack output exceeded its bounded capture");

		let entry: NpmPackEntry;
		try {
			const parsed = JSON.parse(result.stdout) as unknown;
			if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) throw new Error("expected one npm pack result");
			entry = parsed[0] as NpmPackEntry;
		} catch (error) {
			return failed(root, "PACK_JSON_INVALID", error instanceof Error ? error.message : String(error));
		}

		const rawFiles = Array.isArray(entry.files) ? entry.files : [];
		const truncated = rawFiles.length > MAX_FILES;
		const files = rawFiles.slice(0, MAX_FILES).flatMap((file) => typeof file.path === "string"
			? [{ path: normalize(file.path).slice(0, 4_096), size: Number.isFinite(file.size) ? Math.max(0, Number(file.size)) : 0, mode: file.mode }]
			: []);
		const diagnostics: Diagnostic[] = [];
		if (truncated) diagnostics.push({ code: "PACK_FILE_LIMIT", severity: "error", path: ".", message: `tarball has more than ${MAX_FILES} files` });
		for (const file of files) {
			if (isAbsolute(file.path) || file.path.split("/").includes("..")) diagnostics.push({ code: "PACK_PATH_INVALID", severity: "error", path: file.path, message: "npm pack reported a path outside the package tarball root" });
			if (SENSITIVE_PATH.test(file.path)) diagnostics.push({ code: "PACK_SENSITIVE_FILE", severity: "error", path: file.path, message: "sensitive-looking file is included in the npm tarball" });
		}
		const pi = isRecord(pkg.pi) ? pkg.pi : undefined;
		if (pi) {
			for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
				for (const pattern of stringPatterns(pi[field])) {
					if (!files.some((file) => matches(file.path, pattern))) diagnostics.push({ code: "PACK_DECLARED_RESOURCE_MISSING", severity: "error", path: "package.json", message: `pi.${field} resource ${pattern} is absent from npm pack output` });
				}
			}
		}
		if ((entry.unpackedSize ?? 0) > 20 * 1024 * 1024) diagnostics.push({ code: "PACK_UNPACKED_SIZE_HIGH", severity: "warning", path: ".", message: "tarball expands beyond 20 MiB" });

		return {
			root, ok: !diagnostics.some((item) => item.severity === "error"), command: ["npm", ...PACK_ARGS],
			name: entry.name, version: entry.version, filename: entry.filename, size: entry.size,
			unpackedSize: entry.unpackedSize, shasum: entry.shasum, integrity: entry.integrity,
			files, shape: inspectShape(pkg, files), diagnostics, truncated,
		};
	}
}

export function formatPackReport(report: PackReport, json = false): string {
	if (json) {
		let fileLimit = Math.min(report.files.length, 200);
		let value: PackReport & { outputTruncated?: boolean } = report;
		let encoded = JSON.stringify(value);
		while (encoded.length > 64 * 1024 && fileLimit > 0) {
			fileLimit = Math.floor(fileLimit / 2);
			value = { ...report, files: report.files.slice(0, fileLimit), diagnostics: report.diagnostics.slice(0, 10), outputTruncated: true };
			encoded = JSON.stringify(value);
		}
		return encoded + "\n";
	}
	let out = `${report.ok ? "ok" : "failed"}: ${report.name ?? report.root}${report.version ? `@${report.version}` : ""}\n`;
	out += `shape: ${report.shape.kind}${report.shape.verified ? " (verified from npm pack output)" : ""}\n`;
	if (report.integrity) out += `integrity: ${report.integrity}\n`;
	out += `files: ${report.files.length}, packed: ${report.size ?? "?"} bytes, unpacked: ${report.unpackedSize ?? "?"} bytes\n`;
	for (const diagnostic of report.diagnostics) out += `${diagnostic.severity} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}\n`;
	return out.slice(0, 16 * 1024);
}
