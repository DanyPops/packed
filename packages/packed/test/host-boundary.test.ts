import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const packageRoot = new URL("..", import.meta.url);

interface PackageManifest {
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

describe("Packed host boundary", () => {
	it("does not depend on a host runtime", () => {
		const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as PackageManifest;
		const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
		expect(manifest.bin).toEqual({ "packed-policy": "dist/repository-policy-cli.js" });
		for (const name of Object.keys(dependencies)) {
			expect(name).not.toMatch(/^@earendil-works\/pi-|^@danypops\/(?:pi-|vehicle)|alef/i);
		}
	});
});
