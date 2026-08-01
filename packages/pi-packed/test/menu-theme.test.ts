import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { tabBarTheme } from "../extension/src/menu-theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (color: string, s: string) => `FG(${color}):${s}`,
		inverse: (s: string) => `INVERSE:${s}`,
		bold: (s: string) => `BOLD:${s}`,
		// biome-ignore lint/suspicious/noExplicitAny: only fg/inverse/bold are exercised by tabBarTheme
	} as any;
}

describe("tabBarTheme (the /packed panel's tab bar styling)", () => {
	// Real bug, reported live: a theme's own selectedBg color can be too
	// close in luminance to the surrounding UI to read as a highlight at
	// all -- real ANSI reverse-video guarantees contrast on any theme
	// instead of depending on one more configured color. Matches
	// pi-tickets' own TabMenu convention (dim/inverse), not a new one.
	it("unfocused: applies the dim foreground color, never reverse-video", () => {
		const theme = tabBarTheme(fakeTheme());
		const result = theme.tab("Packages");
		expect(result).toBe("FG(dim):Packages");
	});

	it("focused: applies reverse-video only, never an explicit foreground or bold", () => {
		const theme = tabBarTheme(fakeTheme());
		const result = theme.activeTab("Packages");
		expect(result).toBe("INVERSE:Packages");
	});

	it("the mnemonic letter is styled distinctly on both focused and unfocused tabs", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.mnemonic("P")).toContain("FG(warning)");
	});
});
