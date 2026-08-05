import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/daemon/service.ts";
import type { Installer, PkgInfo, Registry, SearchPage } from "../src/packages/package.ts";
import { listPackageResources, toggleResource } from "../src/packages/resources.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function piHome(settingsPackages: unknown[]): string {
	const root = mkdtempSync(join(tmpdir(), "packed-resources-"));
	roots.push(root);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: settingsPackages }, null, 2));
	return root;
}

function installNpmPackage(home: string, name: string, pi: Record<string, unknown>, files: Record<string, string>): void {
	const dir = join(home, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi }, null, 2));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

describe("listPackageResources", () => {
	it("lists an npm package's discovered resources with the default all-enabled state", () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(
			home,
			"pi-demo",
			{ extensions: ["extensions/*.ts"], skills: ["skills/*/SKILL.md"] },
			{
				"extensions/one.ts": "",
				"extensions/two.ts": "",
				"skills/review/SKILL.md": "",
			},
		);

		const { global, project } = listPackageResources(home);

		expect(project).toEqual([]);
		expect(global).toHaveLength(1);
		expect(global[0]?.source).toBe("npm:pi-demo");
		expect(global[0]?.extensions).toEqual([
			{ path: "extensions/one.ts", enabled: true },
			{ path: "extensions/two.ts", enabled: true },
		]);
		expect(global[0]?.skills).toEqual([{ path: "skills/review/SKILL.md", enabled: true }]);
	});

	it("applies a settings-level filter, narrowing what the package already declares", () => {
		const home = piHome([{ source: "npm:pi-demo", extensions: ["!extensions/two.ts"] }]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "", "extensions/two.ts": "" });

		const { global } = listPackageResources(home);

		expect(global[0]?.extensions).toEqual([
			{ path: "extensions/one.ts", enabled: true },
			{ path: "extensions/two.ts", enabled: false },
		]);
	});

	it("treats an empty filter array as loading none of that resource type", () => {
		const home = piHome([{ source: "npm:pi-demo", extensions: [] }]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });

		const { global } = listPackageResources(home);

		expect(global[0]?.extensions).toEqual([{ path: "extensions/one.ts", enabled: false }]);
	});

	it("omits git:, https:, and local sources rather than reporting them inaccurately", () => {
		const home = piHome(["git:github.com/example/repo", "https://example.test/pkg", "/abs/local/pkg", "npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", {}, { "extensions/one.ts": "" });

		const { global } = listPackageResources(home);

		expect(global).toHaveLength(1);
		expect(global[0]?.source).toBe("npm:pi-demo");
	});

	it("reads project settings and resolves project-local npm installs under .pi/, matching setup.ts's own -l convention", () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", {}, { "extensions/one.ts": "" });
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-resources-project-"));
		roots.push(projectRoot);
		const projectHome = join(projectRoot, ".pi");
		mkdirSync(projectHome, { recursive: true });
		writeFileSync(join(projectHome, "settings.json"), JSON.stringify({ packages: ["npm:pi-demo-local"] }));
		installNpmPackage(projectHome, "pi-demo-local", {}, { "extensions/local.ts": "" });

		const { global, project } = listPackageResources(home, projectRoot);

		expect(global).toHaveLength(1);
		expect(project).toHaveLength(1);
		expect(project[0]?.source).toBe("npm:pi-demo-local");
		expect(project[0]?.scope).toBe("project");
	});

	it("is unaffected by a missing project settings file", () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", {}, { "extensions/one.ts": "" });
		const projectRoot = mkdtempSync(join(tmpdir(), "packed-resources-project-"));
		roots.push(projectRoot);

		const { global, project } = listPackageResources(home, projectRoot);

		expect(global).toHaveLength(1);
		expect(project).toEqual([]);
	});
});

class NoopRegistry implements Registry {
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchAll() {
		return [];
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1.0.0" };
	}
}

class NoopInstaller implements Installer {
	async install() {
		return "ok";
	}
	async remove() {
		return "ok";
	}
	async update() {
		return { output: "ok", reloadRequired: false, alreadyUpToDate: true, pinned: false };
	}
}

function rpcClient(piHome: string) {
	const app = createApp({
		reg: new NoopRegistry(),
		inst: new NoopInstaller(),
		token: "test-token",
		stateDir: track(mkdtempSync(join(tmpdir(), "packed-resources-state-"))),
		dataDir: track(mkdtempSync(join(tmpdir(), "packed-resources-data-"))),
		piHome,
	});
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
		label: "Packed",
		transport: (request) => app.fetch(request),
	});
}

describe("resources.list / resources.toggle (daemon RPC wiring)", () => {
	it("lists resources through the authenticated RPC operation, matching the pure domain function", async () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });
		const client = rpcClient(home);

		const result = await client.call("resources.list", {});

		expect(result).toEqual(listPackageResources(home));
	});

	it("requires approval before toggling, matching every other settings-mutating operation", async () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });
		const client = rpcClient(home);

		await expect(
			client.call("resources.toggle", { source: "npm:pi-demo", field: "extensions", path: "extensions/one.ts", enabled: false }),
		).rejects.toThrow();

		const approved = await client.call("resources.toggle", {
			source: "npm:pi-demo",
			field: "extensions",
			path: "extensions/one.ts",
			enabled: false,
			approved: true,
		});
		expect(approved.ok).toBe(true);
		const { global } = await client.call("resources.list", {});
		expect(global[0]?.extensions).toEqual([{ path: "extensions/one.ts", enabled: false }]);
	});

	it("rejects a path-escaping toggle request instead of writing it", async () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });
		const client = rpcClient(home);

		await expect(
			client.call("resources.toggle", {
				source: "npm:pi-demo",
				field: "extensions",
				path: "../../etc/passwd",
				enabled: false,
				approved: true,
			}),
		).rejects.toThrow();
	});
});

describe("toggleResource", () => {
	it("disables a resource with a minimal -path override, leaving the package's own glob defaults untouched", async () => {
		const home = piHome(["npm:pi-demo"]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });
		const settingsPath = join(home, "settings.json");

		const result = await toggleResource({
			settingsPath,
			source: "npm:pi-demo",
			field: "extensions",
			path: "extensions/one.ts",
			enabled: false,
		});

		expect(result.ok).toBe(true);
		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(written.packages).toEqual([{ source: "npm:pi-demo", extensions: ["-extensions/one.ts"] }]);
		const { global } = listPackageResources(home);
		expect(global[0]?.extensions).toEqual([{ path: "extensions/one.ts", enabled: false }]);
	});

	it("is idempotent and replaces a prior override for the same exact path instead of accumulating duplicates", async () => {
		const home = piHome([{ source: "npm:pi-demo", extensions: ["-extensions/one.ts"] }]);
		installNpmPackage(home, "pi-demo", { extensions: ["extensions/*.ts"] }, { "extensions/one.ts": "" });
		const settingsPath = join(home, "settings.json");

		await toggleResource({ settingsPath, source: "npm:pi-demo", field: "extensions", path: "extensions/one.ts", enabled: true });

		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(written.packages).toEqual([{ source: "npm:pi-demo", extensions: ["+extensions/one.ts"] }]);
	});

	it("fails closed with an error, not a throw, when the package is not in settings", async () => {
		const home = piHome(["npm:other"]);
		const result = await toggleResource({
			settingsPath: join(home, "settings.json"),
			source: "npm:pi-demo",
			field: "extensions",
			path: "extensions/one.ts",
			enabled: false,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not found");
	});
});
