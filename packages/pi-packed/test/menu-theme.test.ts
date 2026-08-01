import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { tabBarTheme } from "../extension/src/menu-theme.ts";

function fakeTheme(): Theme {
	const calls: Array<{ fn: "fg" | "bg" | "bold"; color?: string }> = [];
	return {
		fg: (color: string, s: string) => {
			calls.push({ fn: "fg", color });
			return `FG(${color}):${s}`;
		},
		bg: (color: string, s: string) => {
			calls.push({ fn: "bg", color });
			return `BG(${color}):${s}`;
		},
		bold: (s: string) => `BOLD:${s}`,
		// biome-ignore lint/suspicious/noExplicitAny: only fg/bg/bold are exercised by tabBarTheme
	} as any;
}

describe("tabBarTheme (the /packed panel's tab bar styling)", () => {
	// Real bug, reported live: focused/unfocused tabs must be visually
	// inverted, not just differently colored text -- focused has a
	// background color and no foreground color, unfocused has a foreground
	// color and no background.
	it("unfocused: applies a foreground color, never a background", () => {
		const theme = tabBarTheme(fakeTheme());
		const result = theme.tab("Packages");
		expect(result).toContain("FG(");
		expect(result).not.toContain("BG(");
	});

	it("focused: applies a background color, never an explicit foreground", () => {
		const theme = tabBarTheme(fakeTheme());
		const result = theme.activeTab("Packages");
		expect(result).toContain("BG(");
		expect(result).not.toContain("FG(");
	});

	it("the mnemonic letter is styled distinctly on both focused and unfocused tabs", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.mnemonic("P")).toContain("FG(warning)");
	});
});
