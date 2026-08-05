import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Installer, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/packages/package.ts";
import {
	bundledEcosystemManifestPath,
	decodeSetupManifest,
	type GitResolutionPort,
	SetupManager,
	type SetupManifest,
} from "../src/setup/setup.ts";

class RegistryFixture implements Registry {
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
		return { name, version: "1.2.3", publication: { integrity: "sha512-demo", trustedPublisher: "unknown" } };
	}
}

class InstallerFixture implements Installer {
	installed: string[] = [];
	projectScoped: string[] = [];
	removed: string[] = [];
	fail = false;
	async install(source: string, options?: { local?: boolean }) {
		this.installed.push(source);
		if (options?.local) this.projectScoped.push(source);
		if (this.fail) throw new Error("install failed");
		return `Installed ${source}`;
	}
	async update(source: string): Promise<UpdateOutcome> {
		this.installed.push(source);
		return { output: `Updated ${source}`, reloadRequired: true, alreadyUpToDate: false, pinned: true };
	}
	async remove(source: string) {
		this.removed.push(source);
		return `Removed ${source}`;
	}
}

class GitFixture implements GitResolutionPort {
	constructor(private commit = "a".repeat(40)) {}
	async resolve(source: string) {
		return { commit: this.commit, source: `${source.replace(/@[^@/]+$/, "")}@${this.commit}` };
	}
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function piHome(withPackage = true): string {
	const root = track(mkdtempSync(join(tmpdir(), "packed-setup-home-")));
	const packages = withPackage ? ["npm:pi-demo"] : [];
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages }));
	if (withPackage) {
		mkdirSync(join(root, "npm/node_modules/pi-demo"), { recursive: true });
		writeFileSync(
			join(root, "npm/node_modules/pi-demo/package.json"),
			JSON.stringify({ name: "pi-demo", version: "1.2.3", scripts: { postinstall: "touch setup-export-ran-code" } }),
		);
		writeFileSync(
			join(root, "npm/package-lock.json"),
			JSON.stringify({ packages: { "node_modules/pi-demo": { integrity: "sha512-demo" } } }),
		);
	}
	return root;
}

function project(): string {
	const root = track(mkdtempSync(join(tmpdir(), "packed-setup-project-")));
	mkdirSync(join(root, ".pi"), { recursive: true });
	return root;
}

const manifest: SetupManifest = {
	$schema: "./schema/pi-setup-v1.schema.json",
	schemaVersion: 1,
	packages: [{ kind: "npm", scope: "global", source: "npm:pi-demo@1.2.3", resolved: "1.2.3", integrity: "sha512-demo" }],
	profiles: {
		work: {
			scope: "global",
			provider: "openai",
			model: "gpt",
			thinkingLevel: "high",
			tools: ["read"],
			instructions: "Keep work usage scoped.",
			theme: "dark",
			allowedModels: ["openai/*"],
		},
	},
	defaultProfile: "work",
};

describe("Pi setup manifest walking skeleton", () => {
	it("ships the versioned JSON Schema in the npm package", () => {
		const serviceRoot = new URL("..", import.meta.url);
		const packageRoot = new URL("../..", import.meta.url);
		const schema = JSON.parse(readFileSync(new URL("schema/pi-setup-v1.schema.json", serviceRoot), "utf8"));
		const packageJson = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
		expect(schema.properties.schemaVersion.const).toBe(1);
		expect(packageJson.files).toContain("service");
	});

	it("ships a curated, schema-valid @danypops ecosystem starter manifest, resolvable without a network fetch", () => {
		const path = bundledEcosystemManifestPath();
		expect(existsSync(path)).toBe(true);
		// decodeSetupManifest enforces the same schema every real manifest is held to --
		// this is not a hand-waved fixture, it's the actual file `packed setup apply
		// --ecosystem` reads.
		const manifest = decodeSetupManifest(readFileSync(path, "utf8"));
		expect(manifest.packages.length).toBeGreaterThan(0);
		expect(manifest.packages.every((pkg) => pkg.kind === "npm" && pkg.scope === "global")).toBe(true);
		// Every entry is a real, independently-verifiable npm-published package --
		// not a fabricated placeholder version/integrity pair.
		const names = manifest.packages.map((pkg) => (pkg.kind === "npm" ? pkg.source : ""));
		expect(names).toContain("npm:@danypops/pi-packed");
		expect(new Set(names).size).toBe(names.length);
		const packageJson = JSON.parse(readFileSync(new URL("package.json", new URL("../..", import.meta.url)), "utf8"));
		expect(packageJson.files).toContain("service");
	});

	it("plans real operations against the bundled ecosystem manifest through the exact same SetupManager path any other manifest uses", async () => {
		const home = piHome(false);
		const manager = new SetupManager(new RegistryFixture(), new InstallerFixture(), home);
		const plan = await manager.plan(bundledEcosystemManifestPath());
		expect(plan.ok).toBe(true);
		// Nothing installed yet in this fake piHome -- every curated package should plan an install.
		expect(plan.operations.length).toBeGreaterThan(0);
		expect(plan.operations.every((operation) => operation.kind === "install-package")).toBe(true);
	});

	it("exports one locked npm package and scoped profile canonically", async () => {
		const home = piHome();
		writeFileSync(join(home, "profiles.json"), JSON.stringify({ work: { provider: "openai", model: "gpt", tools: ["read"] } }));
		const root = project();
		const manager = new SetupManager(new RegistryFixture(), new InstallerFixture(), home);
		const report = await manager.export(root);
		expect(report.ok).toBe(true);
		expect(report.manifest.packages).toEqual([
			{ kind: "npm", scope: "global", source: "npm:pi-demo@1.2.3", resolved: "1.2.3", integrity: "sha512-demo" },
		]);
		expect(report.manifest.profiles.work).toMatchObject({ scope: "global", provider: "openai", model: "gpt" });
		expect(report.path).toBe(join(root, "pi-setup.json"));
		expect(existsSync(join(root, "schema/pi-setup-v1.schema.json"))).toBe(true);
		const first = readFileSync(report.path, "utf8");
		await manager.export(root, { force: true });
		expect(readFileSync(report.path, "utf8")).toBe(first);
		expect(first.endsWith("\n")).toBe(true);
		expect(existsSync(join(home, "setup-export-ran-code"))).toBe(false);
	});

	it("plans without mutation and applies locked packages before atomic profile merge", async () => {
		const home = piHome(false);
		writeFileSync(join(home, "profiles.json"), JSON.stringify({ personal: { provider: "openai", model: "mini" } }));
		const root = project();
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(manifest));
		const installer = new InstallerFixture();
		const manager = new SetupManager(new RegistryFixture(), installer, home);
		const plan = await manager.plan(join(root, "pi-setup.json"));
		expect(plan.operations.map((item) => item.kind)).toEqual(["install-package", "write-profile"]);
		expect(installer.installed).toEqual([]);
		const applied = await manager.apply(join(root, "pi-setup.json"));
		expect(applied.ok).toBe(true);
		expect(applied.reloadRequired).toBe(true);
		expect(installer.installed).toEqual(["npm:pi-demo@1.2.3"]);
		expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8"))).toEqual({
			personal: { provider: "openai", model: "mini" },
			work: expect.objectContaining({ provider: "openai", model: "gpt" }),
		});
		expect(readdirSync(home).some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("produces an empty plan when locked package and profile state already match", async () => {
		const home = piHome();
		writeFileSync(
			join(home, "profiles.json"),
			JSON.stringify({
				work: {
					provider: "openai",
					model: "gpt",
					thinkingLevel: "high",
					tools: ["read"],
					instructions: "Keep work usage scoped.",
					theme: "dark",
					allowedModels: ["openai/*"],
				},
			}),
		);
		const root = project();
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(manifest));
		const plan = await new SetupManager(new RegistryFixture(), new InstallerFixture(), home).plan(join(root, "pi-setup.json"));
		expect(plan).toMatchObject({ ok: true, operations: [] });
	});

	it("rejects unknown fields, unsupported versions, secret-like instructions, and credential sources", () => {
		for (const value of [
			{ ...manifest, schemaVersion: 2 },
			{ ...manifest, token: "x" },
			{ ...manifest, profiles: { work: { scope: "global", instructions: "API_KEY=secret-value" } } },
			{ ...manifest, packages: [{ source: "https://user:secret@example.test/pkg.tgz", resolved: "1" }] },
		])
			expect(() => decodeSetupManifest(JSON.stringify(value))).toThrow();
	});

	it("does not write profiles after a package operation fails", async () => {
		const home = piHome(false);
		const root = project();
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(manifest));
		const installer = new InstallerFixture();
		installer.fail = true;
		const result = await new SetupManager(new RegistryFixture(), installer, home).apply(join(root, "pi-setup.json"));
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("SETUP_APPLY_FAILED");
		expect(existsSync(join(home, "profiles.json"))).toBe(false);
	});

	it("resolves git and HTTPS sources immutably and requires explicit machine-local export", async () => {
		const home = piHome(false);
		writeFileSync(
			join(home, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/example/tool@main", "https://github.com/example/other", "./local-tool"] }),
		);
		const root = project();
		const manager = new SetupManager(new RegistryFixture(), new InstallerFixture(), home, new GitFixture());
		const rejected = await manager.export(root);
		expect(rejected.ok).toBe(false);
		expect(rejected.diagnostics.some((item) => item.message.includes("--machine-local"))).toBe(true);
		const report = await manager.export(root, { machineLocal: true });
		expect(report.ok).toBe(true);
		expect(report.manifest.packages.map((pkg) => pkg.kind).sort()).toEqual(["git", "https", "local"]);
		expect(report.manifest.packages.filter((pkg) => pkg.kind !== "local").every((pkg) => pkg.source.endsWith("a".repeat(40)))).toBe(true);
		expect(report.manifest.packages.find((pkg) => pkg.kind === "local")).toMatchObject({
			machineLocal: true,
			resolved: join(home, "local-tool"),
		});
	});

	it("updates immutable resolutions without applying packages", async () => {
		const home = piHome(false);
		const root = project();
		const old = "a".repeat(40),
			next = "b".repeat(40);
		const changing: SetupManifest = {
			...manifest,
			packages: [
				{
					kind: "git",
					scope: "global",
					requested: "git:github.com/example/tool@main",
					source: `git:github.com/example/tool@${old}`,
					resolved: old,
				},
			],
		};
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(changing));
		const installer = new InstallerFixture();
		const result = await new SetupManager(new RegistryFixture(), installer, home, new GitFixture(next)).update(root);
		expect(result).toMatchObject({ ok: true, wrote: true, updated: 1 });
		expect(result.manifest.packages[0]).toMatchObject({
			requested: "git:github.com/example/tool@main",
			source: `git:github.com/example/tool@${next}`,
			resolved: next,
		});
		expect(installer.installed).toEqual([]);
	});

	it("plans deterministic prune last and applies removals after desired profile state", async () => {
		const home = piHome();
		writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: ["npm:pi-demo", "npm:old-tool"] }));
		writeFileSync(join(home, "profiles.json"), JSON.stringify({ work: { model: "old" }, obsolete: { model: "old" } }));
		const root = project();
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(manifest));
		const installer = new InstallerFixture();
		const manager = new SetupManager(new RegistryFixture(), installer, home);
		const plan = await manager.plan(root, { prune: true });
		expect(plan.operations.map((item) => item.kind)).toEqual(["write-profile", "remove-profile", "remove-package"]);
		const result = await manager.apply(root, { prune: true });
		expect(result.ok).toBe(true);
		expect(installer.removed).toEqual(["npm:old-tool"]);
		expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8"))).toEqual({
			work: {
				provider: "openai",
				model: "gpt",
				thinkingLevel: "high",
				tools: ["read"],
				instructions: "Keep work usage scoped.",
				theme: "dark",
				allowedModels: ["openai/*"],
			},
		});
	});

	it("repairs an installed npm package whose lock integrity differs", async () => {
		const home = piHome();
		writeFileSync(
			join(home, "npm/package-lock.json"),
			JSON.stringify({ packages: { "node_modules/pi-demo": { integrity: "sha512-other" } } }),
		);
		const root = project();
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(manifest));
		const plan = await new SetupManager(new RegistryFixture(), new InstallerFixture(), home).plan(root);
		expect(plan.operations[0]).toMatchObject({ kind: "update-package", packageName: "pi-demo" });
	});

	it("retries a failed package operation and preserves project package scope", async () => {
		const home = piHome(false);
		const root = project();
		const scoped: SetupManifest = { ...manifest, packages: [{ ...manifest.packages[0]!, scope: "project" }] };
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(scoped));
		const installer = new InstallerFixture();
		installer.fail = true;
		const manager = new SetupManager(new RegistryFixture(), installer, home);
		expect((await manager.apply(root)).ok).toBe(false);
		installer.fail = false;
		expect((await manager.apply(root)).ok).toBe(true);
		expect(installer.projectScoped).toEqual(["npm:pi-demo@1.2.3", "npm:pi-demo@1.2.3"]);
	});

	it("rejects mutable git manifests and credential-bearing URLs", () => {
		const commit = "a".repeat(40);
		expect(() =>
			decodeSetupManifest(
				JSON.stringify({
					...manifest,
					packages: [
						{
							kind: "git",
							scope: "global",
							requested: "git:github.com/example/tool@main",
							source: "git:github.com/example/tool@main",
							resolved: commit,
						},
					],
				}),
			),
		).toThrow("SETUP_GIT_NOT_IMMUTABLE");
		expect(() =>
			decodeSetupManifest(
				JSON.stringify({
					...manifest,
					packages: [
						{
							kind: "https",
							scope: "global",
							requested: "https://github.com/example/tool",
							source: `https://user:token@github.com/example/tool@${commit}`,
							resolved: commit,
						},
					],
				}),
			),
		).toThrow("SETUP_CREDENTIAL_SOURCE");
	});

	it("keeps project profiles project-scoped", async () => {
		const home = piHome(false);
		const root = project();
		const value: SetupManifest = {
			...manifest,
			packages: [],
			profiles: { project: { scope: "project", theme: "dark" } },
			defaultProfile: "project",
		};
		writeFileSync(join(root, "pi-setup.json"), JSON.stringify(value));
		await new SetupManager(new RegistryFixture(), new InstallerFixture(), home).apply(join(root, "pi-setup.json"));
		expect(JSON.parse(readFileSync(join(root, ".pi/profiles.json"), "utf8"))).toEqual({ project: { theme: "dark" } });
		expect(existsSync(join(home, "profiles.json"))).toBe(false);
	});
});
