import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPackReport, NpmPackVerifier, type PackCommand } from "../src/pack.ts";
import { assessLocalAdoption, assessRegistryAdoption } from "../src/score.ts";

function fixture(manifest: Record<string, unknown>, readme = ""): string {
	const root = mkdtempSync(join(tmpdir(), "packed-pack-"));
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	if (readme) writeFileSync(join(root, "README.md"), readme);
	return root;
}

const successfulPack: PackCommand = async (_cwd, args) => {
	expect(args).toEqual(["pack", "--dry-run", "--json", "--ignore-scripts"]);
	return {
		code: 0,
		stdout: JSON.stringify([{ id: "pi-demo@1.0.0", name: "pi-demo", version: "1.0.0", size: 500, unpackedSize: 1000, shasum: "abc", integrity: "sha512-test", filename: "pi-demo-1.0.0.tgz", files: [
			{ path: "package.json", size: 200, mode: 420 },
			{ path: "extensions/demo.ts", size: 800, mode: 420 },
		] }]),
		stderr: "",
	};
};

describe("npm tarball verification", () => {
	it("uses npm pack dry-run JSON without lifecycle scripts and verifies Pi shape", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0", keywords: ["pi-package"], pi: { extensions: ["extensions/demo.ts"] } });
		mkdirSync(join(root, "extensions"));
		writeFileSync(join(root, "extensions/demo.ts"), "export default () => {};");
		const report = await new NpmPackVerifier(successfulPack).verify(root);
		expect(report.ok).toBe(true);
		expect(report.command).toEqual(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"]);
		expect(report.shape).toEqual({ kind: "manifest", verified: true, evidence: ["pi.extensions"] });
		expect(report.integrity).toBe("sha512-test");
	});

	it("suppresses npm lifecycle scripts in the real dry-run", async () => {
		const root = fixture({ name: "pi-no-scripts", version: "1.0.0", scripts: { prepack: "touch lifecycle-ran" }, pi: { extensions: ["extension.ts"] } });
		writeFileSync(join(root, "extension.ts"), "export default () => {};");
		const report = await new NpmPackVerifier().verify(root);
		expect(report.ok).toBe(true);
		expect(existsSync(join(root, "lifecycle-ran"))).toBe(false);
	});

	it("reports excluded resources and sensitive tarball paths with stable codes", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0", pi: { extensions: ["extensions/missing.ts"] } });
		const command: PackCommand = async () => ({ code: 0, stderr: "", stdout: JSON.stringify([{ name: "pi-demo", version: "1.0.0", files: [{ path: ".env", size: 20 }], size: 20, unpackedSize: 20 }]) });
		const report = await new NpmPackVerifier(command).verify(root);
		expect(report.ok).toBe(false);
		expect(report.diagnostics.map((item) => item.code)).toContain("PACK_DECLARED_RESOURCE_MISSING");
		expect(report.diagnostics.map((item) => item.code)).toContain("PACK_SENSITIVE_FILE");
	});

	it("keeps bounded JSON output valid", () => {
		const output = formatPackReport({ root: "/tmp/pkg", ok: true, command: ["npm", "pack"], files: Array.from({ length: 2_000 }, (_, index) => ({ path: `${"x".repeat(500)}/${index}`, size: 1 })), shape: { kind: "conventional", verified: true, evidence: ["extensions"] }, diagnostics: [], truncated: false }, true);
		expect(output.length).toBeLessThanOrEqual(64 * 1024);
		expect(JSON.parse(output).outputTruncated).toBe(true);
	});

	it("bounds malformed and failed npm output", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0" });
		const failed = await new NpmPackVerifier(async () => ({ code: 1, stdout: "x".repeat(100_000), stderr: "npm failed" })).verify(root);
		expect(failed.ok).toBe(false);
		expect(failed.diagnostics[0]?.code).toBe("PACK_COMMAND_FAILED");
		expect(JSON.stringify(failed).length).toBeLessThan(20_000);
	});
});

describe("adoption readiness evidence", () => {
	it("reports transparent local dimensions without turning traction into quality", async () => {
		const root = fixture({
			name: "pi-demo",
			version: "1.0.0",
			description: "Focused Pi demo extension",
			keywords: ["pi-package", "pi-extension"],
			license: "MIT",
			repository: "https://github.com/example/pi-demo",
			bugs: "https://github.com/example/pi-demo/issues",
			peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
			pi: { extensions: ["extensions/demo.ts"] },
		}, "# pi-demo\n\nInstall: `pi install npm:pi-demo`\n\n## Usage\nRun `/demo`.\n\n![demo](demo.png)\n");
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = assessLocalAdoption(root, pack);
		expect(report.dimensions.discoverability.met).toBeGreaterThan(0);
		expect(report.dimensions.firstRun.status).toBe("ready");
		expect(report.dimensions.traction.status).toBe("unknown");
		expect(report.dimensions.traction.evidence.join(" ")).toContain("not a quality signal");
	});

	it("shows provenance and bounded download observations while leaving trusted publisher unknown", () => {
		const report = assessRegistryAdoption({
			name: "pi-demo", version: "1.0.0", description: "demo", keywords: ["pi-package"], license: "MIT",
			repository: "https://github.com/example/pi-demo", pi: { extensions: ["extension.ts"] },
			publication: { integrity: "sha512-test", provenanceUrl: "https://registry.example/attestation", trustedPublisher: "unknown" },
			downloads: { weekly: 12, monthly: 34, observedAt: "2026-07-27T00:00:00.000Z" },
		});
		expect(report.dimensions.trust.evidence.join(" ")).toContain("provenance");
		expect(report.dimensions.trust.actions.join(" ")).toContain("trusted publisher");
		expect(report.dimensions.traction.evidence.join(" ")).toContain("12 weekly");
	});
});
