import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { checkPackage } from "../src/adoption/check.ts";
import { resolveDependencyModulesDir, runExtensionSmoke } from "../src/adoption/smoke.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Binary presence alone doesn't prove bwrap actually works -- some container
 * runtimes (seen live in GitHub's hosted ubuntu-latest runner) ship the
 * bubblewrap package but block the unprivileged user namespaces it needs,
 * so every real invocation fails at runtime with no way to tell from just
 * `existsSync`. Probing for real is the only way to know, and it mirrors
 * src/adoption/smoke.ts's own fail-closed philosophy: skip the suite rather than
 * assert against a sandbox this host can't actually provide.
 */
function bwrapUsable(): boolean {
	if (!existsSync("/usr/bin/bwrap")) return false;
	const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "/bin/true"], { timeout: 5_000 });
	return probe.status === 0;
}

const describeIfSandboxed = bwrapUsable() ? describe : describe.skip;

function extension(source: string): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "packed-smoke-"));
	roots.push(root);
	mkdirSync(join(root, "extensions"));
	const path = join(root, "extensions/index.ts");
	writeFileSync(path, source);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "pi-smoke",
			version: "1.0.0",
			keywords: ["pi-package"],
			files: ["extensions"],
			pi: { extensions: ["extensions/index.ts"] },
		}),
	);
	return { root, path };
}

/** A minimal fake dependency package.json -- no "exports" map, so a bare
 * `require.resolve("<name>/package.json")` subpath is allowed by Node's
 * default (no-exports-map) resolution rules without needing to replicate
 * the real jiti package's own exports field. */
function writeFakeDependency(nodeModulesDir: string, name: string): void {
	const dir = join(nodeModulesDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-fixture" }));
}

describe("resolveDependencyModulesDir (packed doctor's real-layout dependency resolution)", () => {
	it("resolves a dependency nested directly under the package's own node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "packed-resolve-nested-"));
		roots.push(root);
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
		writeFakeDependency(join(root, "node_modules"), "fake-loader");

		const resolved = resolveDependencyModulesDir(root, "fake-loader");

		expect(resolved).toBe(realpathSync(join(root, "node_modules", "fake-loader")));
	});

	it("resolves a dependency hoisted to a shared ancestor node_modules -- confirmed live bug: packed doctor --json crashed assuming a fixed nested-only path", () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "packed-resolve-hoisted-"));
		roots.push(workspaceRoot);
		const packageDir = join(workspaceRoot, "node_modules", "@danypops", "pi-packed");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@danypops/pi-packed", version: "1.0.0" }));
		// The dependency sits in the WORKSPACE's node_modules, never nested
		// under the package's own -- exactly what npm's hoisting produces
		// when another package in the tree also depends on it.
		writeFakeDependency(join(workspaceRoot, "node_modules"), "fake-loader");

		const resolved = resolveDependencyModulesDir(packageDir, "fake-loader");

		expect(resolved).toBe(realpathSync(join(workspaceRoot, "node_modules", "fake-loader")));
	});

	it("returns undefined (never throws) when the dependency is genuinely unresolvable from here", () => {
		const root = mkdtempSync(join(tmpdir(), "packed-resolve-missing-"));
		roots.push(root);
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));

		expect(resolveDependencyModulesDir(root, "does-not-exist-anywhere")).toBeUndefined();
	});
});

describeIfSandboxed("isolated extension smoke runner", () => {
	it("captures bounded registrations without a model", async () => {
		const fixture = extension(`export default function (pi: any) {
			pi.registerTool({ name: "hello", description: "hello" });
			pi.registerCommand("hello", { handler() {} });
			pi.registerShortcut("ctrl+h", { handler() {} });
			pi.registerFlag("hello", { type: "boolean" });
			pi.registerProvider("local", { models: [] });
			pi.on("session_start", () => {});
		}`);
		const result = await runExtensionSmoke(fixture.root, fixture.path);
		expect(result.status).toBe("ok");
		expect(result.registrations).toEqual({
			tools: ["hello"],
			commands: ["hello"],
			shortcuts: ["ctrl+h"],
			flags: ["hello"],
			sharedTools: [],
			sharedCommands: [],
			sharedShortcuts: [],
			sharedFlags: [],
			providers: ["local"],
			events: ["session_start"],
			renderers: [],
		});
		expect(result.durationMs).toBeLessThan(2_000);
	});

	it("kills a factory that exceeds the time bound", async () => {
		const fixture = extension("export default async function () { await new Promise(() => {}); }");
		const result = await runExtensionSmoke(fixture.root, fixture.path, { timeoutMs: 150 });
		expect(result.status).toBe("timeout");
		expect(result.durationMs).toBeLessThan(2_000);
	});

	it("reports a startup crash without leaking an unbounded stack", async () => {
		const fixture = extension('export default function () { throw new Error("startup failed"); }');
		const result = await runExtensionSmoke(fixture.root, fixture.path);
		expect(result.status).toBe("crash");
		expect(result.message).toContain("startup failed");
		expect(result.message!.length).toBeLessThanOrEqual(1_000);
	});

	it("denies filesystem and network capabilities", async () => {
		const filesystem = extension(
			'import { writeFileSync } from "node:fs"; export default function () { writeFileSync("/forbidden", "x"); }',
		);
		const network = extension('export default async function () { await fetch("https://example.com"); }');
		expect((await runExtensionSmoke(filesystem.root, filesystem.path)).status).toBe("capability-denied");
		expect((await runExtensionSmoke(network.root, network.path)).status).toBe("capability-denied");
	});

	it("bounds subprocess creation and captured output", async () => {
		const processes = extension(
			'export default async function () { const children = []; for (let i = 0; i < 100; i++) children.push(Bun.spawn(["/usr/bin/sleep", "2"])); await Promise.all(children.map((child) => child.exited)); }',
		);
		const output = extension('export default function () { process.stdout.write("x".repeat(200000)); }');
		expect((await runExtensionSmoke(processes.root, processes.path)).status).toBe("capability-denied");
		expect((await runExtensionSmoke(output.root, output.path, { maxOutputBytes: 4_096 })).status).toBe("output-limit");
	});

	it("resolves a dependency hoisted to a shared ancestor node_modules -- confirmed live bug: packed doctor's own widget reported 5/8 real extensions as crashing on a plain 'Cannot find module' for a sibling dependency npm/bun hoisted above the package's own node_modules, though Pi's own real, unsandboxed process resolves the exact same import fine", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "packed-smoke-hoisted-"));
		roots.push(workspaceRoot);
		const sharedNodeModules = join(workspaceRoot, "node_modules");
		writeFakeDependency(sharedNodeModules, "hoisted-sibling");
		const packageDir = join(sharedNodeModules, "@fixture", "pi-smoke-hoisted");
		mkdirSync(join(packageDir, "extension"), { recursive: true });
		const extensionPath = join(packageDir, "extension", "index.ts");
		writeFileSync(
			extensionPath,
			'import pkg from "hoisted-sibling/package.json" with { type: "json" };\nexport default function (pi: any) { pi.registerCommand(pkg.name, { handler() {} }); }\n',
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@fixture/pi-smoke-hoisted",
				version: "1.0.0",
				keywords: ["pi-package"],
				files: ["extension"],
				pi: { extensions: ["extension/index.ts"] },
			}),
		);

		const result = await runExtensionSmoke(packageDir, extensionPath);

		expect(result.status).toBe("ok");
		expect(result.registrations.commands).toEqual(["hoisted-sibling"]);
	});

	it("never routes a plain CJS dependency through jiti's own Babel transform path -- confirmed live: forcing every transitive dependency through Babel (tryNative:false) hit a real, reproducible upstream bug in jiti's own Babel-installed Error.prepareStackTrace hook, triggered by follow-redirects' own module-level Error.captureStackTrace call during its chained error-type prototype setup, surfacing as an opaque 'First argument must be an Error object' crash unrelated to the scanned extension's own code -- reproduces with a cold jiti transform cache regardless of this sandbox specifically, so a real npm package (not a synthetic fixture) is the only faithful way to prove it stays fixed", async () => {
		const require = createRequire(import.meta.url);
		const followRedirectsDir = dirname(require.resolve("follow-redirects/package.json"));

		const workspaceRoot = mkdtempSync(join(tmpdir(), "packed-smoke-follow-redirects-"));
		roots.push(workspaceRoot);
		const sharedNodeModules = join(workspaceRoot, "node_modules");
		cpSync(followRedirectsDir, join(sharedNodeModules, "follow-redirects"), { recursive: true });
		const packageDir = join(sharedNodeModules, "@fixture", "pi-smoke-follow-redirects");
		mkdirSync(join(packageDir, "extension"), { recursive: true });
		const extensionPath = join(packageDir, "extension", "index.ts");
		writeFileSync(
			extensionPath,
			'import { http } from "follow-redirects";\nexport default function (pi: any) { pi.registerCommand(String(typeof http), { handler() {} }); }\n',
		);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@fixture/pi-smoke-follow-redirects",
				version: "1.0.0",
				keywords: ["pi-package"],
				files: ["extension"],
				pi: { extensions: ["extension/index.ts"] },
			}),
		);

		const result = await runExtensionSmoke(packageDir, extensionPath);

		expect(result.status).toBe("ok");
		expect(result.registrations.commands).toEqual(["object"]);
	});

	it("never breaks under a real per-UID process count that already exceeds the sandbox's own maxProcesses budget -- confirmed live: prlimit's --nproc is a per-real-UID, system-wide limit, not scoped to this sandbox's own process tree, so a small absolute cap unconditionally breaks the instant the invoking user's REAL total process count exceeds it (routine on a busy multi-session workstation) -- any further thread Bun's own runtime needs internally (its native TS transpiler spawns one) immediately fails, aborting with SIGABRT and zero output, not a catchable error", async () => {
		const dummyProcessCount = 40;
		const dummies = Array.from({ length: dummyProcessCount }, () => Bun.spawn(["/usr/bin/sleep", "20"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
		try {
			const fixture = extension(`export default function (pi: any) {
				pi.registerCommand("hello", { handler() {} });
			}`);

			const result = await runExtensionSmoke(fixture.root, fixture.path, { maxProcesses: 5 });

			expect(result.status).toBe("ok");
			expect(result.registrations.commands).toEqual(["hello"]);
		} finally {
			for (const dummy of dummies) dummy.kill("SIGKILL");
			await Promise.all(dummies.map((dummy) => dummy.exited));
		}
	});

	it("keeps default package checks static and adds smoke results only when requested", async () => {
		const fixture = extension(
			'import { writeFileSync } from "node:fs"; export default function (pi: any) { writeFileSync("executed", "yes"); pi.registerCommand("x", { handler() {} }); }',
		);
		const staticReport = await checkPackage(fixture.root, { generic: false });
		expect(existsSync(join(fixture.root, "executed"))).toBe(false);
		expect(staticReport.smoke).toBeUndefined();
		const smokeReport = await checkPackage(fixture.root, { generic: false, smoke: true });
		expect(smokeReport.smoke?.extensions[0]?.status).toBe("capability-denied");
		expect(smokeReport.diagnostics.map((diagnostic) => diagnostic.code)).toContain("PI_EXTENSION_SMOKE_CAPABILITY_DENIED");
	});
});
