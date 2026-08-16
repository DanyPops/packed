import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackage, type Diagnostic, discoverPackageResources, formatCheckReport } from "../src/adoption/check.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "packed-check-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

const base = {
	name: "pi-example",
	version: "1.0.0",
	description: "Example Pi extension",
	license: "MIT",
	repository: "github:owner/pi-example",
	homepage: "https://example.test/pi-example",
	bugs: "https://example.test/pi-example/issues",
	keywords: ["pi-package"],
	files: ["extensions", "skills", "README.md", "LICENSE"],
	pi: { extensions: ["extensions/*.ts"], skills: ["skills/*/SKILL.md"] },
	peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
};

function codes(diagnostics: Diagnostic[]): string[] {
	return diagnostics.map((diagnostic) => diagnostic.code);
}

describe("discoverPackageResources (pure resource discovery for the config overlay)", () => {
	it("matches declared manifest patterns per field, filtered by extension and containment", () => {
		const pkg = { pi: { extensions: ["extensions/*.ts"], skills: ["skills/*/SKILL.md"], themes: [] } };
		const root = fixture(pkg, { "extensions/index.ts": "", "extensions/README.md": "", "skills/review/SKILL.md": "", "prompts/x.md": "" });
		const files = ["extensions/index.ts", "extensions/README.md", "skills/review/SKILL.md", "prompts/x.md"];
		const resources = discoverPackageResources(root, pkg, files);
		expect(resources.extensions).toEqual(["extensions/index.ts"]);
		expect(resources.skills).toEqual(["skills/review/SKILL.md"]);
		expect(resources.themes).toEqual([]);
		expect(resources.prompts).toEqual([]); // omitted from a present pi manifest -> not discovered
	});

	it("falls back to conventional directories when no pi manifest is present", () => {
		const root = fixture({}, { "extensions/foo.ts": "", "skills/bar/SKILL.md": "", "prompts/baz.md": "", "themes/dark.json": "{}" });
		const files = ["extensions/foo.ts", "skills/bar/SKILL.md", "prompts/baz.md", "themes/dark.json"];
		const resources = discoverPackageResources(root, {}, files);
		expect(resources.extensions).toEqual(["extensions/foo.ts"]);
		expect(resources.skills).toEqual(["skills/bar/SKILL.md"]);
		expect(resources.prompts).toEqual(["prompts/baz.md"]);
		expect(resources.themes).toEqual(["themes/dark.json"]);
	});

	it("never throws on an invalid pi manifest shape and reports zero resources instead", () => {
		const root = fixture({ pi: "not-an-object" }, { "extensions/foo.ts": "" });
		const resources = discoverPackageResources(root, { pi: "not-an-object" }, ["extensions/foo.ts"]);
		expect(resources).toEqual({ extensions: [], skills: [], prompts: [], themes: [] });
	});
});

describe("static capability and lifecycle-script signals (packed check)", () => {
	function capabilityFixture(scripts: Record<string, string> | undefined, sourceFiles: Record<string, string>) {
		return fixture(
			{ ...base, ...(scripts ? { scripts } : {}) },
			{
				"skills/example/SKILL.md": "---\nname: example\ndescription: Example. Use for examples.\n---\n",
				"README.md": "# Example\n",
				LICENSE: "MIT\n",
				...sourceFiles,
			},
		);
	}

	it("is silent for a package with no lifecycle scripts and no capability-suggestive imports", async () => {
		const root = capabilityFixture(undefined, { "extensions/index.ts": "export default function () {}" });
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("PI_LIFECYCLE_SCRIPT_DECLARED");
		expect(codes(report.diagnostics)).not.toContain("PI_CAPABILITY_IMPORT");
	});

	it("flags each declared lifecycle script with its exact command as evidence, at warning tier", async () => {
		const root = capabilityFixture(
			{ postinstall: "node ./setup.js", prepare: "tsc -p ." },
			{ "extensions/index.ts": "export default function () {}" },
		);
		const report = await checkPackage(root, { generic: false });
		const declared = report.diagnostics.filter((d) => d.code === "PI_LIFECYCLE_SCRIPT_DECLARED");
		expect(declared).toHaveLength(2);
		expect(declared.every((d) => d.severity === "warning")).toBe(true);
		expect(declared.find((d) => d.path === "package.json#scripts.postinstall")?.message).toContain("node ./setup.js");
		expect(declared.find((d) => d.path === "package.json#scripts.prepare")?.message).toContain("tsc -p .");
	});

	it("ignores non-lifecycle scripts (e.g. test, build) -- only preinstall/install/postinstall/prepare count", async () => {
		const root = capabilityFixture({ test: "bun test", build: "tsc" }, { "extensions/index.ts": "export default function () {}" });
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("PI_LIFECYCLE_SCRIPT_DECLARED");
	});

	it("flags a capability-suggestive import with the exact file and module as evidence, at info tier", async () => {
		const root = capabilityFixture(undefined, {
			"extensions/index.ts": 'import { spawn } from "child_process";\nexport default function () {}',
		});
		const report = await checkPackage(root, { generic: false });
		const found = report.diagnostics.filter((d) => d.code === "PI_CAPABILITY_IMPORT");
		expect(found).toHaveLength(1);
		expect(found[0]!.severity).toBe("info");
		expect(found[0]!.path).toBe("extensions/index.ts");
		expect(found[0]!.message).toContain("child_process");
	});

	it("normalizes a node:-prefixed specifier and a subpath to the same bare capability module", async () => {
		const root = capabilityFixture(undefined, {
			"extensions/index.ts": 'import fs from "node:fs/promises";\nexport default function () {}',
		});
		const report = await checkPackage(root, { generic: false });
		const found = report.diagnostics.filter((d) => d.code === "PI_CAPABILITY_IMPORT");
		expect(found).toHaveLength(1);
		expect(found[0]!.message).toContain("fs");
	});

	it("flags bun:sqlite as a capability-suggestive import", async () => {
		const root = capabilityFixture(undefined, {
			"extensions/index.ts": 'import { Database } from "bun:sqlite";\nexport default function () {}',
		});
		const report = await checkPackage(root, { generic: false });
		expect(report.diagnostics.some((d) => d.code === "PI_CAPABILITY_IMPORT" && d.message.includes("bun:sqlite"))).toBe(true);
	});

	it("reports each capability once per file, not once per occurrence", async () => {
		const root = capabilityFixture(undefined, {
			"extensions/index.ts": 'import { spawn } from "child_process";\nimport { exec } from "child_process";\nexport default function () {}',
		});
		const report = await checkPackage(root, { generic: false });
		expect(report.diagnostics.filter((d) => d.code === "PI_CAPABILITY_IMPORT")).toHaveLength(1);
	});

	it("never flags an ordinary third-party or relative import as a capability signal", async () => {
		const root = capabilityFixture(undefined, {
			"extensions/index.ts": 'import lodash from "lodash";\nimport { helper } from "./helper.ts";\nexport default function () {}',
		});
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("PI_CAPABILITY_IMPORT");
	});

	it("never executes the scanned source -- purely a text scan (structural guarantee on the check function itself)", async () => {
		const source = await Bun.file(new URL("../src/adoption/check.ts", import.meta.url)).text();
		const capabilityCheckBody = source.slice(source.indexOf("function capabilityCheck"), source.indexOf("function capabilityCheck") + 1200);
		expect(capabilityCheckBody).not.toMatch(/\brequire\(|import\s*\(|eval\(|Bun\.spawn|child_process/);
	});
});

describe("pi.cleanup static validation (packed check)", () => {
	function cleanupFixture(cleanup: unknown) {
		return fixture(
			{ ...base, pi: { ...base.pi, cleanup } },
			{
				"extensions/index.ts": "export default function () {}",
				"skills/example/SKILL.md": "---\nname: example\ndescription: Example. Use for examples.\n---\n",
				"README.md": "# Example\n",
				LICENSE: "MIT\n",
			},
		);
	}

	it("is silent for a package that never declares pi.cleanup -- zero behavior change", async () => {
		const root = fixture(base, {
			"extensions/index.ts": "export default function () {}",
			"skills/example/SKILL.md": "---\nname: example\ndescription: Example. Use for examples.\n---\n",
			"README.md": "# Example\n",
			LICENSE: "MIT\n",
		});
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("PI_CLEANUP_INVALID");
		expect(codes(report.diagnostics)).not.toContain("PI_CLEANUP_ESCAPES_PACKAGE");
	});

	it("accepts a well-formed pi.cleanup declaration", async () => {
		const report = await checkPackage(cleanupFixture(["cache.json", "state/"]), { generic: false });
		expect(codes(report.diagnostics)).not.toContain("PI_CLEANUP_INVALID");
		expect(codes(report.diagnostics)).not.toContain("PI_CLEANUP_ESCAPES_PACKAGE");
	});

	it("flags a non-array pi.cleanup as invalid", async () => {
		const report = await checkPackage(cleanupFixture("cache.json"), { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_CLEANUP_INVALID");
	});

	it("flags an absolute path as escaping the package", async () => {
		const report = await checkPackage(cleanupFixture(["/etc/passwd"]), { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_CLEANUP_ESCAPES_PACKAGE");
		expect(report.ok).toBe(false);
	});

	it('flags a ".."-escaping path', async () => {
		const report = await checkPackage(cleanupFixture(["../../etc/passwd"]), { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_CLEANUP_ESCAPES_PACKAGE");
	});

	it("warns (not an error) when pi.cleanup exceeds the bounded entry count or per-entry length", async () => {
		const report = await checkPackage(cleanupFixture([...Array(60).keys()].map((i) => `f${i}`)), { generic: false });
		const tooLarge = report.diagnostics.find((d) => d.code === "PI_CLEANUP_TOO_LARGE");
		expect(tooLarge?.severity).toBe("warning");
	});
});

describe("packed check", () => {
	it("accepts a complete static Pi package without executing it", async () => {
		const root = fixture(base, {
			"extensions/index.ts":
				'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; export default function (pi: ExtensionAPI) { pi.registerCommand("example", { handler() {} }); }',
			"skills/example/SKILL.md":
				"---\nname: example\ndescription: Runs the example workflow. Use for examples.\n---\n\nSee [reference](reference/guide.md).\n",
			"skills/example/reference/guide.md": "# Guide\n",
			"README.md": "# Example\n",
			LICENSE: "MIT\n",
		});
		const report = await checkPackage(root, { generic: false });
		expect(report.ok).toBe(true);
		expect(report.root).toBe(root);
		expect(report.summary.errors).toBe(0);
		expect(report.checkedFiles).toBeGreaterThan(0);
	});

	it("returns stable manifest, resource, containment, dependency, metadata, and skill codes", async () => {
		const root = fixture(
			{
				name: "Bad Package",
				version: "wat",
				keywords: [],
				pi: {
					extensions: ["../escape.ts", "extensions/[", "node_modules/pi-child/extensions"],
					skills: ["skills/*/SKILL.md"],
					prompts: "prompts/*.md",
					image: "https://example.test/image.svg",
					video: "https://example.test/video.webm",
				},
				dependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" },
				devDependencies: { leftpad: "1.0.0" },
			},
			{
				"skills/bad/SKILL.md": "---\nname: Bad_Name\n---\n\nSee [missing](reference/missing.md).\n",
				"extensions/index.ts": 'import leftpad from "leftpad"; export default () => leftpad;',
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toEqual(
			expect.arrayContaining([
				"PKG_NAME_INVALID",
				"PKG_VERSION_INVALID",
				"PKG_LICENSE_MISSING",
				"PKG_REPOSITORY_MISSING",
				"PKG_HOMEPAGE_MISSING",
				"PKG_BUGS_MISSING",
				"PI_KEYWORD_MISSING",
				"PI_MANIFEST_FIELD_INVALID",
				"PI_RESOURCE_OUTSIDE_PACKAGE",
				"PI_RESOURCE_GLOB_INVALID",
				"PI_RESOURCE_NO_MATCH",
				"PI_IMAGE_FORMAT_INVALID",
				"PI_VIDEO_FORMAT_INVALID",
				"PI_CORE_DEPENDENCY_PLACEMENT",
				"PI_PACKAGE_NOT_BUNDLED",
				"RUNTIME_DEPENDENCY_MISSING",
				"SKILL_NAME_INVALID",
				"SKILL_DESCRIPTION_MISSING",
				"SKILL_REFERENCE_MISSING",
				"PACKAGE_README_MISSING",
				"PACKAGE_LICENSE_FILE_MISSING",
			]),
		);
		expect(report.ok).toBe(false);
	});

	it("rejects declared resources excluded from the npm package", async () => {
		const root = fixture(
			{ ...base, files: ["README.md"], pi: { extensions: ["extensions/index.ts"] } },
			{
				"extensions/index.ts": "export default function () {}",
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_RESOURCE_NOT_PUBLISHED");
	});

	it("rejects declared resources that escape through a symlink", async () => {
		const outside = mkdtempSync(join(tmpdir(), "packed-check-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "extension.ts"), "export default function () {}");
		const root = fixture({ ...base, pi: { extensions: ["extensions/outside.ts"] } }, { "README.md": "# Example", LICENSE: "MIT" });
		mkdirSync(join(root, "extensions"), { recursive: true });
		symlinkSync(join(outside, "extension.ts"), join(root, "extensions/outside.ts"));
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_RESOURCE_OUTSIDE_PACKAGE");
	});

	it("discovers conventional directories and reports empty resource sets", async () => {
		const root = fixture({ ...base, pi: undefined }, { "README.md": "# Example", LICENSE: "MIT" });
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_NO_RESOURCES");
	});

	it("composes publint without running package lifecycle scripts", async () => {
		const root = fixture(
			{ ...base, scripts: { prepack: "node -e \\\"require('fs').writeFileSync('executed','yes')\\\"" } },
			{
				"extensions/index.ts": "export default function () {}",
				"skills/example/SKILL.md": "---\nname: example\ndescription: Example skill.\n---\n",
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		await checkPackage(root);
		expect(existsSync(join(root, "executed"))).toBe(false);
	});

	it("maps publint messages into the stable diagnostic envelope", async () => {
		const root = fixture(
			{ ...base, pi: { extensions: ["extensions/index.ts"] }, main: "missing.js" },
			{
				"extensions/index.ts": "export default function () {}",
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root);
		expect(codes(report.diagnostics)).toContain("NPM_FILE_DOES_NOT_EXIST");
	});

	it("bounds diagnostics, files, and both human and JSON output", async () => {
		const imports = Array.from({ length: 40 }, (_, i) => `import value${i} from "missing-${i}";`).join("\n");
		const root = fixture(
			{ name: "x", version: "1.0.0", pi: { extensions: ["extensions/index.ts"] } },
			{ "extensions/index.ts": `${imports}\nexport default function () {}` },
		);
		const report = await checkPackage(root, { generic: false, maxDiagnostics: 10, maxFiles: 20 });
		expect(report.diagnostics).toHaveLength(10);
		expect(report.truncated).toBe(true);
		const human = formatCheckReport(report, false);
		const json = formatCheckReport(report, true);
		expect(human.length).toBeLessThanOrEqual(8_000);
		expect(json.length).toBeLessThanOrEqual(32_000);
		expect(JSON.parse(json).diagnostics).toHaveLength(10);
	});

	it("reports an invalid package path without throwing", async () => {
		const report = await checkPackage(join(tmpdir(), "packed-does-not-exist"), { generic: false });
		expect(codes(report.diagnostics)).toEqual(["PKG_PATH_INVALID"]);
	});

	it("reports invalid package JSON with a stable code", async () => {
		const root = fixture(base);
		writeFileSync(join(root, "package.json"), "{");
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toEqual(["PKG_JSON_INVALID"]);
	});
});

describe("dependencyCheck false-positive regressions (packed check)", () => {
	it("never scans a test file's own fixture strings as if they were real imports of that file", async () => {
		// A checker's own test suite legitimately contains string literals shaped exactly
		// like real import statements (fixture data for testing detection itself) -- these
		// must never be attributed to the test file that merely contains them as text.
		const root = fixture(
			{ ...base, files: ["extensions", "test", "README.md", "LICENSE"] },
			{
				"extensions/index.ts": "export default function () {}",
				"test/check.test.ts": 'const fixtureSource = \'import lodash from "lodash";\';\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("RUNTIME_DEPENDENCY_MISSING");
	});

	it("never scans a test-directory file outside a *.test.ts basename either (e.g. a shared test helper)", async () => {
		const root = fixture(
			{ ...base, files: ["extensions", "test", "README.md", "LICENSE"] },
			{
				"extensions/index.ts": "export default function () {}",
				"test/helper.ts": 'import leftpad from "leftpad";\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("RUNTIME_DEPENDENCY_MISSING");
	});

	it("never treats a quoted 'from ...' phrase inside a comment as a real import specifier", async () => {
		const root = fixture(
			{ ...base, files: ["extensions", "README.md", "LICENSE"] },
			{
				"extensions/index.ts":
					'/**\n * migrated "latest" from "some-package that looks like an import"\n */\nexport default function () {}\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("RUNTIME_DEPENDENCY_MISSING");
	});

	it("still catches a real RUNTIME_DEPENDENCY_MISSING import sitting right next to a misleading comment", async () => {
		const root = fixture(
			{ ...base, files: ["extensions", "README.md", "LICENSE"] },
			{
				"extensions/index.ts":
					'// migrated "latest" from "totally not a real package"\nimport real from "real-missing-dep";\nexport default function () { return real; }\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("RUNTIME_DEPENDENCY_MISSING");
		const diagnostic = report.diagnostics.find((d) => d.code === "RUNTIME_DEPENDENCY_MISSING")!;
		expect(diagnostic.message).toContain("real-missing-dep");
	});

	it("never flags a package's own self-import of its own subpath export as a missing runtime dependency", async () => {
		const root = fixture(
			{ ...base, name: "@scope/self-ref", files: ["extensions", "README.md", "LICENSE"] },
			{
				"extensions/index.ts": 'import { thing } from "@scope/self-ref/client";\nexport default function () { return thing; }\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("RUNTIME_DEPENDENCY_MISSING");
	});

	it("a real (non-*) peerDependency range genuinely satisfies a shipped-code import -- npm's own documented mechanism for a shared-singleton runtime dependency, distinct from CORE_PACKAGES' own peers[name] === '*' contract", async () => {
		const root = fixture(
			{
				...base,
				files: ["extensions", "README.md", "LICENSE"],
				peerDependencies: { ...base.peerDependencies, "@scope/shared-singleton": "^1.2.3" },
				devDependencies: { "@scope/shared-singleton": "^1.2.3" },
			},
			{
				"extensions/index.ts": 'import { thing } from "@scope/shared-singleton";\nexport default function () { return thing; }\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).not.toContain("RUNTIME_DEPENDENCY_MISSING");
	});

	it("still flags a shipped-code import declared only as a devDependency, even though a peerDependency-shaped exception now exists", async () => {
		const root = fixture(
			{ ...base, files: ["extensions", "README.md", "LICENSE"], devDependencies: { "leftover-dev-only": "1.0.0" } },
			{
				"extensions/index.ts": 'import thing from "leftover-dev-only";\nexport default function () { return thing; }\n',
				"README.md": "# Example",
				LICENSE: "MIT",
			},
		);
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("RUNTIME_DEPENDENCY_MISSING");
		const diagnostic = report.diagnostics.find((d) => d.code === "RUNTIME_DEPENDENCY_MISSING")!;
		expect(diagnostic.message).toContain("only a devDependency");
	});
});
