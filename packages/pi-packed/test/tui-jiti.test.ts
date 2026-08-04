import { describe, expect, it } from "bun:test";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { Natives } from "../extension/src/packed.ts";

initTheme();

const modulePath = new URL("../extension/src/tui.ts", import.meta.url).pathname;

function natives(): Natives {
	return {
		async installed() {
			return [{ name: "demo", installed: "1.0.0" }];
		},
		async updates() {
			return [];
		},
		async security() {
			return { mutationApproval: "always" as const };
		},
		async listResources() {
			return { global: [], project: [] };
		},
	} as unknown as Natives;
}

function context(rendered: string[]): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			custom(
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: () => void,
				) => { render(width: number): string[]; handleInput(data: string): void },
			) {
				return new Promise<void>((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					);
					rendered.push(...component.render(60));
					resolve();
				});
			},
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
}

describe("/packed under Pi's Jiti loader", () => {
	for (const tryNative of [false, true]) {
		it(`constructs and renders the real panel with tryNative:${tryNative}`, async () => {
			const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative });
			const loaded = (await jiti.import(modulePath)) as typeof import("../extension/src/tui.ts");
			const rendered: string[] = [];

			await loaded.showPackedPanel(context(rendered), natives());

			expect(rendered.join("\n")).toContain("demo");
			expect(rendered.join("\n")).not.toContain("Packed could not render");
		});
	}
});
