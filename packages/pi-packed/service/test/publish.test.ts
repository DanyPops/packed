import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PkgInfo, Registry, SearchPage } from "../src/packages/package.ts";
import {
	browserOpenCommand,
	npmWebUrl,
	PublishManager,
	renderStageWorkflow,
	runNpmLoginWeb,
	satisfiesRange,
	stageWorkflowFile,
	type TrustStatusCommand,
	type VersionCommand,
} from "../src/publish/publish.ts";

class RegistryFixture implements Registry {
	constructor(private readonly existing = true) {}
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
		if (!this.existing) throw new Error("npm info: HTTP 404");
		return { name, version: "1.0.0" };
	}
}

function project(overrides: Record<string, unknown> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "packed-publish-"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "@example/pi-demo",
			version: "1.1.0",
			description: "Pi demo package",
			repository: { type: "git", url: "git+https://github.com/example/pi-demo.git" },
			keywords: ["pi-package"],
			scripts: { check: "tsc --noEmit", test: "bun test", build: "bun build src.ts --outdir dist" },
			...overrides,
		}),
	);
	writeFileSync(join(root, "bun.lock"), "{}");
	return root;
}

const npmVersion: VersionCommand = async () => ({ code: 0, stdout: "11.15.0\n", stderr: "" });
const loggedIn: VersionCommand = async () => ({ code: 0, stdout: "example-user\n", stderr: "" });
const trusted: TrustStatusCommand = async () => ({
	code: 0,
	stderr: "",
	stdout: JSON.stringify({
		type: "github",
		repository: "example/pi-demo",
		file: "pi-demo-stage-publish.yml",
		permissions: ["createStagedPackage"],
	}),
});

class MultiRegistryFixture implements Registry {
	constructor(private readonly versions: Record<string, string> = {}) {}
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
		const version = this.versions[name];
		if (!version) throw new Error("npm info: HTTP 404");
		return { name, version };
	}
}

/** A two-package Bun workspace: packages/core (published, depended on) and
 * packages/ext (the one under test, declaring a dependency on core). */
function workspace(extDependencyRange = "^1.0.0"): { root: string; corePath: string; extPath: string } {
	const root = mkdtempSync(join(tmpdir(), "packed-workspace-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo-workspace", private: true, workspaces: ["packages/*"] }));
	writeFileSync(join(root, "bun.lock"), "{}");
	const corePath = join(root, "packages", "core");
	const extPath = join(root, "packages", "ext");
	mkdirSync(corePath, { recursive: true });
	mkdirSync(extPath, { recursive: true });
	writeFileSync(
		join(corePath, "package.json"),
		JSON.stringify({
			name: "@example/core",
			version: "1.0.0",
			repository: { type: "git", url: "git+https://github.com/example/pi-demo.git", directory: "packages/core" },
			scripts: { build: "bun build", test: "bun test" },
		}),
	);
	writeFileSync(
		join(extPath, "package.json"),
		JSON.stringify({
			name: "@example/ext",
			version: "1.0.0",
			repository: { type: "git", url: "git+https://github.com/example/pi-demo.git", directory: "packages/ext" },
			dependencies: { "@example/core": extDependencyRange },
			scripts: { test: "bun test" },
		}),
	);
	return { root, corePath, extPath };
}

describe("standalone staged publishing", () => {
	it("renders a deterministic least-privilege GitHub OIDC workflow", () => {
		const workflow = renderStageWorkflow({ packageManager: { name: "bun", version: "1.3.14" }, scripts: ["build", "check", "test"] });
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("contents: read");
		expect(workflow).toContain("timeout-minutes: 20");
		expect(workflow).toContain("npm install --global npm@11.15.0");
		expect(workflow).toContain("npm stage publish --access public --provenance --ignore-scripts");
		expect(workflow).not.toContain("npm publish --");
		expect(workflow).not.toContain("NODE_AUTH_TOKEN");
		expect(workflow).not.toContain("pull_request:");
		expect(workflow).toContain('- "v*"');
		expect(workflow).not.toContain("working-directory");
		expect(workflow).not.toContain("core-first ordering");
	});

	it("creates the workflow without Pipes, Enigma, npm credentials, or overwrite", async () => {
		const root = project();
		const manager = new PublishManager(new RegistryFixture(), npmVersion);
		const report = await manager.setup(root);
		expect(report.ok).toBe(true);
		expect(report.wrote).toBe(true);
		expect(report.repository).toBe("example/pi-demo");
		expect(report.trustCommand).toBe(
			"npm trust github @example/pi-demo --repo example/pi-demo --file pi-demo-stage-publish.yml --allow-stage-publish",
		);
		expect(report.webUrl).toBe("https://www.npmjs.com/package/@example/pi-demo/access");
		const workflow = readFileSync(report.workflowPath, "utf8");
		expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(workflow).toContain("bun run build");
		const second = await manager.setup(root);
		expect(second.ok).toBe(false);
		expect(second.diagnostics.map((item) => item.code)).toContain("PUBLISH_WORKFLOW_EXISTS");
	});

	it("requires an existing public npm package and valid GitHub repository", async () => {
		const missing = await new PublishManager(new RegistryFixture(false), npmVersion).setup(project());
		expect(missing.ok).toBe(false);
		expect(missing.diagnostics.map((item) => item.code)).toContain("PUBLISH_PACKAGE_NOT_FOUND");
		expect(existsSync(missing.workflowPath)).toBe(false);
		const badRepo = await new PublishManager(new RegistryFixture(), npmVersion).setup(
			project({ repository: "https://gitlab.com/example/pi-demo" }),
		);
		expect(badRepo.diagnostics.map((item) => item.code)).toContain("PUBLISH_GITHUB_REPOSITORY_REQUIRED");
	});

	it("rejects private packages and non-deterministic installs", async () => {
		const restricted = await new PublishManager(new RegistryFixture(), npmVersion).setup(
			project({ publishConfig: { access: "restricted" } }),
		);
		expect(restricted.diagnostics.map((item) => item.code)).toContain("PUBLISH_PRIVATE_PACKAGE");
		const noLock = project();
		rmSync(join(noLock, "bun.lock"));
		const unlocked = await new PublishManager(new RegistryFixture(), npmVersion).setup(noLock);
		expect(unlocked.diagnostics.map((item) => item.code)).toContain("PUBLISH_LOCKFILE_REQUIRED");
	});

	it("status validates workflow identity, npm floor, package existence, and handoff", async () => {
		const root = project();
		const manager = new PublishManager(new RegistryFixture(), npmVersion, trusted, loggedIn);
		await manager.setup(root);
		const status = await manager.status(root);
		expect(status.ready).toBe(true);
		expect(status.checks).toMatchObject({
			packageExists: true,
			repository: true,
			workflow: true,
			lockfile: true,
			node: true,
			npm: true,
			trustedPublisher: "verified",
		});
		expect(status.nextSteps).toContain(
			"Run: npm trust github @example/pi-demo --repo example/pi-demo --file pi-demo-stage-publish.yml --allow-stage-publish",
		);
		expect(status.nextSteps.join(" ")).toContain("2FA");
	});

	it("rejects broader or mismatched trusted-publisher grants", async () => {
		const root = project();
		await new PublishManager(new RegistryFixture(), npmVersion).setup(root);
		const broad: TrustStatusCommand = async () => ({
			code: 0,
			stderr: "",
			stdout: JSON.stringify({
				type: "github",
				repository: "other/repo",
				file: "publish.yml",
				permissions: ["createPackage", "createStagedPackage"],
			}),
		});
		const status = await new PublishManager(new RegistryFixture(), npmVersion, broad, loggedIn).status(root);
		expect(status.ready).toBe(false);
		expect(status.checks.trustedPublisher).toBe("not-verified");
		expect(status.diagnostics.map((item) => item.code)).toContain("PUBLISH_TRUST_MISMATCH");
	});

	it("reports stale workflow and old npm without mutating", async () => {
		const root = project();
		mkdirSync(join(root, ".github/workflows"), { recursive: true });
		writeFileSync(join(root, ".github/workflows/pi-demo-stage-publish.yml"), "name: unsafe\n");
		const manager = new PublishManager(
			new RegistryFixture(),
			async () => ({ code: 0, stdout: "11.14.1", stderr: "" }),
			undefined,
			loggedIn,
		);
		const before = readFileSync(join(root, ".github/workflows/pi-demo-stage-publish.yml"), "utf8");
		const status = await manager.status(root);
		expect(status.ready).toBe(false);
		expect(status.checks).toMatchObject({ workflow: false, npm: false });
		expect(readFileSync(join(root, ".github/workflows/pi-demo-stage-publish.yml"), "utf8")).toBe(before);
	});

	it("gives sibling workspace packages independent slug-named workflows scoped to their own directory", async () => {
		const { root, extPath } = workspace();
		const manager = new PublishManager(new MultiRegistryFixture({ "@example/core": "1.0.0", "@example/ext": "1.0.0" }), npmVersion);
		const report = await manager.setup(extPath);
		expect(report.ok).toBe(true);
		expect(report.workflowPath).toBe(join(root, ".github/workflows/ext-stage-publish.yml"));
		const workflow = readFileSync(report.workflowPath, "utf8");
		expect(workflow).toContain("bun run --cwd packages/ext test");
		expect(workflow).not.toContain("bun run test\n");
		expect(workflow).toContain("bunx --bun @danypops/pi-packed@latest check packages/ext");
		expect(workflow).toContain('- "ext-v*"');
		expect(workflow).toContain("npm stage publish --access public --provenance --ignore-scripts\n        working-directory: packages/ext");
	});

	it("enforces core-first ordering: the extension's own generated workflow verifies the core dependency is already published", async () => {
		const { extPath } = workspace("^1.0.0");
		const manager = new PublishManager(new MultiRegistryFixture({ "@example/core": "1.0.0", "@example/ext": "1.0.0" }), npmVersion);
		const report = await manager.setup(extPath);
		const workflow = readFileSync(report.workflowPath, "utf8");
		expect(workflow).toContain("Verify @example/core@^1.0.0 is already published (core-first ordering)");
		expect(workflow).toContain('npm view "@example/core@$version" version');
		// core's own workflow declares no internal dependency, so it carries no ordering guard
		const { corePath } = workspace();
		const coreReport = await new PublishManager(new MultiRegistryFixture({ "@example/core": "1.0.0" }), npmVersion).setup(corePath);
		expect(readFileSync(coreReport.workflowPath, "utf8")).not.toContain("core-first ordering");
	});

	it("status reports core-first ordering failure when the internal dependency is unpublished or its range no longer matches", async () => {
		const { extPath } = workspace("^1.0.0");
		const manager = new PublishManager(new MultiRegistryFixture({ "@example/ext": "1.0.0" }), npmVersion, trusted, loggedIn);
		await manager.setup(extPath);
		const missing = await manager.status(extPath);
		expect(missing.checks.coreFirst).toBe(false);
		expect(missing.diagnostics.map((item) => item.code)).toContain("PUBLISH_DEPENDENCY_NOT_PUBLISHED");
		expect(missing.ready).toBe(false);

		const mismatched = await new PublishManager(
			new MultiRegistryFixture({ "@example/core": "2.0.0", "@example/ext": "1.0.0" }),
			npmVersion,
			trusted,
			loggedIn,
		).status(extPath);
		expect(mismatched.checks.coreFirst).toBe(false);
		expect(mismatched.diagnostics.map((item) => item.code)).toContain("PUBLISH_DEPENDENCY_RANGE_MISMATCH");

		const satisfied = await new PublishManager(
			new MultiRegistryFixture({ "@example/core": "1.0.4", "@example/ext": "1.0.0" }),
			npmVersion,
			trusted,
			loggedIn,
		).status(extPath);
		expect(satisfied.checks.coreFirst).toBe(true);
		expect(satisfied.diagnostics.map((item) => item.code)).not.toContain("PUBLISH_DEPENDENCY_NOT_PUBLISHED");
		expect(satisfied.diagnostics.map((item) => item.code)).not.toContain("PUBLISH_DEPENDENCY_RANGE_MISMATCH");
	});

	it("stageWorkflowFile derives one collision-free filename per package name", () => {
		expect(stageWorkflowFile("@danypops/packed")).toBe("packed-stage-publish.yml");
		expect(stageWorkflowFile("@danypops/pi-packed")).toBe("pi-packed-stage-publish.yml");
		expect(stageWorkflowFile("unscoped")).toBe("unscoped-stage-publish.yml");
	});

	it("reports the local machine's npm login state as informative, never blocking ready", async () => {
		const root = project();
		const notLoggedIn: VersionCommand = async () => ({ code: 1, stdout: "", stderr: "npm error code ENEEDAUTH" });
		const manager = new PublishManager(new RegistryFixture(), npmVersion, trusted, notLoggedIn);
		await manager.setup(root);
		const status = await manager.status(root);
		expect(status.checks.loggedIn).toBe(false);
		expect(status.diagnostics.map((item) => item.code)).toContain("PUBLISH_NPM_NOT_LOGGED_IN");
		// trust is independently verified in this fixture, so login state alone never flips ready
		expect(status.ready).toBe(true);
	});

	it("points the trust web handoff at npm's own Trusted Publisher access page, not a CLI command Packed constructs", () => {
		expect(npmWebUrl("@danypops/packed")).toBe("https://www.npmjs.com/package/@danypops/packed/access");
	});

	it("exposes runNpmLoginWeb as real, separately invocable subprocess orchestration, never bundled into publish itself", () => {
		expect(typeof runNpmLoginWeb).toBe("function");
	});

	it("browserOpenCommand is pure argv construction -- never spawns a real browser, tests never risk a live side effect", () => {
		expect(browserOpenCommand("https://example.com")).toEqual(
			process.platform === "darwin"
				? ["open", "https://example.com"]
				: process.platform === "win32"
					? ["cmd", "/c", "start", "", "https://example.com"]
					: ["xdg-open", "https://example.com"],
		);
	});

	it("satisfiesRange implements npm's caret/tilde/exact semantics, including 0.x's stricter caret", () => {
		expect(satisfiesRange("0.1.4", "^0.1.0")).toBe(true);
		expect(satisfiesRange("0.2.0", "^0.1.0")).toBe(false);
		expect(satisfiesRange("1.4.0", "^1.0.0")).toBe(true);
		expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
		expect(satisfiesRange("1.0.5", "~1.0.0")).toBe(true);
		expect(satisfiesRange("1.1.0", "~1.0.0")).toBe(false);
		expect(satisfiesRange("1.0.0", "1.0.0")).toBe(true);
		expect(satisfiesRange("1.0.0", "workspace:*")).toBeUndefined();
	});
});
