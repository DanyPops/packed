/**
 * Shared dependencies every /packed panel tab needs for its own approval,
 * confirm, and reload flow -- injected once by the single overlay that
 * owns all four tabs (Packages/Find/Config/Settings), so a tab's own
 * mutation code never needs to know about Envelope, Dialog, or
 * TabbedContainer at all. Root cause this replaces: each tab used to open
 * its own separate ctx.ui.custom overlay (or, for Settings, Pi's own
 * native ctx.ui.select/confirm) to run its approve+mutate+reload flow --
 * confirmed live as a real user complaint ("Find, Settings, Config all
 * open a different TUI"). Every tab now runs entirely inside the one
 * overlay tui.ts already owns; this is the seam that makes that possible
 * without each tab file importing tui.ts back (which would cycle).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface TabHost {
	/** The real ctx -- notify/reload/cwd/etc, exactly as Pi provides it. */
	ctx: ExtensionCommandContext;
	/** The same ctx, except ui.confirm renders as this overlay's own inline
	 * Malevich Dialog instead of Pi's separate native confirm dialog. Every
	 * approve/reload call inside a tab's own mutation flow must go through
	 * this, not ctx directly. */
	inlineCtx: ExtensionCommandContext;
	/** Re-renders the whole overlay. Call after any state change a tab
	 * makes outside of a handleInput call the host already re-renders for. */
	requestRender(): void;
	/** Call once a mutation's own ctx.reload() has already replaced the
	 * session -- the host must stop rendering the now-stale overlay. */
	onSessionReplaced(): void;
}
