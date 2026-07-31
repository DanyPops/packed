import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DialogTheme, MenuTheme } from "malevich-tui-components";

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
