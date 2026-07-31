import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}

describe("pi-packed package boundary", () => {
	it("is an independent Pi package depending only on public Packed exports", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(manifest).toMatchObject({ name: "@danypops/pi-packed", version: "0.10.0", pi: { extensions: ["extension/src/index.ts"] }, dependencies: { "@danypops/packed": "^0.2.0" } });
		expect(manifest.bin).toBeUndefined();
		for (const file of sourceFiles(join(root, "extension"))) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/from\s+["']\.\.\/\.\./);
			expect(source).not.toMatch(/bun:sqlite|\bBun\./);
		}
	});
});
