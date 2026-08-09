/**
 * ExecInstaller.update() — a real Bun.spawn subprocess round-trip, not a
 * mocked one, matching the rest of this suite's real-I/O style.
 *
 * `pi update --extension <source>` was verified empirically (against the
 * real `pi` binary) to exit 0 and print "Updated <source>" whether or not
 * anything actually changed: both for a pinned, already-current source and
 * for an unpinned, already-latest one. ExecInstaller must not trust that
 * text; these tests drive a fake `pi` binary that reproduces the same
 * always-"Updated"-regardless-of-outcome text, and assert the real on-disk
 * version diff is what actually drives reloadRequired/alreadyUpToDate.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecInstaller } from "../src/packages/install.ts";
import { createLogger } from "../src/shared/log.ts";

/**
 * A fake `pi` binary: always prints "Updated <source>" and exits 0 (matching
 * real `pi`'s observed behavior for a no-op). When `rewrite` is given, it
 * additionally overwrites that exact package's on-disk version -- letting a
 * test simulate a genuine version change on demand. The rewrite target is
 * baked into the script file itself (not an env var) rather than read from
 * process.env at spawn time, keeping these fixtures independent of whichever
 * way ExecInstaller happens to thread its own env through -- see the
 * `run()`/`reresolveDependencyTree() thread env explicitly` describe block
 * below for a dedicated test of that env-threading behavior itself, added
 * after service/test/perf/multi-install.perf.test.ts caught it live: a
 * runtime process.env mutation (redirecting Pi's home directory) silently
 * never reached the spawned `pi`/`npm` children because Bun.spawn's own
 * default env inheritance doesn't pick up a mutation made after this
 * process's own startup snapshot -- only an explicit `env: process.env`
 * option re-reads the current object.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function writeFakePi(dir: string, rewrite?: { piHome: string; name: string; newVersion: string }): string {
	const script = join(dir, "fake-pi");
	const rewriteLine = rewrite
		? `mkdir -p '${join(rewrite.piHome, "npm", "node_modules", rewrite.name)}' && printf '{"version":"%s"}' '${rewrite.newVersion}' > '${join(rewrite.piHome, "npm", "node_modules", rewrite.name, "package.json")}'`
		: "true";
	writeFileSync(
		script,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash positional-parameter syntax in a generated fixture script, not JS interpolation
		["#!/usr/bin/env bash", "set -euo pipefail", 'source="${3:-}"', rewriteLine, 'echo "Updated $source"', "exit 0"].join("\n"),
	);
	chmodSync(script, 0o755);
	return script;
}

function writePiHome(nodeModules: Record<string, string> = {}): string {
	const dir = track(mkdtempSync(join(tmpdir(), "packed-exec-pihome-")));
	mkdirSync(join(dir, "npm"), { recursive: true });
	for (const [name, version] of Object.entries(nodeModules)) {
		const pkgDir = join(dir, "npm", "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
	}
	return dir;
}

/**
 * A fake `npm` binary standing in for ExecInstaller's post-install/update
 * full-tree re-resolution step. Writes every invocation's cwd to `logFile`
 * (so a test can assert it actually ran against piHome/npm, not some other
 * directory) and, when `rewrite` is given, writes a fresh version for a
 * *different* package than the one the fake `pi` binary touched --
 * reproducing the real defect: only a real `npm install` (no args, whole
 * tree) reaches a stale sibling that a targeted `pi update` never does.
 */
function writeFakeNpm(dir: string, logFile: string, rewrite?: { piHome: string; name: string; newVersion: string }): string {
	const script = join(dir, "fake-npm");
	const rewriteLine = rewrite
		? `mkdir -p '${join(rewrite.piHome, "npm", "node_modules", rewrite.name)}' && printf '{"version":"%s"}' '${rewrite.newVersion}' > '${join(rewrite.piHome, "npm", "node_modules", rewrite.name, "package.json")}'`
		: "true";
	writeFileSync(
		script,
		["#!/usr/bin/env bash", "set -euo pipefail", `pwd >> '${logFile}'`, `echo "$@" >> '${logFile}'`, rewriteLine, "exit 0"].join("\n"),
	);
	chmodSync(script, 0o755);
	return script;
}

describe("ExecInstaller.update() — honest reloadRequired despite pi's ambiguous exit-0 text", () => {
	it("pinned source, version genuinely unchanged: alreadyUpToDate, reloadRequired false", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ "@scope/pkg": "1.2.3" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("npm:@scope/pkg@1.2.3");

		expect(outcome.output).toBe("Updated npm:@scope/pkg@1.2.3");
		expect(outcome.pinned).toBe(true);
		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
		expect(outcome.previousVersion).toBe("1.2.3");
		expect(outcome.currentVersion).toBe("1.2.3");
	});

	it('unpinned source, already latest (pi still exits 0 and says "Updated"): alreadyUpToDate', async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ plain: "0.5.0" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("npm:plain");

		expect(outcome.pinned).toBe(false);
		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
		expect(outcome.previousVersion).toBe("0.5.0");
		expect(outcome.currentVersion).toBe("0.5.0");
	});

	it("unpinned source, a real version change happens: reloadRequired true", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const piHome = writePiHome({ plain: "0.5.0" });
		const bin = writeFakePi(scriptDir, { piHome, name: "plain", newVersion: "0.6.0" });
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("npm:plain");

		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.reloadRequired).toBe(true);
		expect(outcome.previousVersion).toBe("0.5.0");
		expect(outcome.currentVersion).toBe("0.6.0");
		expect(readFileSync(join(piHome, "npm", "node_modules", "plain", "package.json"), "utf8")).toContain("0.6.0");
	});

	it("git: source (no npm resolution possible either side): conservatively assumes it may have changed", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome();
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("git:github.com/u/r@main");

		expect(outcome.pinned).toBe(false);
		expect(outcome.previousVersion).toBeUndefined();
		expect(outcome.currentVersion).toBeUndefined();
		// No ground truth either side -- must not falsely claim nothing changed.
		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.reloadRequired).toBe(true);
	});
});

describe("ExecInstaller.update() — out-of-range update detection (confirmed live: a 0.x package past its own caret boundary reported a bare 'already up to date')", () => {
	it("alreadyUpToDate but a real newer version exists outside the declared range: reports outOfRangeUpdateAvailable", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir); // no rewrite: `pi update` genuinely no-ops, bound by ^0.9.8
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ "@scope/pkg": "0.9.8" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin, undefined, (name) =>
			name === "@scope/pkg" ? "0.10.0" : undefined,
		);

		const outcome = await installer.update("npm:@scope/pkg@0.9.8");

		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
		expect(outcome.outOfRangeUpdateAvailable).toBe("0.10.0");
	});

	it("alreadyUpToDate and genuinely current against the mirror too: no outOfRangeUpdateAvailable", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ plain: "0.5.0" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin, undefined, () => "0.5.0");

		const outcome = await installer.update("npm:plain");

		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.outOfRangeUpdateAvailable).toBeUndefined();
	});

	it("no latestOf wired in at all: behaves exactly as before (no cross-check attempted)", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ "@scope/pkg": "0.9.8" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("npm:@scope/pkg@0.9.8");

		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.outOfRangeUpdateAvailable).toBeUndefined();
	});

	it("a real version change happened: never reports outOfRangeUpdateAvailable even if the mirror knows a still-newer version", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const piHome = writePiHome({ plain: "0.5.0" });
		const bin = writeFakePi(scriptDir, { piHome, name: "plain", newVersion: "0.6.0" });
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin, undefined, () => "0.7.0");

		const outcome = await installer.update("npm:plain");

		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.reloadRequired).toBe(true);
		expect(outcome.outOfRangeUpdateAvailable).toBeUndefined();
	});
});

describe("ExecInstaller — forces full dependency re-resolution, not just the target's own subtree", () => {
	it("update() fixes a stale root-level sibling that the targeted pi update never touched", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		// Simulates the confirmed live defect: after `pi update npm:@scope/leaf`,
		// the leaf's own version bumps, but a root-level sibling
		// (@scope/shared) that the freshly-updated leaf now needs a newer
		// range of stays pinned at its old, now-unsatisfied version --
		// `pi update --extension` only ever resolved the leaf's own subtree.
		const piHome = writePiHome({ "@scope/leaf": "1.0.0", "@scope/shared": "1.0.0" });
		const bin = writeFakePi(scriptDir, { piHome, name: "@scope/leaf", newVersion: "2.0.0" });
		// A real `npm install` (no args, whole-tree) is the only thing that
		// actually reaches @scope/shared -- reproduced here as the fake npm
		// binary rewriting it to the version the leaf's new range needs.
		const npmLog = join(scriptDir, "npm.log");
		const npmBin = writeFakeNpm(scriptDir, npmLog, { piHome, name: "@scope/shared", newVersion: "2.0.0" });
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await installer.update("npm:@scope/leaf");

		expect(outcome.currentVersion).toBe("2.0.0");
		// The real assertion: a package `pi update` never named is resolved
		// too, everywhere in the tree -- not just the target's own package.json.
		expect(readFileSync(join(piHome, "npm", "node_modules", "@scope/shared", "package.json"), "utf8")).toContain("2.0.0");
		// And it ran the re-resolution against piHome/npm specifically, with
		// no target argument -- a full-tree resolve, not another targeted op.
		const log = readFileSync(npmLog, "utf8").trim().split("\n");
		expect(log[0]).toBe(join(piHome, "npm"));
		expect(log[1]).toBe("install");
	});

	it("install() also forces a full re-resolution after a successful pi install", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const piHome = writePiHome({ "@scope/shared": "1.0.0" });
		const bin = writeFakePi(scriptDir);
		const npmLog = join(scriptDir, "npm.log");
		const npmBin = writeFakeNpm(scriptDir, npmLog, { piHome, name: "@scope/shared", newVersion: "2.0.0" });
		const installer = new ExecInstaller(bin, piHome, { validate: async (source) => ({ ok: true, source, extensions: [] }) }, npmBin);

		await installer.install("npm:@scope/new-pkg");

		expect(readFileSync(join(piHome, "npm", "node_modules", "@scope/shared", "package.json"), "utf8")).toContain("2.0.0");
		const log = readFileSync(npmLog, "utf8").trim().split("\n");
		expect(log[0]).toBe(join(piHome, "npm"));
	});

	it("surfaces a failed re-resolution instead of silently reporting success", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const piHome = writePiHome({ plain: "0.5.0" });
		const bin = writeFakePi(scriptDir, { piHome, name: "plain", newVersion: "0.6.0" });
		const failingNpm = join(scriptDir, "fake-npm-fail");
		writeFileSync(failingNpm, ["#!/usr/bin/env bash", "echo 'ERESOLVE unable to resolve dependency tree' >&2", "exit 1"].join("\n"));
		chmodSync(failingNpm, 0o755);
		const installer = new ExecInstaller(bin, piHome, undefined, failingNpm);

		await expect(installer.update("npm:plain")).rejects.toThrow(/npm install failed to re-resolve/);
	});
});

describe("ExecInstaller — timing instrumentation (see service/test/perf/multi-install.perf.test.ts for a real multi-package measurement)", () => {
	it("install() logs a validateMs/installMs/reresolveMs/totalMs breakdown, not just a pass/fail result", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome();
		const lines: string[] = [];
		const logger = createLogger("test", (line) => lines.push(line), "debug");
		const installer = new ExecInstaller(bin, piHome, { validate: async (source) => ({ ok: true, source, extensions: [] }) }, npmBin, logger);

		await installer.install("npm:plain");

		const timing = lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === "install timing");
		expect(timing).toBeDefined();
		expect(timing.source).toBe("npm:plain");
		for (const field of ["validateMs", "installMs", "reresolveMs", "totalMs"]) {
			expect(typeof timing[field]).toBe("number");
			expect(timing[field]).toBeGreaterThanOrEqual(0);
		}
		// totalMs is the whole call's own wall clock, not just one phase re-labeled --
		// bounded above by itself plus a small scheduling-noise allowance, never equal to
		// a single phase alone once every phase is genuinely counted once.
		expect(timing.totalMs).toBeGreaterThanOrEqual(timing.validateMs + timing.installMs + timing.reresolveMs - 1);
	});

	it("update() logs an updateMs/reresolveMs/totalMs breakdown", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome({ plain: "0.5.0" });
		const lines: string[] = [];
		const logger = createLogger("test", (line) => lines.push(line), "debug");
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin, logger);

		await installer.update("npm:plain");

		const timing = lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === "update timing");
		expect(timing).toBeDefined();
		expect(timing.source).toBe("npm:plain");
		for (const field of ["updateMs", "reresolveMs", "totalMs"]) {
			expect(typeof timing[field]).toBe("number");
			expect(timing[field]).toBeGreaterThanOrEqual(0);
		}
	});
});

/**
 * A fake binary that dumps one specific env var's CURRENT value to `logFile` -- proves a
 * process.env mutation made at runtime (after this test process's own startup, the exact shape
 * of a caller redirecting Pi's home directory) actually reaches the spawned child, rather than
 * whatever snapshot Bun.spawn's own default env inheritance captured earlier.
 */
function writeEnvDumpBinary(dir: string, name: string, varName: string, logFile: string): string {
	const script = join(dir, name);
	writeFileSync(script, ["#!/usr/bin/env bash", `printf '%s' "\$${varName}" > '${logFile}'`, "exit 0"].join("\n"));
	chmodSync(script, 0o755);
	return script;
}

describe("ExecInstaller — run()/reresolveDependencyTree() thread the CURRENT process.env through explicitly", () => {
	const MARKER = "PACKED_TEST_ENV_MARKER";

	afterEach(() => {
		delete process.env[MARKER];
	});

	it("install()'s pi spawn sees an env var set on process.env after this process already started", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-env-")));
		const piLog = join(scriptDir, "pi-env.log");
		const bin = writeEnvDumpBinary(scriptDir, "fake-pi-env", MARKER, piLog);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const piHome = writePiHome();
		const installer = new ExecInstaller(bin, piHome, { validate: async (source) => ({ ok: true, source, extensions: [] }) }, npmBin);

		// Mutated well after this test process's own startup -- exactly what redirecting Pi's home
		// via PI_CODING_AGENT_DIR at runtime looks like from ExecInstaller's own point of view.
		process.env[MARKER] = "set-after-startup";
		await installer.install("npm:plain");

		expect(readFileSync(piLog, "utf8")).toBe("set-after-startup");
	});

	it("reresolveDependencyTree()'s npm spawn sees the same runtime env mutation", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-env-")));
		const bin = writeFakePi(scriptDir);
		const npmLog = join(scriptDir, "npm-env.log");
		const npmBin = writeEnvDumpBinary(scriptDir, "fake-npm-env", MARKER, npmLog);
		const piHome = writePiHome();
		const installer = new ExecInstaller(bin, piHome, { validate: async (source) => ({ ok: true, source, extensions: [] }) }, npmBin);

		process.env[MARKER] = "reresolve-sees-this-too";
		await installer.install("npm:plain");

		expect(readFileSync(npmLog, "utf8")).toBe("reresolve-sees-this-too");
	});
});
