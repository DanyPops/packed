import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CardTheme, DialogTheme, MenuTheme, TabBarTheme } from "malevich-tui-components";

/** Maps Pi's own Theme onto Malevich's Menu -- the one place this mapping
 * exists, shared by every ctx.ui.custom overlay menu in this extension. */
export function cardTheme(theme: Theme): CardTheme {
	return {
		border: (s) => theme.fg("border", s),
		selectedBorder: (s) => theme.fg("accent", s),
		content: (s) => s,
		selectedContent: (s) => theme.fg("accent", s),
	};
}

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
		tab: (s) => theme.fg("dim", s),
		// Set the semantic text color before reversing it. Reverse video then
		// makes dark themes use their bright text as the highlight background
		// and light themes use their dark text, without inheriting Envelope's
		// ambient border foreground. Every tab position gets the same default
		// terminal background as its displayed foreground.
		activeTab: (s) => {
			const text = theme.fg("text", s);
			return typeof theme.inverse === "function" ? theme.inverse(text) : text;
		},
		// Every tab's first letter is a jump mnemonic (p/f/c/s) -- a distinct
		// warning-colored bold, so it reads as "press this letter" on both the
		// active and inactive tabs alike, not just whichever style tab/activeTab
		// already applies to the whole label.
		mnemonic: (s) => theme.bold(theme.fg("warning", s)),
	};
}

/** Envelope calls style with assembled lines in released Malevich versions.
 * Color only frame glyphs so styled content cannot reset the closing border
 * or inherit the border foreground. This remains compatible with Malevich's
 * segment-styled Envelope implementation. */
export function panelFrameStyle(theme: Theme): (text: string) => string {
	return (text) => text.replace(/[╭─╮│╰╯]+/gu, (glyphs) => theme.fg("border", glyphs));
}
