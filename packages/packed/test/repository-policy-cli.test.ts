import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "../src/cli/repository-policy-cli.ts");

function repository(files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "packed-policy-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		const filePath = join(root, path);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content, { flag: "wx" });
	}
	Bun.spawnSync(["git", "init", "--quiet"], { cwd: root });
	Bun.spawnSync(["git", "add", "."], { cwd: root });
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packed-policy", () => {
	it("prints a stable JSON success result", () => {
		const root = repository({
			"package.json": '{"name":"fixture"}',
			"bun.lock": '[packages]\n"dependency": ["dependency@1.0.0", ""]',
		});
		const result = Bun.spawnSync(["bun", cli, "--root", root, "--json"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({ ok: true, violations: [] });
	});

	it("returns policy violations as JSON and exits one", () => {
		const root = repository({
			"package.json": '{"name":"fixture"}',
			"bun.lock": "[packages]",
			"vendor/library.js": "export {};",
		});
		const result = Bun.spawnSync(["bun", cli, "--root", root, "--json"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.toString()).violations[0]).toMatchObject({
			code: "UNMANAGED_DEPENDENCY_ARTIFACT",
			path: "vendor/library.js",
		});
	});

	it("fails closed with a stable operational error", () => {
		const root = mkdtempSync(join(tmpdir(), "packed-policy-not-git-"));
		roots.push(root);
		const result = Bun.spawnSync(["bun", cli, "--root", root, "--json"]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, error: { code: "TRACKED_FILES_UNAVAILABLE" } });
	});
});
