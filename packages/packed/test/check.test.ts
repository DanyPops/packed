import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPackage, discoverPackageResources, formatCheckReport, type Diagnostic } from "../src/check.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

describe("packed check", () => {
	it("accepts a complete static Pi package without executing it", async () => {
		const root = fixture(base, {
			"extensions/index.ts": 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; export default function (pi: ExtensionAPI) { pi.registerCommand("example", { handler() {} }); }',
			"skills/example/SKILL.md": "---\nname: example\ndescription: Runs the example workflow. Use for examples.\n---\n\nSee [reference](reference/guide.md).\n",
			"skills/example/reference/guide.md": "# Guide\n",
			"README.md": "# Example\n",
			"LICENSE": "MIT\n",
		});
		const report = await checkPackage(root, { generic: false });
		expect(report.ok).toBe(true);
		expect(report.root).toBe(root);
		expect(report.summary.errors).toBe(0);
		expect(report.checkedFiles).toBeGreaterThan(0);
	});

	it("returns stable manifest, resource, containment, dependency, metadata, and skill codes", async () => {
		const root = fixture({
			name: "Bad Package",
			version: "wat",
			keywords: [],
			pi: { extensions: ["../escape.ts", "extensions/[", "node_modules/pi-child/extensions"], skills: ["skills/*/SKILL.md"], prompts: "prompts/*.md", image: "https://example.test/image.svg", video: "https://example.test/video.webm" },
			dependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" },
			devDependencies: { leftpad: "1.0.0" },
		}, {
			"skills/bad/SKILL.md": "---\nname: Bad_Name\n---\n\nSee [missing](reference/missing.md).\n",
			"extensions/index.ts": 'import leftpad from "leftpad"; export default () => leftpad;',
		});
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toEqual(expect.arrayContaining([
			"PKG_NAME_INVALID", "PKG_VERSION_INVALID", "PKG_LICENSE_MISSING", "PKG_REPOSITORY_MISSING",
			"PKG_HOMEPAGE_MISSING", "PKG_BUGS_MISSING", "PI_KEYWORD_MISSING", "PI_MANIFEST_FIELD_INVALID",
			"PI_RESOURCE_OUTSIDE_PACKAGE", "PI_RESOURCE_GLOB_INVALID", "PI_RESOURCE_NO_MATCH", "PI_IMAGE_FORMAT_INVALID", "PI_VIDEO_FORMAT_INVALID",
			"PI_CORE_DEPENDENCY_PLACEMENT", "PI_PACKAGE_NOT_BUNDLED", "RUNTIME_DEPENDENCY_MISSING", "SKILL_NAME_INVALID",
			"SKILL_DESCRIPTION_MISSING", "SKILL_REFERENCE_MISSING", "PACKAGE_README_MISSING", "PACKAGE_LICENSE_FILE_MISSING",
		]));
		expect(report.ok).toBe(false);
	});

	it("rejects declared resources excluded from the npm package", async () => {
		const root = fixture({ ...base, files: ["README.md"], pi: { extensions: ["extensions/index.ts"] } }, {
			"extensions/index.ts": "export default function () {}",
			"README.md": "# Example",
			"LICENSE": "MIT",
		});
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_RESOURCE_NOT_PUBLISHED");
	});

	it("rejects declared resources that escape through a symlink", async () => {
		const outside = mkdtempSync(join(tmpdir(), "packed-check-outside-"));
		roots.push(outside);
		writeFileSync(join(outside, "extension.ts"), "export default function () {}");
		const root = fixture({ ...base, pi: { extensions: ["extensions/outside.ts"] } }, { "README.md": "# Example", "LICENSE": "MIT" });
		mkdirSync(join(root, "extensions"), { recursive: true });
		symlinkSync(join(outside, "extension.ts"), join(root, "extensions/outside.ts"));
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_RESOURCE_OUTSIDE_PACKAGE");
	});

	it("discovers conventional directories and reports empty resource sets", async () => {
		const root = fixture({ ...base, pi: undefined }, { "README.md": "# Example", "LICENSE": "MIT" });
		const report = await checkPackage(root, { generic: false });
		expect(codes(report.diagnostics)).toContain("PI_NO_RESOURCES");
	});

	it("composes publint without running package lifecycle scripts", async () => {
		const root = fixture({ ...base, scripts: { prepack: "node -e \\\"require('fs').writeFileSync('executed','yes')\\\"" } }, {
			"extensions/index.ts": "export default function () {}",
			"skills/example/SKILL.md": "---\nname: example\ndescription: Example skill.\n---\n",
			"README.md": "# Example",
			"LICENSE": "MIT",
		});
		await checkPackage(root);
		expect(existsSync(join(root, "executed"))).toBe(false);
	});

	it("maps publint messages into the stable diagnostic envelope", async () => {
		const root = fixture({ ...base, pi: { extensions: ["extensions/index.ts"] }, main: "missing.js" }, {
			"extensions/index.ts": "export default function () {}",
			"README.md": "# Example",
			"LICENSE": "MIT",
		});
		const report = await checkPackage(root);
		expect(codes(report.diagnostics)).toContain("NPM_FILE_DOES_NOT_EXIST");
	});

	it("bounds diagnostics, files, and both human and JSON output", async () => {
		const imports = Array.from({ length: 40 }, (_, i) => `import value${i} from "missing-${i}";`).join("\n");
		const root = fixture({ name: "x", version: "1.0.0", pi: { extensions: ["extensions/index.ts"] } }, { "extensions/index.ts": `${imports}\nexport default function () {}` });
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
