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
		// Real bug, reported live: theme.inverse() swaps whatever
		// foreground/background happen to be ambient at that point in the
		// ANSI stream, not a specific color -- and Envelope wraps a whole
		// content line (including this tab bar) in one continuous border-color
		// span with no reset until the line's end, so which tab is active
		// changed what "ambient" meant (blue when Packages was first on the
		// line and nothing had reset yet, white once an earlier inactive tab's
		// own fg reset already cleared it). An explicit theme.bg() always
		// overwrites rather than swaps, so it's immune to that -- matches
		// Pi's own core session-selector.js, which highlights its selected
		// line the same way.
		tab: (s) => theme.fg("dim", s),
		activeTab: (s) => theme.bg("selectedBg", s),
		// Every tab's first letter is a jump mnemonic (p/f/c/s) -- a distinct
		// warning-colored bold, so it reads as "press this letter" on both the
		// active and inactive tabs alike, not just whichever style tab/activeTab
		// already applies to the whole label.
		mnemonic: (s) => theme.bold(theme.fg("warning", s)),
	};
}
