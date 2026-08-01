import { describe, expect, it } from "bun:test";
import type { InteractiveRunResult } from "../src/publish/publish.ts";
import { detectSelfInstallMethod, PACKED_PACKAGE_NAME, runSelfUpdate, type SelfUpdateDeps } from "../src/self-update/self-update.ts";
import type { PkgInfo, Registry } from "../src/shared/ports.ts";
import { VERSION } from "../src/shared/version.ts";

class FakeRegistry implements Pick<Registry, "info"> {
	constructor(private version: string) {}
	async info(): Promise<PkgInfo> {
		return { name: PACKED_PACKAGE_NAME, version: this.version };
	}
}

const ok = (code = 0): InteractiveRunResult => ({ ok: true, code });
const failed = (code = 1): InteractiveRunResult => ({ ok: false, code });

describe("detectSelfInstallMethod", () => {
	it("recognizes an npm-global install by its node_modules path", () => {
		const method = detectSelfInstallMethod(`file:///usr/local/lib/node_modules/${PACKED_PACKAGE_NAME}/src/cli.ts`);
		expect(method).toEqual({ kind: "npm-global" });
	});

	it("recognizes anything else as a local checkout, carrying the real resolved path", () => {
		const method = detectSelfInstallMethod("file:///home/dev/Projects/packed/packages/packed/src/cli.ts");
		expect(method.kind).toBe("local-checkout");
		expect(method.kind === "local-checkout" && method.path).toBe("/home/dev/Projects/packed/packages/packed/src/cli.ts");
	});
});

describe("runSelfUpdate", () => {
	function deps(overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
		return { registry: new FakeRegistry("9.9.9"), installMethod: { kind: "npm-global" }, ...overrides };
	}

	it("never attempts an npm install for a local checkout -- update it with git, not packed", async () => {
		let called = false;
		const report = await runSelfUpdate(
			deps({
				installMethod: { kind: "local-checkout", path: "/home/dev/packed" },
				runNpmInstall: async () => {
					called = true;
					return ok();
				},
			}),
		);
		expect(called).toBe(false);
		expect(report.updated).toBe(false);
		expect(report.message).toContain("local checkout at /home/dev/packed");
		expect(report.message).toContain("git pull");
	});

	it("still restarts the service for a local checkout -- that's the actual point for a dev loop", async () => {
		let restarted = false;
		const report = await runSelfUpdate(
			deps({
				installMethod: { kind: "local-checkout", path: "/home/dev/packed" },
				isServiceInstalled: () => true,
				restartService: async () => {
					restarted = true;
					return ok();
				},
			}),
		);
		expect(restarted).toBe(true);
		expect(report.ok).toBe(true);
		expect(report.restarted).toBe(true);
		expect(report.updated).toBe(false);
	});

	it("runs npm install --global for an npm-global install and reports the version transition", async () => {
		let args: string[] | undefined;
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async (a) => {
					args = a;
					return ok();
				},
				isServiceInstalled: () => false,
			}),
		);
		expect(args).toEqual(["install", "--global", `${PACKED_PACKAGE_NAME}@latest`]);
		expect(report.updated).toBe(true);
		expect(report.previousVersion).toBe(VERSION);
		expect(report.latestVersion).toBe("9.9.9");
		expect(report.message).toContain("updated via npm");
	});

	it("fails, never restarting, when npm install itself fails", async () => {
		let restartCalled = false;
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async () => failed(1),
				isServiceInstalled: () => true,
				restartService: async () => {
					restartCalled = true;
					return ok();
				},
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.updated).toBe(false);
		expect(report.restarted).toBe(false);
		expect(restartCalled).toBe(false);
		expect(report.message).toContain("npm install --global");
		expect(report.message).toContain("failed (exit 1)");
	});

	it("proceeds even when the registry lookup for the latest version fails -- best-effort only", async () => {
		const report = await runSelfUpdate(
			deps({
				registry: {
					info: async () => {
						throw new Error("registry down");
					},
				},
				runNpmInstall: async () => ok(),
				isServiceInstalled: () => false,
			}),
		);
		expect(report.updated).toBe(true);
		expect(report.latestVersion).toBeUndefined();
	});

	it("reports no supervised service found, never guessing at a restart", async () => {
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async () => ok(),
				isServiceInstalled: () => false,
			}),
		);
		expect(report.ok).toBe(true);
		expect(report.restarted).toBe(false);
		expect(report.message).toContain("no supervised pi-packed service was found");
	});

	it("reports restart-unsupported explicitly when the platform has no restart mechanism wired in", async () => {
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async () => ok(),
				isServiceInstalled: () => true,
				restartService: undefined,
			}),
		);
		expect(report.ok).toBe(true);
		expect(report.updated).toBe(true);
		expect(report.restarted).toBe(false);
		expect(report.message).toContain("isn't supported on this platform yet");
		expect(report.message).toContain("systemctl --user restart pi-packed.service");
	});

	it("reports an updated-but-not-restarted outcome, never a full failure, when the restart command itself fails", async () => {
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async () => ok(),
				isServiceInstalled: () => true,
				restartService: async () => failed(3),
			}),
		);
		expect(report.ok).toBe(true);
		expect(report.updated).toBe(true);
		expect(report.restarted).toBe(false);
		expect(report.message).toContain("restarting pi-packed.service failed (exit 3)");
	});

	it("reports full success when the update and restart both succeed", async () => {
		const report = await runSelfUpdate(
			deps({
				runNpmInstall: async () => ok(),
				isServiceInstalled: () => true,
				restartService: async () => ok(),
			}),
		);
		expect(report).toEqual({
			ok: true,
			previousVersion: VERSION,
			latestVersion: "9.9.9",
			updated: true,
			restarted: true,
			message: "updated via npm; restarted the pi-packed service",
		});
	});
});
