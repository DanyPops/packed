/**
 * deploy-verify.test.ts — the exact hand-diffing ceremony this module
 * replaces: comparing a package's on-disk version at every known install
 * location plus stale shadow copies, against an expected version.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findShadowCopies, formatDeployVerification, verifyDeploy } from "../src/packages/deploy-verify.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

function writePackageAt(packageJsonPath: string, version: string): void {
	mkdirSync(join(packageJsonPath, ".."), { recursive: true });
	writeFileSync(packageJsonPath, JSON.stringify({ version }));
}

function piHomeWith(name: string, version: string | undefined): string {
	const dir = track(mkdtempSync(join(tmpdir(), "packed-deploy-verify-")));
	if (version !== undefined) writePackageAt(join(dir, "npm", "node_modules", name, "package.json"), version);
	else mkdirSync(join(dir, "npm", "node_modules"), { recursive: true });
	return dir;
}

describe("verifyDeploy", () => {
	it("reports ok when the only known location matches the expected version and no shadow copy exists", () => {
		const piHome = piHomeWith("@scope/pkg", "1.2.3");

		const report = verifyDeploy(piHome, "@scope/pkg", "1.2.3");

		expect(report.ok).toBe(true);
		expect(report.expectedVersion).toBe("1.2.3");
		expect(report.locations[0]!.upToDate).toBe(true);
		expect(report.shadowCopies).toEqual([]);
	});

	it("defaults expectedVersion to whatever's resolved at the primary (Pi npm project) location when none is given", () => {
		const piHome = piHomeWith("@scope/pkg", "2.0.0");

		const report = verifyDeploy(piHome, "@scope/pkg");

		expect(report.expectedVersion).toBe("2.0.0");
		expect(report.ok).toBe(true);
	});

	it("reports not-ok and version-unknown when the package isn't found anywhere and no expected version was given", () => {
		const piHome = piHomeWith("@scope/pkg", undefined);

		const report = verifyDeploy(piHome, "@scope/other-pkg");

		expect(report.expectedVersion).toBeUndefined();
		expect(report.ok).toBe(false);
	});

	it("flags a location still on an older version as stale, not just missing", () => {
		const piHome = piHomeWith("@scope/pkg", "1.0.0");
		const fakeHome = track(mkdtempSync(join(tmpdir(), "packed-deploy-verify-home-")));
		writePackageAt(join(fakeHome, ".cache", ".bun", "install", "global", "node_modules", "@scope/pkg", "package.json"), "0.9.0");

		const report = verifyDeploy(piHome, "@scope/pkg", "1.0.0", fakeHome);

		const bunLocation = report.locations.find((l) => l.label === "Bun global install cache")!;
		expect(bunLocation.present).toBe(true);
		expect(bunLocation.upToDate).toBe(false);
		expect(bunLocation.version).toBe("0.9.0");
		expect(report.ok).toBe(false);
	});
});

describe("findShadowCopies — the exact layout ExecInstaller.reresolveDependencyTree() already fixes for the install path", () => {
	it("finds a nested copy under an unscoped sibling package's own node_modules", () => {
		const piHome = piHomeWith("shared", "2.0.0");
		writePackageAt(join(piHome, "npm", "node_modules", "leaf", "node_modules", "shared", "package.json"), "1.0.0");

		const shadows = findShadowCopies(piHome, "shared");

		expect(shadows).toHaveLength(1);
		expect(shadows[0]!.label).toBe("shadow copy under leaf");
		expect(shadows[0]!.packageJsonPath).toBe(join(piHome, "npm", "node_modules", "leaf", "node_modules", "shared", "package.json"));
	});

	it("finds a nested copy one level under a scoped sibling package", () => {
		const piHome = piHomeWith("shared", "2.0.0");
		writePackageAt(join(piHome, "npm", "node_modules", "@scope", "leaf", "node_modules", "shared", "package.json"), "1.0.0");

		const shadows = findShadowCopies(piHome, "shared");

		expect(shadows).toHaveLength(1);
		expect(shadows[0]!.label).toBe("shadow copy under @scope/leaf");
	});

	it("finds nothing when the tree is clean", () => {
		const piHome = piHomeWith("shared", "2.0.0");
		mkdirSync(join(piHome, "npm", "node_modules", "unrelated"), { recursive: true });

		expect(findShadowCopies(piHome, "shared")).toEqual([]);
	});

	it("never descends into a shadow copy's own node_modules", () => {
		const piHome = piHomeWith("shared", "2.0.0");
		writePackageAt(join(piHome, "npm", "node_modules", "leaf", "node_modules", "shared", "package.json"), "1.0.0");
		// A second-level nested copy inside the shadow copy itself -- out of scope.
		writePackageAt(
			join(piHome, "npm", "node_modules", "leaf", "node_modules", "shared", "node_modules", "shared", "package.json"),
			"0.5.0",
		);

		const shadows = findShadowCopies(piHome, "shared");

		expect(shadows).toHaveLength(1);
	});

	it("reports every shadow copy in verifyDeploy's own report, making the overall result not-ok regardless of the shadow's own version", () => {
		const piHome = piHomeWith("shared", "2.0.0");
		// The shadow copy itself happens to already match the expected version --
		// still a real problem: two copies existing at all is what matters, not
		// whether this particular one happens to agree right now.
		writePackageAt(join(piHome, "npm", "node_modules", "leaf", "node_modules", "shared", "package.json"), "2.0.0");

		const report = verifyDeploy(piHome, "shared", "2.0.0");

		expect(report.shadowCopies).toHaveLength(1);
		expect(report.shadowCopies[0]!.upToDate).toBe(true);
		expect(report.ok).toBe(false);
	});
});

describe("formatDeployVerification", () => {
	it("renders a human-readable PASS report with no shadow copies", () => {
		const piHome = piHomeWith("@scope/pkg", "1.2.3");
		const report = verifyDeploy(piHome, "@scope/pkg", "1.2.3");

		const text = formatDeployVerification(report, false);

		expect(text).toContain("PASS");
		expect(text).toContain("@scope/pkg@1.2.3");
		expect(text).toContain("no shadow copies found");
	});

	it("renders valid JSON when json is true", () => {
		const piHome = piHomeWith("@scope/pkg", "1.2.3");
		const report = verifyDeploy(piHome, "@scope/pkg", "1.2.3");

		const parsed = JSON.parse(formatDeployVerification(report, true));

		expect(parsed.ok).toBe(true);
		expect(parsed.packageName).toBe("@scope/pkg");
	});

	it("renders a human-readable FAIL report listing a stale location", () => {
		const piHome = piHomeWith("@scope/pkg", "1.0.0");
		const report = verifyDeploy(piHome, "@scope/pkg", "9.9.9");

		const text = formatDeployVerification(report, false);

		expect(text).toContain("FAIL");
		expect(text).toContain("STALE (1.0.0)");
	});
});
