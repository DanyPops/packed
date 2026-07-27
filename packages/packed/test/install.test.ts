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
import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecInstaller } from "../src/install.ts";

/**
 * A fake `pi` binary: always prints "Updated <source>" and exits 0 (matching
 * real `pi`'s observed behavior for a no-op). When `rewrite` is given, it
 * additionally overwrites that exact package's on-disk version -- letting a
 * test simulate a genuine version change on demand. The rewrite target is
 * baked into the script file itself (not an env var) so it is immune to
 * Bun.spawn's default env snapshot not picking up late process.env writes.
 */
function writeFakePi(dir: string, rewrite?: { piHome: string; name: string; newVersion: string }): string {
	const script = join(dir, "fake-pi");
	const rewriteLine = rewrite
		? `mkdir -p '${join(rewrite.piHome, "npm", "node_modules", rewrite.name)}' && printf '{"version":"%s"}' '${rewrite.newVersion}' > '${join(rewrite.piHome, "npm", "node_modules", rewrite.name, "package.json")}'`
		: "true";
	writeFileSync(
		script,
		["#!/usr/bin/env bash", "set -euo pipefail", 'source="${3:-}"', rewriteLine, 'echo "Updated $source"', "exit 0"].join("\n"),
	);
	chmodSync(script, 0o755);
	return script;
}

function writePiHome(nodeModules: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "packed-exec-pihome-"));
	for (const [name, version] of Object.entries(nodeModules)) {
		const pkgDir = join(dir, "npm", "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
	}
	return dir;
}

describe("ExecInstaller.update() — honest reloadRequired despite pi's ambiguous exit-0 text", () => {
	it("pinned source, version genuinely unchanged: alreadyUpToDate, reloadRequired false", async () => {
		const scriptDir = mkdtempSync(join(tmpdir(), "packed-exec-bin-"));
		const bin = writeFakePi(scriptDir);
		const piHome = writePiHome({ "@scope/pkg": "1.2.3" });
		const installer = new ExecInstaller(bin, piHome);

		const outcome = await installer.update("npm:@scope/pkg@1.2.3");

		expect(outcome.output).toBe("Updated npm:@scope/pkg@1.2.3");
		expect(outcome.pinned).toBe(true);
		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
		expect(outcome.previousVersion).toBe("1.2.3");
		expect(outcome.currentVersion).toBe("1.2.3");
	});

	it('unpinned source, already latest (pi still exits 0 and says "Updated"): alreadyUpToDate', async () => {
		const scriptDir = mkdtempSync(join(tmpdir(), "packed-exec-bin-"));
		const bin = writeFakePi(scriptDir);
		const piHome = writePiHome({ plain: "0.5.0" });
		const installer = new ExecInstaller(bin, piHome);

		const outcome = await installer.update("npm:plain");

		expect(outcome.pinned).toBe(false);
		expect(outcome.alreadyUpToDate).toBe(true);
		expect(outcome.reloadRequired).toBe(false);
		expect(outcome.previousVersion).toBe("0.5.0");
		expect(outcome.currentVersion).toBe("0.5.0");
	});

	it("unpinned source, a real version change happens: reloadRequired true", async () => {
		const scriptDir = mkdtempSync(join(tmpdir(), "packed-exec-bin-"));
		const piHome = writePiHome({ plain: "0.5.0" });
		const bin = writeFakePi(scriptDir, { piHome, name: "plain", newVersion: "0.6.0" });
		const installer = new ExecInstaller(bin, piHome);

		const outcome = await installer.update("npm:plain");

		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.reloadRequired).toBe(true);
		expect(outcome.previousVersion).toBe("0.5.0");
		expect(outcome.currentVersion).toBe("0.6.0");
		expect(readFileSync(join(piHome, "npm", "node_modules", "plain", "package.json"), "utf8")).toContain("0.6.0");
	});

	it("git: source (no npm resolution possible either side): conservatively assumes it may have changed", async () => {
		const scriptDir = mkdtempSync(join(tmpdir(), "packed-exec-bin-"));
		const bin = writeFakePi(scriptDir);
		const piHome = writePiHome();
		const installer = new ExecInstaller(bin, piHome);

		const outcome = await installer.update("git:github.com/u/r@main");

		expect(outcome.pinned).toBe(false);
		expect(outcome.previousVersion).toBeUndefined();
		expect(outcome.currentVersion).toBeUndefined();
		// No ground truth either side -- must not falsely claim nothing changed.
		expect(outcome.alreadyUpToDate).toBe(false);
		expect(outcome.reloadRequired).toBe(true);
	});
});
