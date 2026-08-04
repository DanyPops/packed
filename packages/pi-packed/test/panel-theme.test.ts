import { describe, expect, it } from "bun:test";
import { renderToTerminal, type TerminalCell } from "@danypops/pi-tui-harness";
import { type ExtensionCommandContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Natives } from "../extension/src/packed.ts";
import { type PackedTabKey, showPackedPanel } from "../extension/src/tui.ts";

initTheme();

const WIDTH = 80;
const TAB_LABELS: Record<PackedTabKey, string> = {
	packages: "Packages",
	find: "Find",
	config: "Config",
	settings: "Settings",
};

function ansiTheme(mode: "dark" | "light"): Theme {
	const foregrounds: Record<string, number> = {
		accent: 36,
		border: 34,
		dim: 90,
		muted: 90,
		success: 32,
		error: 31,
		warning: 33,
		text: mode === "dark" ? 97 : 30,
	};
	return {
		fg: (color: string, text: string) => `\x1b[${foregrounds[color] ?? 39}m${text}\x1b[39m`,
		bg: (_color: string, text: string) => `\x1b[${mode === "dark" ? 40 : 107}m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
	} as Theme;
}

async function renderPanel(
	mode: "dark" | "light",
	activeTab: PackedTabKey,
	installed: Array<{ name: string; installed: string }> = [],
	width = WIDTH,
): Promise<string[]> {
	let frame: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			async custom(
				factory: (
					tui: { requestRender(): void },
					theme: Theme,
					keybindings: unknown,
					done: (result: unknown) => void,
				) => { render(width: number): string[] },
			) {
				const component = factory({ requestRender() {} }, ansiTheme(mode), {}, () => {});
				frame = component.render(width);
			},
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
	const natives = {
		async installed() {
			return installed;
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

	await showPackedPanel(ctx, natives, { initialTab: activeTab });
	return frame;
}

function displayedBackground(cell: TerminalCell | undefined): number | undefined {
	return cell?.inverse ? cell.fgPaletteIndex : cell?.bgPaletteIndex;
}

function displayedForegroundIsDefault(cell: TerminalCell | undefined): boolean {
	return cell?.inverse ? (cell.isBgDefault ?? false) : (cell?.isFgDefault ?? false);
}

describe("/packed panel theme rendering through a real VT parser", () => {
	it.each(["dark", "light"] as const)("uses an opposite-luminance active-tab background in %s mode", async (mode) => {
		const expectedBackground = mode === "dark" ? 15 : 0;
		for (const activeTab of Object.keys(TAB_LABELS) as PackedTabKey[]) {
			const frame = await renderPanel(mode, activeTab);
			const terminal = await renderToTerminal(frame, { cols: WIDTH, rows: frame.length });
			try {
				const lines = terminal.plainLines();
				const tabRow = lines.findIndex((line) => line.includes("Packages") && line.includes("Settings"));
				const labelColumn = lines[tabRow]!.indexOf(TAB_LABELS[activeTab]);
				for (let offset = 0; offset < TAB_LABELS[activeTab].length; offset++) {
					const cell = terminal.cellAt(tabRow, labelColumn + offset);
					expect(displayedBackground(cell)).toBe(expectedBackground);
					expect(displayedForegroundIsDefault(cell)).toBe(true);
				}
			} finally {
				terminal.dispose();
			}
		}
	});

	it.each([40, 80, 120])("bounds installed-package Cards at %i columns", async (width) => {
		const frame = await renderPanel("dark", "packages", [{ name: "demo-package", installed: "1.2.3" }], width);
		for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("uses one accent treatment for the selected Card frame and body", async () => {
		const frame = await renderPanel("dark", "packages", [{ name: "demo-package", installed: "1.2.3" }]);
		const terminal = await renderToTerminal(frame, { cols: WIDTH, rows: frame.length });
		try {
			const lines = terminal.plainLines();
			const topRow = lines.findIndex((line) => line.includes("┌") && line.includes("┐"));
			const left = lines[topRow]!.indexOf("┌");
			const right = lines[topRow]!.lastIndexOf("┐");
			expect(terminal.cellAt(topRow, left)?.fgPaletteIndex).toBe(6);
			expect(terminal.cellAt(topRow, right)?.fgPaletteIndex).toBe(6);
			expect(terminal.cellAt(topRow + 1, left + 1)?.fgPaletteIndex).toBe(6);
			expect(terminal.cellAt(topRow + 1, left + 1)?.inverse).toBe(false);
		} finally {
			terminal.dispose();
		}
	});

	it("packs Cards without spacer rows and keeps the outer bottom border within 24 rows", async () => {
		const installed = Array.from({ length: 10 }, (_, index) => ({ name: `demo-${index}`, installed: "1.2.3" }));
		const frame = await renderPanel("dark", "packages", installed);
		const plain = frame.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		const firstBottom = plain.findIndex((line) => line.includes("└") && line.includes("┘"));
		expect(plain[firstBottom + 1]).toContain("┌");
		expect(frame.length).toBeLessThanOrEqual(24);
		expect(plain.at(-1)).toMatch(/^╰─+╯$/u);
	});

	it("renders every frame glyph in the border color, independent of styled content", async () => {
		for (const activeTab of Object.keys(TAB_LABELS) as PackedTabKey[]) {
			const frame = await renderPanel("dark", activeTab);
			const terminal = await renderToTerminal(frame, { cols: WIDTH, rows: frame.length });
			try {
				for (const [row, line] of terminal.plainLines().slice(0, frame.length).entries()) {
					for (const [column, char] of [...line].entries()) {
						if (!"╭─╮│╰╯".includes(char)) continue;
						const cell = terminal.cellAt(row, column);
						expect(cell?.fgPaletteIndex).toBe(4);
						expect(cell?.inverse).toBe(false);
					}
				}
			} finally {
				terminal.dispose();
			}
		}
	});
});
