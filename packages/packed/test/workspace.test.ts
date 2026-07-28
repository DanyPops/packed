import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const packageRoot = new URL("..", import.meta.url);
const workspaceRoot = new URL("../../..", import.meta.url);

function json(url: URL): Record<string, any> {
	return JSON.parse(readFileSync(url, "utf8"));
}

describe("Packed workspace boundary", () => {
	it("keeps the workspace root private and the core independently publishable", () => {
		const root = json(new URL("package.json", workspaceRoot));
		const core = json(new URL("package.json", packageRoot));
		expect(root).toMatchObject({ private: true, workspaces: ["packages/*"] });
		expect(root.pi).toBeUndefined();
		expect(root.bin).toBeUndefined();
		expect(core).toMatchObject({ name: "@danypops/packed", bin: { packed: "src/cli.ts" } });
		expect(typeof core.version).toBe("string");
		expect(core.pi).toBeUndefined();
		expect(core.files).toEqual(["src", "dist", "schema", "README.md"]);
	});
});
