import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackage } from "../src/adoption/check.ts";
import { runExtensionSmoke } from "../src/adoption/smoke.ts";

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
