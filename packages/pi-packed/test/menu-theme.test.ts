import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { tabBarTheme } from "../extension/src/menu-theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (color: string, s: string) => `FG(${color}):${s}`,
		bg: (color: string, s: string) => `BG(${color}):${s}`,
		bold: (s: string) => `BOLD:${s}`,
		// biome-ignore lint/suspicious/noExplicitAny: only fg/bg/bold are exercised by tabBarTheme
	} as any;
}

describe("tabBarTheme (the /packed panel's tab bar styling)", () => {
	// Real bug, reported live: theme.inverse() (reverse video) swaps whatever
	// foreground/background are ambient at that point in the ANSI stream --
	// Envelope wraps a whole line (including this tab bar) in one continuous
	// border-color span with no reset until the line's end, so the active
	// tab's own highlight color came out different depending on which tab
	// (and therefore which position on the line) was active. An explicit
	// theme.bg() always overwrites rather than swaps, so the color is the
	// same regardless of position -- matches Pi's own core
	// session-selector.js, which highlights its selected line the same way.
	it("unfocused: applies the dim foreground color, never a background", () => {
		const theme = tabBarTheme(fakeTheme());
		const result = theme.tab("Packages");
		expect(result).toBe("FG(dim):Packages");
	});

	it("focused: applies the theme's own selectedBg color, regardless of position, never reverse-video", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.activeTab("Packages")).toBe("BG(selectedBg):Packages");
		expect(theme.activeTab("Find")).toBe("BG(selectedBg):Find"); // identical regardless of which tab
	});

	// tabBarTheme's own mnemonic function always works when called; it's
	// TabbedContainer's job (not this theme mapping's) to only actually call
	// it for unfocused tabs -- see tabbed-container.test.ts.
	it("the mnemonic letter is styled distinctly, whenever a caller invokes it", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.mnemonic("P")).toContain("FG(warning)");
	});
});
