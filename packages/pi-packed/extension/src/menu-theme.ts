import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MenuTheme } from "malevich-tui-components";

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
