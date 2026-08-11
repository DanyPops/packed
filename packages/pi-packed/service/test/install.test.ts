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

/**
 * A real, general-purpose fake `pi` binary for replace() tests -- unlike
 * writeFakePi/writeFakeNpm above (each tailored to one specific pre-baked
 * rewrite), this one genuinely implements `install <source>`/`remove
 * <source>` against a real piHome: writes/removes the real
 * node_modules/<name>/package.json entry AND the real settings.json
 * packages[] entry, exactly like the two-step remove+install sequence
 * replace() actually drives. A plain bun script (not bash) so exact-pin
 * name/version parsing (scoped packages, the LAST "@" only) is real JS,
 * not fragile shell string splitting.
 */
function writeFakeReplacePi(dir: string, piHome: string, options: { failInstallFor?: string } = {}): string {
	const script = join(dir, "fake-replace-pi");
	const body = `
const piHome = ${JSON.stringify(piHome)};
const failInstallFor = ${JSON.stringify(options.failInstallFor ?? null)};
const fs = require("node:fs");
const path = require("node:path");

function bareName(source) {
	const spec = source.startsWith("npm:") ? source.slice(4) : source;
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}
function versionOf(source) {
	const spec = source.startsWith("npm:") ? source.slice(4) : source;
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(at + 1) : undefined;
}
function readSettings() {
	try {
		return JSON.parse(fs.readFileSync(path.join(piHome, "settings.json"), "utf8"));
	} catch {
		return { packages: [] };
	}
}
function writeSettings(settings) {
	fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify(settings, null, 2));
}
function entrySource(entry) {
	return typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.source : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => a !== "-l");
const source = args[args.length - 1];
const name = bareName(source);

if (cmd === "install") {
	if (failInstallFor && source === failInstallFor) {
		process.stderr.write("simulated install failure for " + source + "\\n");
		process.exit(1);
	}
	const version = versionOf(source) ?? "0.0.0";
	const pkgDir = path.join(piHome, "npm", "node_modules", name);
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version }));
	const settings = readSettings();
	const packages = (settings.packages ?? []).filter((e) => bareName(entrySource(e) ?? "") !== name);
	packages.push(source);
	writeSettings({ ...settings, packages });
	process.stdout.write("Installed " + source + "\\n");
	process.exit(0);
}
if (cmd === "remove") {
	const pkgDir = path.join(piHome, "npm", "node_modules", name);
	fs.rmSync(pkgDir, { recursive: true, force: true });
	const settings = readSettings();
	const packages = (settings.packages ?? []).filter((e) => bareName(entrySource(e) ?? "") !== name);
	writeSettings({ ...settings, packages });
	process.stdout.write("Removed " + source + "\\n");
	process.exit(0);
}
process.stderr.write("unsupported command: " + cmd + "\\n");
process.exit(1);
`;
	writeFileSync(script, `#!/usr/bin/env bun\n${body}`);
	chmodSync(script, 0o755);
	return script;
}

/**
 * A fake `pi` binary reproducing real `pi update --extension <source>`'s own
 * "configured packages" check (settings.json's `packages[]` -- the exact
 * same list installed.ts's readPackageDeclarations()/readInstalledPackages()
 * reads) -- distinct from writeFakePi above, which never looks at
 * settings.json at all and so can't reproduce this failure mode. Real `pi`
 * fails this way for ANY source not itself present in `packages[]`,
 * regardless of whether it is genuinely resolvable on disk in node_modules --
 * exactly the shape of a plain library dependency (e.g. @danypops/lector,
 * added directly to piHome/npm/package.json so it can run as its own
 * standalone Armada vehicle) that was never itself `pi install`ed as a Pi
 * extension. See packed-package-update-restart-service-cant-manage.
 */
function writeFakePiConfiguredOnly(dir: string, piHome: string): string {
	const script = join(dir, "fake-pi-configured-only");
	const body = `
const piHome = ${JSON.stringify(piHome)};
const fs = require("node:fs");
const path = require("node:path");

function bareName(source) {
	const spec = source.startsWith("npm:") ? source.slice(4) : source;
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}
function entrySource(entry) {
	return typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.source : undefined;
}
function readSettings() {
	try {
		return JSON.parse(fs.readFileSync(path.join(piHome, "settings.json"), "utf8"));
	} catch {
		return { packages: [] };
	}
}

const [cmd, flag, source] = process.argv.slice(2);
if (cmd === "update" && flag === "--extension") {
	const settings = readSettings();
	const configured = (settings.packages ?? []).some((e) => bareName(entrySource(e) ?? "") === bareName(source));
	if (!configured) {
		process.stderr.write("Error: No matching package found for " + source + "\\n");
		process.exit(1);
	}
	process.stdout.write("Updated " + source + "\\n");
	process.exit(0);
}
process.stderr.write("unsupported invocation: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`;
	writeFileSync(script, `#!/usr/bin/env bun\n${body}`);
	chmodSync(script, 0o755);
	return script;
}

describe("ExecInstaller.update() — a real Vehicle daemon dependency with no pi: extension manifest of its own (packed-package-update-restart-service-cant-manage)", () => {
	it("fails with pi's own 'No matching package found' for a package that is genuinely installed on disk but was never configured as a Pi extension -- e.g. a standalone Armada vehicle dependency like @danypops/lector", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-bin-")));
		const piHome = writePiHome({ "@danypops/lector": "1.0.0", "@danypops/pi-lector": "0.12.7" });
		// Only pi-lector (the real Pi extension, with its own `pi:` manifest) is a
		// configured `packages[]` entry. @danypops/lector is a plain library
		// dependency of piHome/npm/package.json -- installed and resolvable in
		// node_modules, registered as its own independent Armada vehicle, but
		// never itself `pi install`ed.
		writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:@danypops/pi-lector"] }));
		const bin = writeFakePiConfiguredOnly(scriptDir, piHome);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const installer = new ExecInstaller(bin, piHome, undefined, npmBin);

		await expect(installer.update("npm:@danypops/lector")).rejects.toThrow(/No matching package found for npm:@danypops\/lector/);

		// Its sibling, a real configured Pi extension, updates fine through the
		// exact same code path -- matching the live-confirmed asymmetry this task
		// recorded (`packed update npm:@danypops/pi-lector` reports
		// alreadyUpToDate, `packed update npm:@danypops/lector` fails outright).
		const sibling = await installer.update("npm:@danypops/pi-lector");
		expect(sibling.alreadyUpToDate).toBe(true);
	});
});

/**
 * A fake `npm` binary genuinely implementing `install <name>[@version]` against
 * a real piHome -- distinct from writeFakeNpm above (a no-args
 * reresolveDependencyTree() stand-in) and writeFakeReplacePi (implements `pi
 * install`/`pi remove`, not raw npm). No version given simulates "whatever
 * the registry's own latest happens to be right now" via `latestVersion`.
 */
function writeFakeNpmInstall(dir: string, piHome: string, latestVersion = "9.9.9"): string {
	const script = join(dir, "fake-npm-install");
	const body = `
const piHome = ${JSON.stringify(piHome)};
const latestVersion = ${JSON.stringify(latestVersion)};
const fs = require("node:fs");
const path = require("node:path");

const [cmd, spec] = process.argv.slice(2);
if (cmd !== "install" || !spec) {
	process.stderr.write("unsupported invocation: " + process.argv.slice(2).join(" ") + "\\n");
	process.exit(1);
}
const at = spec.lastIndexOf("@");
const name = at > 0 ? spec.slice(0, at) : spec;
const version = at > 0 ? spec.slice(at + 1) : latestVersion;
const resolved = version === "latest" ? latestVersion : version;
const pkgDir = path.join(piHome, "npm", "node_modules", name);
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: resolved }));
process.stdout.write("added 1 package, changed 1 package\\n");
process.exit(0);
`;
	writeFileSync(script, `#!/usr/bin/env bun\n${body}`);
	chmodSync(script, 0o755);
	return script;
}

describe("ExecInstaller.updateDaemonDependency() -- the alternate npm-level mutation path for a package with no pi: manifest of its own (packed-package-update-restart-service-cant-manage)", () => {
	it("bumps to the registry's real latest when no version is given, reporting an honest reloadRequired", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-daemon-dep-")));
		const piHome = writePiHome({ "@danypops/lector": "0.18.9" });
		const npmBin = writeFakeNpmInstall(scriptDir, piHome, "0.19.0");
		const installer = new ExecInstaller("unused-pi-bin", piHome, undefined, npmBin);

		const outcome = await installer.updateDaemonDependency("@danypops/lector");

		expect(outcome.previousVersion).toBe("0.18.9");
		expect(outcome.currentVersion).toBe("0.19.0");
		expect(outcome.reloadRequired).toBe(true);
		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.pinned).toBe(false);
	});

	it("pins to an explicit version when one is given, and reports pinned:true", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-daemon-dep-")));
		const piHome = writePiHome({ "@danypops/lector": "0.18.9" });
		const npmBin = writeFakeNpmInstall(scriptDir, piHome);
		const installer = new ExecInstaller("unused-pi-bin", piHome, undefined, npmBin);

		const outcome = await installer.updateDaemonDependency("@danypops/lector", { version: "0.20.0" });

		expect(outcome.currentVersion).toBe("0.20.0");
		expect(outcome.pinned).toBe(true);
		expect(outcome.reloadRequired).toBe(true);
	});

	it("reports an honest alreadyUpToDate when the version genuinely doesn't change", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-daemon-dep-")));
		const piHome = writePiHome({ "@danypops/lector": "0.18.9" });
		const npmBin = writeFakeNpmInstall(scriptDir, piHome, "0.18.9");
		const installer = new ExecInstaller("unused-pi-bin", piHome, undefined, npmBin);

		const outcome = await installer.updateDaemonDependency("@danypops/lector");

		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
	});

	it("surfaces a real npm failure instead of silently reporting success", async () => {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-exec-daemon-dep-")));
		const piHome = writePiHome({ "@danypops/lector": "0.18.9" });
		const failingNpm = join(scriptDir, "fake-npm-fail");
		writeFileSync(failingNpm, ["#!/usr/bin/env bash", "echo 'ERESOLVE unable to resolve dependency tree' >&2", "exit 1"].join("\n"));
		chmodSync(failingNpm, 0o755);
		const installer = new ExecInstaller("unused-pi-bin", piHome, undefined, failingNpm);

		await expect(installer.updateDaemonDependency("@danypops/lector")).rejects.toThrow(/ERESOLVE/);
	});
});

describe("ExecInstaller.update({ target }) — the supervised replace() workflow for moving an exact pin", () => {
	function setup(options: { failInstallFor?: string } = {}) {
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-replace-bin-")));
		const piHome = writePiHome();
		mkdirSync(piHome, { recursive: true });
		writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: [] }));
		const bin = writeFakeReplacePi(scriptDir, piHome, options);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const validator = { validate: async (source: string) => ({ ok: true as const, source, extensions: [] }) };
		const installer = new ExecInstaller(bin, piHome, validator, npmBin);
		return { piHome, installer };
	}

	function configurePinned(piHome: string, entry: unknown): void {
		writeFileSync(join(piHome, "settings.json"), JSON.stringify({ packages: [entry] }));
	}

	it("replaces an exact pin end to end: removes the old entry, installs the new one, verifies both postconditions", async () => {
		const { piHome, installer } = setup();
		configurePinned(piHome, "npm:@scope/pkg@1.0.0");
		mkdirSync(join(piHome, "npm", "node_modules", "@scope", "pkg"), { recursive: true });
		writeFileSync(join(piHome, "npm", "node_modules", "@scope", "pkg", "package.json"), JSON.stringify({ version: "1.0.0" }));

		const outcome = await installer.update("npm:@scope/pkg@1.0.0", { target: "npm:@scope/pkg@2.0.0" });

		expect(outcome.replaced).toBe(true);
		expect(outcome.before).toEqual({ source: "npm:@scope/pkg@1.0.0", version: "1.0.0" });
		expect(outcome.after).toEqual({ source: "npm:@scope/pkg@2.0.0", version: "2.0.0" });
		expect(outcome.reloadRequired).toBe(true);
		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.currentVersion).toBe("2.0.0");
		const settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
		expect(settings.packages).toEqual(["npm:@scope/pkg@2.0.0"]);
	});

	it("rejects a target that names a different package, before mutating anything", async () => {
		const { piHome, installer } = setup();
		configurePinned(piHome, "npm:@scope/pkg@1.0.0");

		await expect(installer.update("npm:@scope/pkg@1.0.0", { target: "npm:@scope/other@1.0.0" })).rejects.toThrow(
			/same package/,
		);
		const settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
		expect(settings.packages).toEqual(["npm:@scope/pkg@1.0.0"]);
	});

	it("rolls back to the original pin when installing the new target fails", async () => {
		const { piHome, installer } = setup({ failInstallFor: "npm:@scope/pkg@2.0.0" });
		configurePinned(piHome, "npm:@scope/pkg@1.0.0");
		mkdirSync(join(piHome, "npm", "node_modules", "@scope", "pkg"), { recursive: true });
		writeFileSync(join(piHome, "npm", "node_modules", "@scope", "pkg", "package.json"), JSON.stringify({ version: "1.0.0" }));

		await expect(installer.update("npm:@scope/pkg@1.0.0", { target: "npm:@scope/pkg@2.0.0" })).rejects.toThrow(
			/rolled back to npm:@scope\/pkg@1\.0\.0/,
		);
		const settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
		expect(settings.packages).toEqual(["npm:@scope/pkg@1.0.0"]);
		expect(JSON.parse(readFileSync(join(piHome, "npm", "node_modules", "@scope", "pkg", "package.json"), "utf8")).version).toBe("1.0.0");
	});

	it("preserves the old entry's own filter overrides onto the freshly-installed replacement entry", async () => {
		const { piHome, installer } = setup();
		configurePinned(piHome, { source: "npm:@scope/pkg@1.0.0", extensions: ["-extensions/one.ts"] });
		mkdirSync(join(piHome, "npm", "node_modules", "@scope", "pkg"), { recursive: true });
		writeFileSync(join(piHome, "npm", "node_modules", "@scope", "pkg", "package.json"), JSON.stringify({ version: "1.0.0" }));

		await installer.update("npm:@scope/pkg@1.0.0", { target: "npm:@scope/pkg@2.0.0" });

		const settings = JSON.parse(readFileSync(join(piHome, "settings.json"), "utf8"));
		expect(settings.packages).toEqual([{ source: "npm:@scope/pkg@2.0.0", extensions: ["-extensions/one.ts"] }]);
	});

	it("reports pinnedSourceRequiresTarget on a plain update() call against an unchanged exact pin, with no target given", async () => {
		// This scenario needs the ORIGINAL "always prints Updated, changes
		// nothing for a pin" fake pi -- writeFakeReplacePi only implements
		// install/remove, not update --extension.
		const scriptDir = track(mkdtempSync(join(tmpdir(), "packed-replace-bin-")));
		const piHome = writePiHome({ "@scope/pkg": "1.0.0" });
		const bin = writeFakePi(scriptDir);
		const npmBin = writeFakeNpm(scriptDir, join(scriptDir, "npm.log"));
		const plainInstaller = new ExecInstaller(bin, piHome, undefined, npmBin);

		const outcome = await plainInstaller.update("npm:@scope/pkg@1.0.0");

		expect(outcome.pinned).toBe(true);
		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.pinnedSourceRequiresTarget).toBe(true);
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
