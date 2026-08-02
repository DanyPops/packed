import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceUnitPaths, parseExecStartTokens, type ServiceDoctorDeps } from "../src/adoption/service-doctor.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function piHome(settingsPackages: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "packed-service-doctor-"));
	roots.push(root);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: settingsPackages }, null, 2));
	return root;
}

/** A real installed package on disk, shaped so detectVehicleDaemonService recognizes it as a daemon (own bin + a real dependency on @danypops/vehicle-server). */
function installDaemonPackage(home: string, name: string): string {
	const dir = join(home, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", bin: { [name]: "cli.ts" }, dependencies: { "@danypops/vehicle-server": "^0.7.0" } }, null, 2),
	);
	writeFileSync(join(dir, "cli.ts"), "// real entrypoint, present on disk\n");
	return dir;
}

function fakeDeps(unitText: string | null): ServiceDoctorDeps {
	return {
		fileExists: () => unitText !== null,
		readFile: () => unitText,
		platform: "linux",
	};
}

describe("parseExecStartTokens", () => {
	it("parses shell-quoted tokens, unescaping the same characters shellQuote escapes", () => {
		const unit = ['[Service]', 'ExecStart="/home/x/.bun/bin/bun" "/home/x/pkg/cli.ts" "serve"', ''].join("\n");
		expect(parseExecStartTokens(unit)).toEqual(["/home/x/.bun/bin/bun", "/home/x/pkg/cli.ts", "serve"]);
	});

	it("unescapes a backslash-escaped quote/backslash/dollar/backtick inside a token", () => {
		const unit = 'ExecStart="/bin/bun" "/weird \\"path\\" with \\\\ and \\$ and \\`"';
		expect(parseExecStartTokens(unit)).toEqual(["/bin/bun", '/weird "path" with \\ and $ and `']);
	});

	it("returns undefined when there is no ExecStart line at all", () => {
		expect(parseExecStartTokens("[Service]\nType=simple\n")).toBeUndefined();
	});

	it("returns undefined for an ExecStart line with no quoted tokens", () => {
		expect(parseExecStartTokens("ExecStart=\n")).toBeUndefined();
	});
});

describe("checkServiceUnitPaths", () => {
	it("is silent on a non-linux platform without even reading installed packages", () => {
		const home = piHome(["npm:whatever"]);
		const report = checkServiceUnitPaths(home, undefined, { fileExists: () => true, readFile: () => "", platform: "darwin" });
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 0 });
	});

	it("skips a package that never resolves to a Vehicle-shaped daemon", () => {
		const home = piHome(["npm:not-a-daemon"]);
		const dir = join(home, "npm", "node_modules", "not-a-daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "not-a-daemon", version: "1.0.0" }, null, 2));
		const report = checkServiceUnitPaths(home, undefined, fakeDeps("ExecStart=\"/bin/true\"\n"));
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 0 });
	});

	it("skips a daemon-shaped package with no systemd unit currently installed", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, { fileExists: () => false, readFile: () => null, platform: "linux" });
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 0 });
	});

	it("reports clean when the installed unit's ExecStart paths all still exist", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		const unit = `ExecStart="/bin/sh" "${join(dir, "cli.ts")}" "serve"\n`;
		const report = checkServiceUnitPaths(home, undefined, fakeDeps(unit));
		expect(report.checked).toBe(1);
		expect(report.diagnostics).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("flags SERVICE_EXEC_PATH_MISSING with the exact missing path when ExecStart references a deleted file", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const missing = join(tmpdir(), "packed-service-doctor-definitely-missing", "cli.ts");
		const unit = `ExecStart="/bin/sh" "${missing}" "serve"\n`;
		const report = checkServiceUnitPaths(home, undefined, fakeDeps(unit));
		expect(report.ok).toBe(false);
		expect(report.diagnostics).toEqual([
			{
				code: "SERVICE_EXEC_PATH_MISSING",
				severity: "error",
				package: "fakedaemon",
				unitName: "fakedaemon",
				message: expect.stringContaining(missing),
			},
		]);
	});

	it("never flags a bare subcommand argument (no path separator) as a missing path", () => {
		const home = piHome(["npm:fakedaemon"]);
		const dir = installDaemonPackage(home, "fakedaemon");
		// "serve" alone would resolve relative to this process's own cwd and could
		// spuriously not exist there -- must never be treated as a path to check.
		const unit = `ExecStart="/bin/sh" "${join(dir, "cli.ts")}" "serve"\n`;
		const report = checkServiceUnitPaths(home, undefined, fakeDeps(unit));
		expect(report.diagnostics.some((d) => d.message.includes('"serve"'))).toBe(false);
	});

	it("degrades an unparseable ExecStart to a warning, never a false error", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, fakeDeps("[Service]\nType=simple\n"));
		expect(report.ok).toBe(true);
		expect(report.diagnostics).toEqual([
			{
				code: "SERVICE_EXEC_UNPARSEABLE",
				severity: "warning",
				package: "fakedaemon",
				unitName: "fakedaemon",
				message: expect.any(String),
			},
		]);
	});

	it("treats a raced fileExists=true/readFile=null as transient, not a finding", () => {
		const home = piHome(["npm:fakedaemon"]);
		installDaemonPackage(home, "fakedaemon");
		const report = checkServiceUnitPaths(home, undefined, { fileExists: () => true, readFile: () => null, platform: "linux" });
		expect(report).toEqual({ ok: true, diagnostics: [], checked: 1 });
	});
});
