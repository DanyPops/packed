import { describe, expect, it } from "bun:test";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PackageInspector } from "../extension/src/package-inspector.ts";
import type { Natives } from "../extension/src/packed.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const measure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

describe("PackageInspector", () => {
	it("loads bounded registry metadata and README inside a scrollable detail view", async () => {
		let renders = 0;
		const inspector = new PackageInspector(
			"demo",
			{
				async info() {
					return { name: "demo", version: "1.2.3", license: "MIT", description: "A package", readme: "README \x1b[31mbody" };
				},
			} as unknown as Natives,
			theme,
			measure,
			() => {},
			() => {
				renders += 1;
			},
		);
		expect(inspector.render(40).join("\n")).toContain("Loading registry metadata");
		await inspector.load();
		const rendered = inspector.render(40).join("\n");
		expect(rendered).toContain("Version: 1.2.3");
		expect(rendered).toContain("README (registry metadata)");
		expect(rendered).toContain("README [31mbody");
		expect(rendered).not.toContain("\x1b");
		expect(renders).toBe(1);
	});

	it("closes on the inspect view's escape mnemonic", () => {
		let closed = false;
		const inspector = new PackageInspector(
			"demo",
			{} as Natives,
			theme,
			measure,
			() => {
				closed = true;
			},
			() => {},
		);
		inspector.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});
