#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateRepositoryPolicy, type RepositoryManifest, type RepositoryPolicy } from "../public/repository-policy.js";

interface CliOptions {
	readonly root: string;
	readonly json: boolean;
}

interface OperationalError {
	readonly code: string;
	readonly message: string;
}

type LoadOutcome =
	| {
			readonly ok: true;
			readonly trackedPaths: readonly string[];
			readonly manifests: readonly RepositoryManifest[];
			readonly lockText: string;
			readonly policy: RepositoryPolicy;
	  }
	| { readonly ok: false; readonly error: OperationalError };

type JsonOutcome =
	| { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
	| { readonly ok: false; readonly error: OperationalError };

function options(args: readonly string[]): CliOptions {
	let root = process.cwd();
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--json") json = true;
		const nextArgument = args[index + 1];
		if (argument === "--root" && nextArgument !== undefined) {
			root = resolve(nextArgument);
			index += 1;
		}
	}
	return { root, json };
}

function parseJson(path: string): JsonOutcome {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { ok: false, error: { code: "INVALID_JSON_OBJECT", message: `${path} must contain a JSON object` } };
		}
		return { ok: true, value: value as Readonly<Record<string, unknown>> };
	} catch (error) {
		return {
			ok: false,
			error: { code: "JSON_UNAVAILABLE", message: `${path}: ${error instanceof Error ? error.message : String(error)}` },
		};
	}
}

function load(root: string): LoadOutcome {
	const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 });
	if (tracked.status !== 0 || tracked.error) {
		return {
			ok: false,
			error: {
				code: "TRACKED_FILES_UNAVAILABLE",
				message: "Cannot read tracked files; run packed-policy from a Git repository",
			},
		};
	}
	const trackedPaths = tracked.stdout.toString("utf8").split("\0").filter(Boolean);
	const manifests: RepositoryManifest[] = [];
	for (const path of trackedPaths.filter((candidate) => candidate === "package.json" || candidate.endsWith("/package.json"))) {
		const parsed = parseJson(resolve(root, path));
		if (!parsed.ok) return parsed;
		manifests.push({ path, value: parsed.value });
	}

	let lockText: string;
	try {
		lockText = readFileSync(resolve(root, "bun.lock"), "utf8");
	} catch (error) {
		return {
			ok: false,
			error: { code: "LOCKFILE_UNAVAILABLE", message: `bun.lock: ${error instanceof Error ? error.message : String(error)}` },
		};
	}

	let policy: RepositoryPolicy = {};
	const policyPath = resolve(root, ".package-policy.json");
	if (existsSync(policyPath)) {
		const parsed = parseJson(policyPath);
		if (!parsed.ok) return parsed;
		policy = parsed.value as RepositoryPolicy;
	}
	return { ok: true, trackedPaths, manifests, lockText, policy };
}

function renderHuman(result: ReturnType<typeof evaluateRepositoryPolicy>): string {
	if (result.ok) return "packed-policy: repository policy passed\n";
	const details = result.violations.map((violation) => {
		if (violation.code === "DUPLICATE_INTERNAL_RESOLUTION") {
			const resolutions = Object.entries(violation.resolutions)
				.map(([version, keys]) => `  ${version}: ${keys.join(", ")}`)
				.join("\n");
			return `${violation.code}: ${violation.message}\n${resolutions}`;
		}
		return `${violation.code}: ${violation.message}`;
	});
	return `packed-policy: ${result.violations.length} violation(s)\n${details.join("\n")}\n`;
}

const cliOptions = options(process.argv.slice(2));
const loaded = load(cliOptions.root);
if (!loaded.ok) {
	const output = { ok: false, error: loaded.error };
	process.stdout.write(cliOptions.json ? `${JSON.stringify(output)}\n` : `packed-policy: ${loaded.error.code}: ${loaded.error.message}\n`);
	process.exitCode = 2;
} else {
	const result = evaluateRepositoryPolicy(loaded);
	process.stdout.write(cliOptions.json ? `${JSON.stringify(result)}\n` : renderHuman(result));
	process.exitCode = result.ok ? 0 : 1;
}
