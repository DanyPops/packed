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
			// A real semver range, not "workspace:*" -- this repo's publish workflow runs
			// `npm publish`, which has no notion of Bun's workspace protocol and ships it
			// as a literal, unresolvable string to real npm consumers (confirmed live:
			// pi-packed@0.19.10 published this way and was uninstallable outside the
			// monorepo). `bun install` still resolves this range to the local workspace
			// package during monorepo development, same as before the Pi-core split.
			dependencies: { "@danypops/packed": "^0.6.0" },
		});
		for (const file of sourceFiles(join(root, "extension"))) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(/from\s+["']\.\.\/\.\./);
			expect(source).not.toMatch(/bun:sqlite|\bBun\./);
		}
	});
});
