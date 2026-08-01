import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DialogTheme, MenuTheme, TabBarTheme } from "malevich-tui-components";

/** Maps Pi's own Theme onto Malevich's Menu -- the one place this mapping
 * exists, shared by every ctx.ui.custom overlay menu in this extension. */
export function menuTheme(theme: Theme): MenuTheme {
	return {
		border: (s) => theme.fg("border", s),
		selected: (s) => theme.fg("accent", s),
		normal: (s) => s,
		dim: (s) => theme.fg("muted", s),
		title: (s) => theme.fg("accent", s),
	};
}

/** Maps Pi's own Theme onto Malevich's Dialog -- used for an inline y/n
 * decision (e.g. confirmReload) rendered as part of an already-open
 * ctx.ui.custom overlay's own content, instead of ctx.ui.confirm's separate,
 * arrow-select-only native dialog. */
export function dialogTheme(theme: Theme): DialogTheme {
	return {
		border: (s) => theme.fg("border", s),
		title: (s) => theme.bold(theme.fg("accent", s)),
		body: (s) => s,
		dim: (s) => theme.fg("muted", s),
	};
}

/** Maps Pi's own Theme onto Malevich's TabbedContainer -- the persistent
 * Packages/Find/Config/Settings tab bar at the top of /packed's one
 * overlay, replacing what used to be four separately-opened screens. */
export function tabBarTheme(theme: Theme): TabBarTheme {
	return {
		// Matches pi-tickets' own TabMenu convention (tab/activeTab, same
		// reverse-video choice) rather than inventing a new one: real ANSI
		// reverse-video for the focused tab, since a theme's own selectedBg
		// can be too close in luminance to the surrounding UI to read as a
		// highlight at all -- reverse video swaps whatever foreground and
		// background are already in effect, guaranteeing contrast on any theme.
		tab: (s) => theme.fg("dim", s),
		activeTab: (s) => theme.inverse(s),
		// Every tab's first letter is a jump mnemonic (p/f/c/s) -- a distinct
		// warning-colored bold, so it reads as "press this letter" on both the
		// active and inactive tabs alike, not just whichever style tab/activeTab
		// already applies to the whole label.
		mnemonic: (s) => theme.bold(theme.fg("warning", s)),
	};
}
