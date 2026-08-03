import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { panelFrameStyle, tabBarTheme } from "../extension/src/menu-theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (color: string, s: string) => `FG(${color}):${s}`,
		bg: (color: string, s: string) => `BG(${color}):${s}`,
		bold: (s: string) => `BOLD:${s}`,
		inverse: (s: string) => `INVERSE:${s}`,
		// biome-ignore lint/suspicious/noExplicitAny: only styling methods used by these mappings are needed
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

	it("focused: sets the text color before reverse-video, identically at every position", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.activeTab("Packages")).toBe("INVERSE:FG(text):Packages");
		expect(theme.activeTab("Find")).toBe("INVERSE:FG(text):Find");
	});

	// tabBarTheme's own mnemonic function always works when called; it's
	// TabbedContainer's job (not this theme mapping's) to only actually call
	// it for unfocused tabs -- see tabbed-container.test.ts.
	it("the mnemonic letter is styled distinctly, whenever a caller invokes it", () => {
		const theme = tabBarTheme(fakeTheme());
		expect(theme.mnemonic("P")).toContain("FG(warning)");
	});
});

describe("panelFrameStyle", () => {
	it("styles only frame glyphs, leaving content outside the border color span", () => {
		expect(panelFrameStyle(fakeTheme())("│ content │")).toBe("FG(border):│ content FG(border):│");
	});
});
