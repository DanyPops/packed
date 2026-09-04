import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { readDaemonHandle } from "@danypops/vehicle-server/paths";
import { daemonOptions } from "../src/daemon/daemon.ts";
import { probe } from "../src/daemon/client.ts";
import { runDaemonProcess } from "@danypops/vehicle-server/daemon";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/daemon/service.ts";
import { writeIndex } from "../src/index/build-index.ts";
import { dbPath, openDb, replaceAll } from "../src/packages/db.ts";
import type { Pkg } from "../src/packages/package.ts";
import { HttpRegistry } from "../src/registry/registry.ts";
import { resolvePackedPaths } from "../src/shared/paths.ts";

const MAX_COMMAND_OUTPUT_BYTES = 256_000;
const MAX_ARTIFACT_BYTES = 256_000;
const SERVICE_READY_DEADLINE_MS = 15_000;
const FREQUENCY_WINDOW_DAYS = 14;
const DOCTOR_EXTENSION_COUNT = 24;
const BENCHMARK_FILE = ".artifacts/benchmarks/packed-baseline.json";

type BenchmarkMode =
	| "idle-polling"
	| "cached-reads-cold"
	| "cached-reads-warm"
	| "doctor-cold"
	| "doctor-warm"
	| "doctor-concurrent"
	| "catalog-sync-cold"
	| "catalog-sync-warm"
	| "index-build-cold"
	| "index-build-warm"
	| "updates-project";

export interface BenchmarkScenario {
	readonly name: BenchmarkMode;
	readonly warmup: number;
	readonly repetitions: number;
	readonly concurrency: number;
	readonly deadlineMs: number;
}

export const PACKED_BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
	{ name: "idle-polling", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 30_000 },
	{ name: "cached-reads-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 30_000 },
	{ name: "cached-reads-warm", warmup: 1, repetitions: 5, concurrency: 1, deadlineMs: 30_000 },
	{ name: "doctor-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 120_000 },
	{ name: "doctor-warm", warmup: 1, repetitions: 3, concurrency: 1, deadlineMs: 120_000 },
	{ name: "doctor-concurrent", warmup: 0, repetitions: 2, concurrency: 2, deadlineMs: 120_000 },
	{ name: "catalog-sync-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 60_000 },
	{ name: "catalog-sync-warm", warmup: 1, repetitions: 3, concurrency: 1, deadlineMs: 60_000 },
	{ name: "index-build-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 120_000 },
	{ name: "index-build-warm", warmup: 1, repetitions: 3, concurrency: 1, deadlineMs: 120_000 },
	{ name: "updates-project", warmup: 1, repetitions: 5, concurrency: 1, deadlineMs: 30_000 },
]);

function isBenchmarkMode(value: string | undefined): value is BenchmarkMode {
	return PACKED_BENCHMARK_SCENARIOS.some((scenario) => scenario.name === value);
}

interface BenchmarkClient {
	invoke(operation: string, input: Record<string, unknown>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Runs one bounded workload and returns only a correctness digest. */
export async function runBenchmarkWorkload(mode: BenchmarkMode, client: BenchmarkClient, projectRoot: string): Promise<string> {
	if (mode === "idle-polling") {
		await Bun.sleep(1_000);
		return digest({ elapsed: "bounded-idle-window" });
	}
	if (mode === "cached-reads-cold" || mode === "cached-reads-warm") {
		const catalog = record(await client.invoke("package.catalog", {}));
		const index = record(await client.invoke("package.index", {}));
		const updates = record(await client.invoke("package.updates", {}));
		return digest({
			catalogPackages: Array.isArray(catalog.packages) ? catalog.packages.length : 0,
			indexPackages: Array.isArray(index.packages) ? index.packages.length : 0,
			updates: Array.isArray(updates.updates) ? updates.updates.length : 0,
		});
	}
	if (mode === "doctor-cold" || mode === "doctor-warm" || mode === "doctor-concurrent") {
		const report = record(await client.invoke("doctor.run", { projectRoot }));
		return digest({ ok: report.ok, scanned: report.scanned, conflicts: Array.isArray(report.conflicts) ? report.conflicts.length : 0 });
	}
	if (mode === "catalog-sync-cold" || mode === "catalog-sync-warm") {
		const result = record(await client.invoke("package.catalog.sync", {}));
		return digest({ synced: result.synced });
	}
	if (mode === "index-build-cold" || mode === "index-build-warm") {
		const result = record(await client.invoke("package.index.build", {}));
		return digest({ packages: Array.isArray(result.packages) ? result.packages.length : 0, truncated: result.truncated });
	}
	const result = record(await client.invoke("package.updates.project", { projectRoot }));
	return digest({ updates: Array.isArray(result.updates) ? result.updates.length : 0 });
}

interface FrequencyObservation {
	readonly since: string;
	readonly until: string;
	readonly days: number;
	readonly calls: number;
}

interface AvailableProjection extends FrequencyObservation {
	readonly status: "available";
	readonly source: "packed metrics.query";
	readonly callsPerDay: number;
	readonly projectedDailyCpuMs: number;
	readonly projectedDailyWallMs: number;
}

type FrequencyProjection = AvailableProjection | { readonly status: "unavailable" };

export function doctorDailyProjection(observation: FrequencyObservation, cpuMsPerCall: number, wallMsPerCall: number): AvailableProjection {
	const callsPerDay = observation.calls / observation.days;
	return {
		status: "available",
		source: "packed metrics.query",
		...observation,
		callsPerDay,
		projectedDailyCpuMs: callsPerDay * cpuMsPerCall,
		projectedDailyWallMs: callsPerDay * wallMsPerCall,
	};
}

interface ArtifactInput {
	readonly generatedAt: string;
	readonly environment: { readonly platform: string; readonly architecture: string; readonly runtime: string; readonly logicalCpuCount: number };
	readonly frequency: FrequencyProjection;
	readonly results: readonly { readonly name: string; readonly phase?: string; readonly benchmark: unknown }[];
}

export function benchmarkArtifact(input: ArtifactInput): ArtifactInput & { readonly schemaVersion: 1; readonly networkBytes: "unavailable" } {
	const artifact = { schemaVersion: 1 as const, networkBytes: "unavailable" as const, ...input };
	if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES) throw new Error("benchmark artifact exceeds 256000 bytes");
	return artifact;
}

const FIXTURE_PACKAGES: readonly Pkg[] = Object.freeze(
	Array.from({ length: 24 }, (_, index) => ({
		name: `bench-pi-${index}`,
		version: "1.0.0",
		description: `Synthetic Pi package ${index}`,
		date: "2026-01-01T00:00:00.000Z",
		packageEvidence: { shape: "manifest" as const, verified: false, evidence: ["synthetic benchmark fixture"] },
		publication: { trustedPublisher: "unknown" as const },
	})),
);

function startRegistryFixture(): { readonly baseUrl: string; close(): void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			await Bun.sleep(10);
			const url = new URL(request.url);
			if (url.pathname === "/-/v1/search") {
				const from = Math.max(0, Number(url.searchParams.get("from") ?? 0));
				const size = Math.min(20, Math.max(1, Number(url.searchParams.get("size") ?? 5)));
				const objects = FIXTURE_PACKAGES.slice(from, from + size).map((item) => ({ package: item }));
				return Response.json({ total: FIXTURE_PACKAGES.length, objects });
			}
			const encodedName = url.pathname.replace(/^\//, "").replace(/\/latest$/, "");
			const name = decodeURIComponent(encodedName);
			const pkg = FIXTURE_PACKAGES.find((item) => item.name === name);
			if (!pkg) return new Response("missing", { status: 404 });
			if (url.pathname.endsWith("/latest")) {
				return Response.json({ ...pkg, license: "MIT", keywords: ["pi-package"], pi: { extensions: ["extension/index.ts"] } });
			}
			return Response.json({ modified: pkg.date, readme: "Synthetic benchmark package." });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

function isolatedEnvironment(root: string, idlePolling: boolean): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: root,
		PI_PACKED_HOME: join(root, "state"),
		PI_PACKED_PI_HOME: join(root, "pi-home"),
		PI_PACKED_WATCH_SECS: idlePolling ? "0.1" : "0",
		PI_PACKED_CATALOG_SECS: "0",
		PI_PACKED_INDEX_SECS: "0",
		PI_PACKED_RECONCILE_SECS: "0",
		PI_PACKED_IDLE_SECS: "600",
		PI_PACKED_PI_BIN: "/usr/bin/false",
		PI_OFFLINE: "1",
	};
}

async function initializeSyntheticHome(root: string, includeIndex: boolean): Promise<void> {
	const state = join(root, "state");
	const piHome = join(root, "pi-home");
	const projectHome = join(root, "project", ".pi");
	await mkdir(state, { recursive: true });
	await mkdir(piHome, { recursive: true });
	await mkdir(projectHome, { recursive: true });
	const configured = FIXTURE_PACKAGES.slice(0, DOCTOR_EXTENSION_COUNT).map((pkg) => `npm:${pkg.name}@0.1.0`);
	await writeFile(join(piHome, "settings.json"), JSON.stringify({ packages: configured }));
	await writeFile(join(projectHome, "settings.json"), JSON.stringify({ packages: [] }));
	for (const [index, pkg] of FIXTURE_PACKAGES.slice(0, DOCTOR_EXTENSION_COUNT).entries()) {
		const directory = join(piHome, "npm", "node_modules", pkg.name);
		await mkdir(join(directory, "extension"), { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, pi: { extensions: ["extension/index.ts"] } }));
		await writeFile(join(directory, "extension", "index.ts"), `export default function (pi: any) { pi.registerTool({ name: "bench_tool_${index}" }); }\n`);
	}
	const database = openDb(dbPath(state));
	try {
		replaceAll(database, [...FIXTURE_PACKAGES], "synthetic:localhost");
	} finally {
		database.close();
	}
	await writeFile(join(state, "updates.json"), JSON.stringify({ checkedAt: "2026-01-01T00:00:00.000Z", updates: [] }));
	if (includeIndex) await writeIndex(join(state, "index.json"), { generatedAt: new Date().toISOString(), packages: [], truncated: false });
}

function commandResult(
	command: string,
	arguments_: readonly string[],
	environment: Record<string, string> = process.env as Record<string, string>,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolveCommand) => {
		execFile(
			command,
			[...arguments_],
			{ env: environment, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES, timeout: 240_000 },
			(error, stdout, stderr) => {
				resolveCommand({ ok: !error, stdout, stderr });
			},
		);
	});
}

async function command(commandName: string, arguments_: readonly string[], environment?: Record<string, string>): Promise<string> {
	const result = await commandResult(commandName, arguments_, environment);
	if (!result.ok) throw new Error(`benchmark command failed: ${basename(commandName)}`);
	return result.stdout;
}

async function waitForService(root: string, environment: Record<string, string>): Promise<void> {
	const paths = resolvePackedPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	const deadline = Date.now() + SERVICE_READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (readDaemonHandle(paths.handle)) return;
		await Bun.sleep(50);
	}
	throw new Error("benchmark service readiness deadline exceeded");
}

async function stopUnit(unit: string): Promise<void> {
	try {
		await command("systemctl", ["--user", "stop", unit]);
	} catch {
		// Cleanup remains best-effort after a failed transient unit.
	}
}

async function runScenario(scenario: BenchmarkScenario, registryBase: string, index: number): Promise<{ readonly name: string; readonly phase: string; readonly benchmark: unknown }> {
	const root = await mkdtemp(join(tmpdir(), "packed-benchmark-"));
	const includeIndex = !scenario.name.startsWith("index-build");
	await initializeSyntheticHome(root, includeIndex);
	const environment = isolatedEnvironment(root, scenario.name === "idle-polling");
	const vehicle = `packed-bench-${index}`;
	const unit = `armada-${vehicle}.service`;
	const benchmarkFile = fileURLToPath(import.meta.url);
	const manifestPath = join(root, "armada.json");
	const paths = resolvePackedPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	await writeFile(
		manifestPath,
		JSON.stringify({ schemaVersion: 1, vehicles: [{ name: vehicle, version: "0.0.0", executable: process.execPath, arguments: [benchmarkFile, "serve", root, registryBase], handlePath: paths.handle, restart: { policy: "never" }, readiness: { timeoutMs: SERVICE_READY_DEADLINE_MS, pollIntervalMs: 50 } }] }),
	);
	try {
		const names = ["HOME", "PI_PACKED_HOME", "PI_PACKED_PI_HOME", "PI_PACKED_WATCH_SECS", "PI_PACKED_CATALOG_SECS", "PI_PACKED_INDEX_SECS", "PI_PACKED_RECONCILE_SECS", "PI_PACKED_IDLE_SECS", "PI_PACKED_PI_BIN", "PI_OFFLINE"];
		await command("systemd-run", [
			"--user",
			`--unit=${unit}`,
			"--collect",
			"--property=Type=exec",
			"--property=Restart=no",
			...names.map((name) => `--setenv=${name}=${environment[name] ?? ""}`),
			process.execPath,
			benchmarkFile,
			"serve",
			root,
			registryBase,
		]);
		await waitForService(root, environment);
		const armadaArguments = [
			"benchmark", vehicle, "--manifest", manifestPath,
			"--exec", process.execPath,
			"--arg", benchmarkFile, "--arg", "workload", "--arg", scenario.name, "--arg", root,
			"--warmup", String(scenario.warmup), "--repetitions", String(scenario.repetitions), "--concurrency", String(scenario.concurrency),
			"--deadline-ms", String(scenario.deadlineMs), "--sample-ms", "25", "--max-output-bytes", "1024", "--json",
		];
		const armadaCli = process.env.ARMADA_CLI;
		const armadaResult = armadaCli
			? await commandResult(process.execPath, [armadaCli, ...armadaArguments])
			: await commandResult(process.env.ARMADA_BIN ?? "armada", armadaArguments);
		if (armadaResult.stdout.trim().length === 0) {
			throw new Error(`${scenario.name} benchmark produced no JSON: ${armadaResult.stderr.trim().slice(0, 500) || "no diagnostic"}`);
		}
		const output = JSON.parse(armadaResult.stdout) as {
			benchmark?: { workload?: { failureCodes?: Record<string, number> } };
			diagnostics?: Array<{ code?: string }>;
		};
		if (!armadaResult.ok) {
			const failureCode = Object.keys(output.benchmark?.workload?.failureCodes ?? {})[0] ?? output.diagnostics?.[0]?.code ?? "unknown";
			throw new Error(`${scenario.name} benchmark failed: ${failureCode}`);
		}
		if (!output.benchmark) throw new Error("benchmark result missing");
		const phase = scenario.name.startsWith("catalog-sync") || scenario.name.startsWith("index-build") ? "localhost-registry-wait-and-local-compute" : scenario.name === "doctor-cold" || scenario.name === "doctor-warm" || scenario.name === "doctor-concurrent" ? "sandboxed-subprocess-and-local-compute" : "local-compute";
		return { name: scenario.name, phase, benchmark: output.benchmark };
	} finally {
		await stopUnit(unit);
		await rm(root, { recursive: true, force: true });
	}
}

async function connectBenchmarkClient(root: string): Promise<BenchmarkClient> {
	const environment = isolatedEnvironment(root, false);
	const paths = resolvePackedPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("benchmark daemon handle unavailable");
	const token = (await readFile(paths.token, "utf8")).trim();
	const rpc = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${handle.host}:${handle.port}`, token, { label: "Packed benchmark" });
	return { invoke: (operation, input) => rpc.call(operation as OperationName, input as OperationInputs[OperationName]) };
}

async function workloadMain(args: readonly string[]): Promise<void> {
	const [mode, root] = args;
	if (!isBenchmarkMode(mode) || !root) throw new Error("invalid benchmark workload input");
	const client = await connectBenchmarkClient(root);
	const correctnessDigest = await runBenchmarkWorkload(mode, client, join(root, "project"));
	process.stdout.write(`${correctnessDigest}\n`);
}

async function serveMain(args: readonly string[]): Promise<void> {
	const [root, registryBase] = args;
	if (!root || !registryBase) throw new Error("invalid benchmark service input");
	const environment = isolatedEnvironment(root, process.env.PI_PACKED_WATCH_SECS === "0.1");
	const paths = resolvePackedPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	const registry = new HttpRegistry(registryBase, 5, 0, 1, registryBase);
	runDaemonProcess({ ...daemonOptions({ paths, reg: registry, piHome: join(root, "pi-home"), env: environment, migrateLegacy: false }), onListen: () => {} });
}

function configuredDoctorFrequency(): FrequencyObservation | undefined {
	const calls = Number(process.env.PACKED_BENCHMARK_DOCTOR_CALLS);
	const days = Number(process.env.PACKED_BENCHMARK_OBSERVATION_DAYS ?? FREQUENCY_WINDOW_DAYS);
	if (!Number.isSafeInteger(calls) || calls < 0 || !Number.isSafeInteger(days) || days < 1 || days > 31) return undefined;
	const untilDate = new Date();
	untilDate.setUTCHours(0, 0, 0, 0);
	const sinceDate = new Date(untilDate.getTime() - days * 86_400_000);
	return { since: sinceDate.toISOString().slice(0, 10), until: untilDate.toISOString().slice(0, 10), days, calls };
}

async function observeDoctorFrequency(): Promise<FrequencyObservation | undefined> {
	try {
		const handle = await probe();
		if (!handle) return configuredDoctorFrequency();
		const untilDate = new Date();
		untilDate.setUTCHours(0, 0, 0, 0);
		const sinceDate = new Date(untilDate.getTime() - FREQUENCY_WINDOW_DAYS * 86_400_000);
		type MetricsName = "metrics.query";
		type MetricsInputs = { "metrics.query": { since: number; until: number; source: "server"; toolName: string; groupBy: string[] } };
		type MetricsOutputs = { "metrics.query": Array<{ count?: number }> };
		const rpc = new AuthenticatedRpcClient<MetricsName, MetricsInputs, MetricsOutputs>(handle.base, handle.token, { label: "Packed metrics" });
		const rows = await rpc.call("metrics.query", { since: sinceDate.getTime(), until: untilDate.getTime(), source: "server", toolName: "doctor.run", groupBy: ["day"] });
		const calls = rows.slice(0, 31).reduce((sum, row) => sum + (Number.isFinite(row.count) ? Math.max(0, Number(row.count)) : 0), 0);
		return { since: sinceDate.toISOString().slice(0, 10), until: untilDate.toISOString().slice(0, 10), days: FREQUENCY_WINDOW_DAYS, calls };
	} catch {
		return configuredDoctorFrequency();
	}
}

function workloadMetrics(result: { readonly name: string; readonly benchmark: unknown }, mode: string): { cpuMsPerCall: number; wallMsPerCall: number } | undefined {
	if (result.name !== mode) return undefined;
	const workload = record(record(result.benchmark).workload);
	const invocations = Number(workload.invocations);
	const cpuMs = Number(workload.idleAdjustedCpuMs ?? workload.cpuMs);
	const wallMs = Number(workload.wallMs);
	if (!(invocations > 0) || !Number.isFinite(cpuMs) || !Number.isFinite(wallMs)) return undefined;
	return { cpuMsPerCall: cpuMs / invocations, wallMsPerCall: wallMs / invocations };
}

async function baselineMain(): Promise<void> {
	if (platform() !== "linux") throw new Error("Packed cgroup benchmarks require Linux");
	const observation = await observeDoctorFrequency();
	const fixture = startRegistryFixture();
	try {
		const results = [];
		for (let index = 0; index < PACKED_BENCHMARK_SCENARIOS.length; index++) {
			const scenario = PACKED_BENCHMARK_SCENARIOS[index];
			if (scenario) results.push(await runScenario(scenario, fixture.baseUrl, index));
		}
		const doctor = results.map((result) => workloadMetrics(result, "doctor-warm")).find((value) => value !== undefined);
		const frequency = observation && doctor ? doctorDailyProjection(observation, doctor.cpuMsPerCall, doctor.wallMsPerCall) : { status: "unavailable" as const };
		const artifact = benchmarkArtifact({ generatedAt: new Date().toISOString(), environment: { platform: platform(), architecture: arch(), runtime: basename(process.execPath), logicalCpuCount: cpus().length }, frequency, results });
		const destination = join(fileURLToPath(new URL("../../../../", import.meta.url)), BENCHMARK_FILE);
		await mkdir(dirname(destination), { recursive: true });
		const temporary = `${destination}.tmp`;
		await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
		await rename(temporary, destination);
		process.stdout.write(`Packed benchmark: ${results.length} workloads; artifact ${BENCHMARK_FILE}\n`);
	} finally {
		fixture.close();
	}
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "workload") await workloadMain(process.argv.slice(3));
		else if (process.argv[2] === "serve") await serveMain(process.argv.slice(3));
		else await baselineMain();
	} catch (error) {
		process.stderr.write(`Packed benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
