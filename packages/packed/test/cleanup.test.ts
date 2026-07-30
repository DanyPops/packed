import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { formatCleanupSummary, readCleanupManifest, runCleanup } from "../src/daemon/cleanup.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/shared/ports.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function pkg(manifest: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "packed-cleanup-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	return root;
}

describe("readCleanupManifest", () => {
	it("returns [] for a package that never declares pi.cleanup -- zero behavior change is the default", () => {
		expect(readCleanupManifest(pkg({ name: "pi-demo" }))).toEqual([]);
	});

	it("returns [] for a malformed pi.cleanup (not an array), never throws", () => {
		expect(readCleanupManifest(pkg({ name: "pi-demo", pi: { cleanup: "not-an-array" } }))).toEqual([]);
	});

	it("returns [] when package.json itself is missing or unparseable", () => {
		const root = mkdtempSync(join(tmpdir(), "packed-cleanup-"));
		roots.push(root);
		expect(readCleanupManifest(root)).toEqual([]);
	});

	it("filters non-string entries and bounds count and per-entry length", () => {
		const declared = [...Array(60).keys()].map((i) => `dir-${i}`);
		const root = pkg({ name: "pi-demo", pi: { cleanup: [...declared, 123, null, "  ", "a".repeat(600)] } });
		const result = readCleanupManifest(root);
		expect(result.length).toBe(50); // MAX_CLEANUP_ENTRIES
		expect(result.every((item) => typeof item === "string" && item.length <= 512)).toBe(true);
	});
});

describe("runCleanup", () => {
	it("is a complete no-op for a package that declares nothing -- readCleanupManifest already returns [] so nothing is even attempted", () => {
		const root = pkg({ name: "pi-demo" });
		expect(runCleanup(root)).toEqual([]);
	});

	it("removes a declared file within the package's own directory and reports it", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["cache.json"] } });
		writeFileSync(join(root, "cache.json"), "{}");
		const result = runCleanup(root);
		expect(result).toEqual([{ declared: "cache.json", status: "removed" }]);
		expect(existsSync(join(root, "cache.json"))).toBe(false);
	});

	it("removes a declared directory recursively", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["state"] } });
		mkdirSync(join(root, "state"));
		writeFileSync(join(root, "state", "data.db"), "x");
		const result = runCleanup(root);
		expect(result).toEqual([{ declared: "state", status: "removed" }]);
		expect(existsSync(join(root, "state"))).toBe(false);
	});

	it("reports missing (not an error) for a declared path that never existed", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["never-created.log"] } });
		expect(runCleanup(root)).toEqual([{ declared: "never-created.log", status: "missing" }]);
	});

	it("fails closed on an absolute path -- never deletes outside the package", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["/etc/passwd"] } });
		const result = runCleanup(root);
		expect(result).toEqual([{ declared: "/etc/passwd", status: "escaped" }]);
		expect(existsSync("/etc/passwd")).toBe(true);
	});

	it("fails closed on a \"..\"-escaping path, never deletes outside the package", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["../../etc/passwd"] } });
		const outside = join(root, "..", "..", "etc-passwd-marker");
		const result = runCleanup(root);
		expect(result).toEqual([{ declared: "../../etc/passwd", status: "escaped" }]);
		expect(existsSync(outside)).toBe(false);
	});

	it("fails closed on a symlink inside the package that points outside it, matching check.ts's own escape discipline", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["escape-link"] } });
		const outsideTarget = mkdtempSync(join(tmpdir(), "packed-cleanup-outside-"));
		roots.push(outsideTarget);
		const canary = join(outsideTarget, "canary.txt");
		writeFileSync(canary, "do not delete");
		symlinkSync(outsideTarget, join(root, "escape-link"));
		const result = runCleanup(root);
		expect(result).toEqual([{ declared: "escape-link", status: "escaped" }]);
		expect(existsSync(canary)).toBe(true);
	});

	it("reports every declared entry independently -- one escape doesn't block a legitimate sibling removal", () => {
		const root = pkg({ name: "pi-demo", pi: { cleanup: ["../escape", "cache.json", "missing.log"] } });
		writeFileSync(join(root, "cache.json"), "{}");
		const result = runCleanup(root);
		expect(result).toEqual([
			{ declared: "../escape", status: "escaped" },
			{ declared: "cache.json", status: "removed" },
			{ declared: "missing.log", status: "missing" },
		]);
	});
});

describe("formatCleanupSummary", () => {
	it("is empty for no declared targets -- a package that never opts in produces zero visible output difference", () => {
		expect(formatCleanupSummary([])).toBe("");
	});

	it("lists every target's outcome", () => {
		const summary = formatCleanupSummary([{ declared: "cache.json", status: "removed" }, { declared: "../x", status: "escaped" }]);
		expect(summary).toContain("removed: cache.json");
		expect(summary).toContain("escaped: ../x");
	});
});

class NoopRegistry implements Registry {
	async search(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchPage(): Promise<SearchPage> { return { results: [], total: 0 }; }
	async searchAll() { return []; }
	async info(name: string): Promise<PkgInfo> { return { name, version: "1.0.0" }; }
}

class RecordingInstaller implements Installer {
	removed?: string;
	async install() { return "ok"; }
	async remove(source: string) { this.removed = source; return `Removed ${source}`; }
	async update(): Promise<UpdateOutcome> { return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false }; }
}

describe("packed remove applies pi.cleanup before delegating to pi remove (real daemon route)", () => {
	function installedNpmPackage(pi: Record<string, unknown>): { piHome: string; dir: string } {
		const piHome = mkdtempSync(join(tmpdir(), "packed-cleanup-daemon-"));
		roots.push(piHome);
		const dir = join(piHome, "npm", "node_modules", "pi-demo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-demo", version: "1.0.0", pi }));
		return { piHome, dir };
	}

	function rpcClient(inst: Installer, piHome: string) {
		const app = createApp({ reg: new NoopRegistry(), inst, token: "test-token", stateDir: mkdtempSync(join(tmpdir(), "packed-cleanup-state-")), dataDir: mkdtempSync(join(tmpdir(), "packed-cleanup-data-")), piHome });
		return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", { label: "Packed", transport: (request) => app.fetch(request) });
	}

	it("removes a declared cleanup path before pi remove runs, and reports it in the same output the CLI already prints", async () => {
		const { piHome, dir } = installedNpmPackage({ cleanup: ["cache.json"] });
		writeFileSync(join(dir, "cache.json"), "{}");
		const inst = new RecordingInstaller();
		const client = rpcClient(inst, piHome);
		const result = await client.call("package.remove", { name: "pi-demo", approved: true });
		expect(result.ok).toBe(true);
		expect(result.output).toContain("Removed npm:pi-demo");
		expect(result.output).toContain("removed: cache.json");
		expect(existsSync(join(dir, "cache.json"))).toBe(false); // deleted before pi remove even ran
		expect(inst.removed).toBe("npm:pi-demo");
	});

	it("produces byte-identical output to plain pi remove for a package that never declares pi.cleanup -- zero behavior change", async () => {
		const { piHome } = installedNpmPackage({});
		const inst = new RecordingInstaller();
		const client = rpcClient(inst, piHome);
		const result = await client.call("package.remove", { name: "pi-demo", approved: true });
		expect(result.output).toBe("Removed npm:pi-demo");
	});

	it("still delegates to pi remove and reports the escape, but never deletes anything outside the package", async () => {
		const { piHome } = installedNpmPackage({ cleanup: ["../../etc/passwd"] });
		const inst = new RecordingInstaller();
		const client = rpcClient(inst, piHome);
		const result = await client.call("package.remove", { name: "pi-demo", approved: true });
		expect(result.output).toContain("escaped: ../../etc/passwd");
		expect(inst.removed).toBe("npm:pi-demo"); // pi remove still ran
		expect(existsSync("/etc/passwd")).toBe(true);
	});

	it("requires the same approval as every other remove -- cleanup never bypasses it", async () => {
		const { piHome } = installedNpmPackage({ cleanup: ["cache.json"] });
		const inst = new RecordingInstaller();
		const client = rpcClient(inst, piHome);
		await expect(client.call("package.remove", { name: "pi-demo" })).rejects.toThrow("approval required");
		expect(inst.removed).toBeUndefined();
	});
});
