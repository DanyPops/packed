import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [],
	);
}

describe("pi-packed package boundary", () => {
	it("owns the Pi host and consumes Packed's shared public export", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
		expect(manifest).toMatchObject({
			name: "@danypops/pi-packed",
			bin: { packed: "service/src/cli/cli.ts" },
			pi: { extensions: ["extension/src/index.ts"] },
			dependencies: { "@danypops/packed": "workspace:*" },
		});
		for (const file of sourceFiles(join(root, "extension"))) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/from\s+["']\.\.\/\.\./);
			expect(source).not.toMatch(/bun:sqlite|\bBun\./);
		}
	});
});
