/**
 * install-validation.test.ts — the real dry-run scenario: stage an actual
 * npm tarball (via `npm pack` against a local fixture directory, so it's
 * offline/deterministic -- npm pack works identically for a local path and
 * a registry spec) and headlessly load-check it via pi-extension-harness's
 * real mock-pi-cli subprocess. No mocking of npm, tar, or the harness --
 * a broken fixture must genuinely be refused, a healthy one must genuinely
 * pass.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const CONVENTION_ONLY = join(FIXTURES, "convention-only-package");
const DEP_PACKAGE = join(FIXTURES, "dep-package");

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

/** Writes a fresh package into `dir` whose extension entry point has a real
 * runtime import (`packed-fixture-dep`, a `file:` dependency resolvable
 * fully offline) -- otherwise healthy, structurally identical to HEALTHY,
 * except its one declared dependency must actually be installed into the
 * staged tarball for its entry point to load at all. The file: target is
 * an absolute path computed at test time (checkout-independent), so this
 * can't be a static checked-in fixture the way HEALTHY/BROKEN are. */
function writePackageWithRealDependency(dir: string): void {
	mkdirSync(join(dir, "extension"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "packed-install-validation-fixture-with-dependency",
			version: "1.0.0",
			private: true,
			pi: { extensions: ["extension/index.ts"] },
			dependencies: { "packed-fixture-dep": `file:${DEP_PACKAGE}` },
		}),
	);
	writeFileSync(
		join(dir, "extension/index.ts"),
		[
			'import { greet } from "packed-fixture-dep";',
			"",
			"export default function withDependencyFixtureExtension(pi: { registerCommand: (name: string, def: unknown) => void }) {",
			'\tpi.registerCommand("with-dependency-fixture", { description: greet(), handler: async () => {} });',
			"}",
			"",
		].join("\n"),
	);
}

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

	it("refuses a package with no pi manifest and no convention resource directory -- not a Pi package (the is-number/is-buffer shape)", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${NO_MANIFEST}`);
		expect(result.ok).toBe(false);
		expect(result.extensions).toEqual([]);
		expect(result.message).toContain("not a Pi package");
	}, 20_000);

	it("passes a package with no pi manifest but a real convention extensions/ directory", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${CONVENTION_ONLY}`);
		expect(result.ok).toBe(true);
		// Convention-discovered extensions (no pi.extensions manifest entry) are
		// not headless load-checked here -- only presence gates admission; the
		// per-extension mock-pi-cli check only ever runs against manifest-
		// declared pi.extensions entries.
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
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({ path: "extension/index.ts", ok: true });
	}, 20_000);
});

describe("HeadlessInstallValidator (vehicle-client-pi pi-load-harness, non-gating diagnostic)", () => {
	it("attaches all-three-path evidence for a real healthy package without changing its ok:true verdict", async () => {
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${HEALTHY}`);
		expect(result.ok).toBe(true);
		expect(result.extensions).toHaveLength(1);
		const paths = result.extensions[0]?.additionalLoadPaths;
		expect(paths).toBeDefined();
		expect(paths?.map((p) => p.path).sort()).toEqual(["jiti-try-native-false", "jiti-try-native-true", "native-esm"]);
		expect(paths?.every((p) => p.ok)).toBe(true);
	}, 20_000);

	it("reports the broken fixture's additional paths as ok:true -- documents a real, deliberate difference in what's checked, not a bug", async () => {
		// verifyLoadableUnderPi only checks that *importing* the module succeeds;
		// it never calls the extension's exported factory the way mock-pi-cli's
		// gating check does. BROKEN's factory only throws once invoked, so
		// merely importing it succeeds on every path -- confirmed directly
		// against the real child process, not assumed. The two checks answer
		// genuinely different questions (import-time vs. factory-execution-time
		// failure) and are complementary for exactly that reason; this test
		// exists so a future change that makes them silently agree (e.g. an
		// accidental factory invocation creeping into the load-path check)
		// gets caught as a real behavior change.
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${BROKEN}`);
		expect(result.ok).toBe(false); // the gating check still refuses it
		const paths = result.extensions[0]?.additionalLoadPaths;
		expect(paths).toBeDefined();
		expect(paths?.every((p) => p.ok === true)).toBe(true);
	}, 20_000);
});

describe("HeadlessInstallValidator (bug repro, packed-headlessinstallvalidator-never-installs-the): staged tarball's own declared dependencies are never installed before the load check", () => {
	it("approves an otherwise-healthy package whose entry point needs its one declared file: dependency", async () => {
		const dir = track(mkdtempSync(join(tmpdir(), "packed-install-validation-dep-fixture-")));
		writePackageWithRealDependency(dir);

		// Ground truth this isn't a broken fixture: a plain `bun install` in an
		// identical staged copy resolves and loads it fine (mirrors the real
		// @danypops/pi-pipes repro: `npm pack` + `tar -xzf` + `bun install`
		// succeeds outside of HeadlessInstallValidator).
		const install = await Bun.spawn(["bun", "install", "--no-save"], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
		expect(install).toBe(0);
		const directLoad = await validateExtensionLoadsHeadless(join(dir, "extension/index.ts"));
		expect(directLoad.ok).toBe(true);

		// The real bug: HeadlessInstallValidator stages its own fresh copy via
		// npm pack + tar (never running bun/npm install in that copy), so the
		// same otherwise-healthy package fails the load check purely because
		// its declared dependency was never installed into *that* copy.
		const validator = new HeadlessInstallValidator();
		const result = await validator.validate(`npm:${dir}`);
		expect(result.ok).toBe(true);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({ path: "extension/index.ts", ok: true });
	}, 30_000);
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

	it("proceeds to the real install when the validator approves, then re-resolves the whole tree", async () => {
		// A real piHome/npm dir must exist for the post-install re-resolution
		// step to cwd into -- /bin/true always exits 0 regardless, proving both
		// the real install spawn *and* the re-resolution spawn were reached (a
		// refused install never gets this far to find out).
		const piHome = track(mkdtempSync(join(tmpdir(), "packed-install-validation-pihome-")));
		mkdirSync(join(piHome, "npm"), { recursive: true });
		const installer = new ExecInstaller(
			"/bin/true",
			piHome,
			fakeValidator({ ok: true, source: "npm:good-pkg", extensions: [] }),
			"/bin/true",
		);

		await expect(installer.install("npm:good-pkg")).resolves.toBeDefined();
	});

	it("uses the real HeadlessInstallValidator by default, refusing a genuinely broken candidate end-to-end", async () => {
		const installer = new ExecInstaller("/bin/true", "/tmp/unused-pihome");

		await expect(installer.install(`npm:${BROKEN}`)).rejects.toThrow(/install refused/);
	}, 20_000);
});
