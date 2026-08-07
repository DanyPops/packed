/**
 * A real, end-to-end multi-package install/update benchmark against a clean, isolated Pi + Packed
 * environment -- the "install/update several packages together" question this exists to answer.
 *
 * As of this file's own history, SetupManager.apply() (service/src/setup/setup.ts) opts into
 * BATCH MODE whenever its Installer implements validate()/installOnly()/reresolveDependencyTree()
 * (ExecInstaller does): every package change is validate()d CONCURRENTLY first (each call stages
 * into its own throwaway temp dir, zero shared state -- see Installer.validate's own doc comment),
 * then installOnly() runs sequentially per package (an unlocked, shared piHome makes concurrent
 * `pi install` calls genuinely unsafe -- confirmed empirically: two of three concurrent installs
 * silently lost their own settings.json/package.json entries even though the CLI itself reported
 * success), and reresolveDependencyTree() (a FULL `npm install` at piHome/npm) runs exactly ONCE
 * for the whole batch instead of once per package. This file's own git history has the "before"
 * numbers (N=10: ~35s, ~24% of it nine redundant reresolves) if you want the direct comparison.
 *
 * "Clean version of Pi with Packed": a freshly created temp directory stands in for ~/.pi --
 * PI_CODING_AGENT_DIR (the real pi CLI's own env override, see @earendil-works/pi-coding-agent's
 * config.js getAgentDir()) points the real `pi` binary at it, and the identical path is handed to
 * SetupManager/ExecInstaller as piHome, so both sides agree on one on-disk state exactly the way a
 * real `packed setup apply` run would. No pi-packed daemon process is started -- SetupManager and
 * ExecInstaller are exactly what the daemon's own setup.apply Vehicle operation calls internally
 * (see service/src/daemon/vehicle-registration.ts), so driving them directly here is the same real
 * production code path minus the HTTP hop.
 *
 * Deliberately real npm packages, not a hand-rolled fake registry: ten tiny, long-published,
 * zero-postinstall-script leaf packages (is-number, is-buffer, ...), pinned to exact versions with
 * their real npm-published sha512 integrity below, so a run is deterministic in WHAT it installs
 * even though the real npm registry's own latency is (honestly) not. None declares pi.extensions,
 * so HeadlessInstallValidator's own extra per-extension load-check subprocesses never run for
 * them -- this measures the floor every npm: install already pays (npm pack + npm install), not
 * the additional cost a genuine Pi extension's own load validation adds on top.
 *
 * Skipped by default (like service/test/smoke.test.ts's own bwrap gate) -- this makes real,
 * uncached network calls and takes real wall-clock seconds, unlike the rest of this suite. Run it
 * on demand:
 *
 *   PACKED_PERF=1 bun test service/test/perf/multi-install.perf.test.ts
 *   PACKED_PERF=1 PACKED_PERF_N=10 bun test service/test/perf/multi-install.perf.test.ts
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecInstaller } from "../../src/packages/install.ts";
import type { PkgInfo, Registry, SearchPage } from "../../src/packages/package.ts";
import { createLogger } from "../../src/shared/log.ts";
import { SetupManager } from "../../src/setup/setup.ts";

/** Real npm-published sha512 integrity for each pinned version below (`npm view <spec> dist.integrity`) -- SetupManifestSchema's NpmPackageSchema requires one, matching what SetupManager.resolvePackage() would itself fetch from the registry. */
const FIXTURE_PACKAGES: ReadonlyArray<{ name: string; version: string; integrity: string }> = [
	{ name: "is-number", version: "7.0.0", integrity: "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==" },
	{ name: "is-buffer", version: "2.0.5", integrity: "sha512-i2R6zNFDwgEHJyQUtJEk0XFi1i0dPFn/oqjK3/vPCcDeJvW5NQ83V8QbicfF1SupOaB0h8ntgBC2YiE7dfyctQ==" },
	{
		name: "is-plain-object",
		version: "5.0.0",
		integrity: "sha512-VRSzKkbMm5jMDoKLbltAkFQ5Qr7VDiTFGXxYFXXowVj387GeGNOCsOH6Msy00SGZ3Fp84b1Naa1psqgcCIEP5Q==",
	},
	{ name: "is-callable", version: "1.2.7", integrity: "sha512-1BC0BVFhS/p0qtw6enp8e+8OD0UrK0oFLztSjNzhcKA3WDuJxxAPXzPuPtKkjEY9UUoEWlX/8fgKeu2S8i9JTA==" },
	{ name: "is-arrayish", version: "0.3.2", integrity: "sha512-eVRqCvVlZbuw3GrM63ovNSNAeA1K16kaR/LRY/92w0zxQ5/1YzwblUX652i4Xs9RwAGjW9d9y6X88t8OaAJfWQ==" },
	{
		name: "is-typedarray",
		version: "1.0.0",
		integrity: "sha512-cyA56iCMHAh5CdzjJIa4aohJyeO1YbwLi3Jc35MmRU6poroFjIGZzUzupGiRPOjgHg9TLu43xbpwXk523fMxKA==",
	},
	{
		name: "is-fullwidth-code-point",
		version: "4.0.0",
		integrity: "sha512-O4L094N2/dZ7xqVdrXhh9r1KODPJpFms8B5sGdJLPy664AgvXsreZUyCQQNItZRDlYug4xStLjNp/sz3HvBowQ==",
	},
	{ name: "is-extglob", version: "2.1.1", integrity: "sha512-SbKbANkN603Vi4jEZv49LeVJMn4yGwsbzZworEoyEiutsN3nJYdbO36zfhGJ6QEDpOZIFkDtnq5JRxmvl3jsoQ==" },
	{ name: "is-glob", version: "4.0.3", integrity: "sha512-xelSayHH36ZgE7ZWhli7pW34hNbNl8Ojv5KVmkJD4hBdD3th8Tfk9vYasLM+mXWOZhFkgZfxhLSnrwRr4elSSg==" },
	{ name: "is-stream", version: "3.0.0", integrity: "sha512-LnQR4bZ9IADDRSkvpqMGvt/tEJWclzklNgSw48V5EAaAeDd6qGvN8ei6k5p0tvxSR171VmGyHuTiAOfxAbr8kA==" },
];

/** Never exercised: resolvePackage() only needs Registry.info() when a package isn't ALREADY
 * pinned in the manifest with a resolved version+integrity, which every fixture package here
 * already is -- SetupManager.plan()/apply() never re-resolve an already-fully-specified entry. */
class UnusedRegistry implements Registry {
	async search(): Promise<SearchPage> {
		throw new Error("not exercised");
	}
	async searchPage(): Promise<SearchPage> {
		throw new Error("not exercised");
	}
	async searchAll(): Promise<never[]> {
		throw new Error("not exercised");
	}
	async info(): Promise<PkgInfo> {
		throw new Error("not exercised");
	}
}

interface PackageTiming {
	source: string;
	validateMs?: number;
	installMs?: number;
}

function requestedPackageCount(): number {
	const raw = Number(process.env.PACKED_PERF_N);
	return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), FIXTURE_PACKAGES.length) : FIXTURE_PACKAGES.length;
}

function formatReport(timings: PackageTiming[], reresolveMs: number, wallClockMs: number): string {
	const sumValidate = timings.reduce((sum, t) => sum + (t.validateMs ?? 0), 0);
	const sumInstall = timings.reduce((sum, t) => sum + (t.installMs ?? 0), 0);
	const lines = [
		"",
		`packed multi-install perf (N=${timings.length}, BATCH mode: validate() concurrent, installOnly() sequential, one reresolve)`,
		"-".repeat(80),
		...timings.map(
			(t, i) =>
				`  #${i + 1} ${t.source.padEnd(28)} validate=${(t.validateMs ?? 0).toFixed(0).padStart(6)}ms  installOnly=${(t.installMs ?? 0).toFixed(0).padStart(6)}ms`,
		),
		"-".repeat(80),
		`  sum of validateMs (ran CONCURRENTLY -- NOT how long this phase actually took wall-clock) : ${sumValidate.toFixed(0)}ms`,
		`  sum of installOnly Ms (ran sequentially -- this IS roughly how long this phase took)     : ${sumInstall.toFixed(0)}ms`,
		`  single batch reresolveDependencyTree() call                                              : ${reresolveMs.toFixed(0)}ms`,
		`  observed wall clock (apply() total)                                                       : ${wallClockMs.toFixed(0)}ms`,
		"",
	];
	return lines.join("\n");
}

const runPerf = process.env.PACKED_PERF === "1" ? describe : describe.skip;

runPerf("real multi-package install against a clean, isolated Pi + Packed", () => {
	it(
		"installs N real npm packages in ONE batch (validate concurrently, commit sequentially, reresolve once) and reports where the time goes",
		async () => {
			const n = requestedPackageCount();
			const fixtures = FIXTURE_PACKAGES.slice(0, n);

			const root = mkdtempSync(join(tmpdir(), "packed-perf-clean-pi-"));
			const agentDir = join(root, ".pi", "agent");
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir; // the real `pi` binary's own home-dir override
			try {
				const timings = new Map<string, PackageTiming>();
				let reresolveMs = 0;
				let reresolveCalls = 0;
				const logger = createLogger(
					"perf",
					(line) => {
						try {
							const entry = JSON.parse(line) as Record<string, unknown>;
							if (entry.msg === "validate timing" && typeof entry.source === "string") {
								timings.set(entry.source, { ...timings.get(entry.source), source: entry.source, validateMs: Number(entry.validateMs) });
							} else if (entry.msg === "installOnly timing" && typeof entry.source === "string") {
								timings.set(entry.source, { ...timings.get(entry.source), source: entry.source, installMs: Number(entry.installMs) });
							} else if (entry.msg === "reresolve timing") {
								reresolveCalls += 1;
								reresolveMs = Number(entry.reresolveMs);
							}
						} catch {
							// non-JSON log line -- ignore, this sink only cares about structured timing entries
						}
					},
					"debug",
				);

				const installer = new ExecInstaller(undefined, agentDir, undefined, undefined, logger);
				const manager = new SetupManager(new UnusedRegistry(), installer, agentDir);

				const manifestPath = join(root, "pi-setup.json");
				await Bun.write(
					manifestPath,
					JSON.stringify({
						$schema: "./schema/pi-setup-v1.schema.json",
						schemaVersion: 1,
						packages: fixtures.map((pkg) => ({
							kind: "npm",
							scope: "global",
							source: `npm:${pkg.name}@${pkg.version}`,
							resolved: pkg.version,
							integrity: pkg.integrity,
						})),
						profiles: {},
					}),
				);

				const wallClockStart = performance.now();
				const result = await manager.apply(manifestPath);
				const wallClockMs = performance.now() - wallClockStart;

				// Surfaced unconditionally (not just on failure): result.operations[].output carries
				// ExecInstaller's own real stdout/stderr/error text -- result.diagnostics alone only
				// ever says "package operation failed", which sent an earlier real run of this exact
				// harness straight to ad hoc /tmp debugging instead of just reading the test's own
				// output. Never do that again -- if this harness can't explain its own failure, that's
				// a gap in the harness to fix, not a cue to reach for bash/heredocs outside it.
				console.log(
					[
						"",
						"per-operation outcomes:",
						...result.operations.map(
							(op) => `  ${op.status.padEnd(9)} ${op.kind.padEnd(15)} ${op.target}${op.output ? ` -- ${op.output}` : ""}`,
						),
						"",
					].join("\n"),
				);
				if (result.diagnostics.length > 0) console.log("diagnostics:", JSON.stringify(result.diagnostics, null, 2));

				expect(result.diagnostics).toEqual([]);
				expect(result.ok).toBe(true);
				expect(result.operations.filter((op) => op.status === "succeeded")).toHaveLength(n);
				expect(timings.size).toBe(n);
				// The whole point of batch mode: exactly ONE reresolveDependencyTree() call for the
				// entire batch, not one per package.
				expect(reresolveCalls).toBe(1);

				const orderedTimings = fixtures.map((pkg) => timings.get(`npm:${pkg.name}@${pkg.version}`)!);
				console.log(formatReport(orderedTimings, reresolveMs, wallClockMs));
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				rmSync(root, { recursive: true, force: true });
			}
		},
		10 * 60_000,
	);
});
