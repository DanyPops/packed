/**
 * install-validation.test.ts — the real dry-run scenario: stage an actual
 * npm tarball (via `npm pack` against a local fixture directory, so it's
 * offline/deterministic -- npm pack works identically for a local path and
 * a registry spec) and headlessly load-check it via pi-extension-harness's
 * real mock-pi-cli subprocess. No mocking of npm, tar, or the harness --
 * a broken fixture must genuinely be refused, a healthy one must genuinely
 * pass.
 */
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallValidationResult, InstallValidator } from "../src/adoption/install-validation.ts";
import { bareNpmSpec, HeadlessInstallValidator, validateExtensionLoadsHeadless } from "../src/adoption/install-validation.ts";
import { ExecInstaller } from "../src/packages/install.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures/install-validation");
const HEALTHY = join(FIXTURES, "healthy-package");
const BROKEN = join(FIXTURES, "broken-package");
const NO_MANIFEST = join(FIXTURES, "no-manifest-package");

describe("bareNpmSpec", () => {
	it("strips the npm: scheme", () => {
		expect(bareNpmSpec("npm:pi-lsp@1.0.0")).toBe("pi-lsp@1.0.0");
	});

	it("returns undefined for git:/https: sources -- out of scope for headless validation", () => {
		expect(bareNpmSpec("git:github.com/u/r@main")).toBeUndefined();
		expect(bareNpmSpec("https://example.com/pkg.tgz")).toBeUndefined();
	});
});

describe("validateExtensionLoadsHeadless (real mock-pi-cli subprocess, no mocking)", () => {
	it("reports ok for an extension that registers cleanly", async () => {
		const result = await validateExtensionLoadsHeadless(join(HEALTHY, "extension/index.ts"));
		expect(result.ok).toBe(true);
	}, 20_000);

	it("reports the real failure message for an extension that throws during registration", async () => {
		const result = await validateExtensionLoadsHeadless(join(BROKEN, "extension/index.ts"));
		expect(result.ok).toBe(false);
		expect(result.message).toContain("deliberately fails during registration");
	}, 20_000);
});

describe("HeadlessInstallValidator (real npm pack + tar extraction, no mocking)", () => {
	it("passes through non-npm sources unchanged -- nothing to stage from an npm tarball", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate("git:github.com/u/r@main");
		expect(result).toEqual({ ok: true, source: "git:github.com/u/r@main", extensions: [] });
	});

	it("passes a package with no pi.extensions -- most npm packages, nothing to validate", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${NO_MANIFEST}`);
		expect(result.ok).toBe(true);
		expect(result.extensions).toEqual([]);
	}, 20_000);

	it("refuses a real broken package, naming which extension failed and why", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${BROKEN}`);
		expect(result.ok).toBe(false);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({ path: "extension/index.ts", ok: false });
		expect(result.extensions[0]?.message).toContain("deliberately fails during registration");
	}, 20_000);

	it("approves a real healthy package -- every declared extension reports ok", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${HEALTHY}`);
		expect(result.ok).toBe(true);
		expect(result.extensions).toEqual([{ path: "extension/index.ts", ok: true }]);
	}, 20_000);
});

describe("ExecInstaller.install() -- refuses before ever spawning the real pi binary", () => {
	function fakeValidator(result: InstallValidationResult): InstallValidator {
		return { validate: async () => result };
	}

	it("never spawns pi when the validator reports a failed extension", async () => {
		const installer = new ExecInstaller(
			"/bin/false",
			"/tmp/unused-pihome",
			fakeValidator({
				ok: false,
				source: "npm:broken-pkg",
				extensions: [{ path: "extension/index.ts", ok: false, message: "boom" }],
			}),
		);

		await expect(installer.install("npm:broken-pkg")).rejects.toThrow(/install refused.*extension\/index\.ts: boom/);
	});

	it("proceeds to the real install when the validator approves", async () => {
		// /bin/true always exits 0 -- proves the real spawn path was reached
		// (a refused install never gets this far to find out).
		const installer = new ExecInstaller(
			"/bin/true",
			"/tmp/unused-pihome",
			fakeValidator({ ok: true, source: "npm:good-pkg", extensions: [] }),
		);

		await expect(installer.install("npm:good-pkg")).resolves.toBeDefined();
	});

	it("uses the real HeadlessInstallValidator by default, refusing a genuinely broken candidate end-to-end", async () => {
		const installer = new ExecInstaller("/bin/true", "/tmp/unused-pihome");

		await expect(installer.install(`npm:${BROKEN}`)).rejects.toThrow(/install refused/);
	}, 20_000);
});
