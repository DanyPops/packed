/**
 * keymap.ts — the /packed panel's own real keybindings, modeled as a
 * Malevich MnemonicContext tree so findMnemonicConflicts can verify no
 * two actions genuinely reachable at once share a key. This is a
 * hand-maintained mirror of tui.ts/resource-config.ts/discover.ts/
 * security-tui.ts's actual switch statements, not derived from them --
 * keep it in sync when a keybinding changes; keymap.test.ts's own
 * conflict-free assertion is the thing that actually catches drift into
 * a genuine collision, not this file's own accuracy.
 *
 * Tree shape mirrors the real runtime dispatch in tui.ts's
 * renderUnifiedPanel: Packages is a direct child of "global" (Tab/Shift-
 * Tab/Left/Right/Escape only -- Packages' own f/c/s bindings already do
 * the same jump the generic mnemonic dispatch would, so that dispatch is
 * skipped entirely while Packages is active, and modeled here as a
 * SEPARATE branch("mnemonic-jump") that only Find/Config/Settings fall
 * under -- matching the real `if (activeKey !== "packages")` guard.
 */
import type { MnemonicContext } from "malevich-tui-components";

export const PANEL_MNEMONIC_TREE: MnemonicContext = {
	name: "global",
	bindings: [
		{ key: "\x1b", description: "back to Packages, or close from Packages" },
		{ key: "\t", description: "next tab" },
		{ key: "\x1b[Z", description: "previous tab" },
		{ key: "\x1b[C", description: "next tab" },
		{ key: "\x1b[D", description: "previous tab" },
	],
	children: [
		{
			name: "packages",
			bindings: [
				{ key: "\x1b[A", description: "move up" },
				{ key: "\x1b[B", description: "move down" },
				{ key: "v", description: "cycle view mode" },
				{ key: "/", description: "start filter" },
				{ key: "r", description: "refresh" },
				{ key: "U", description: "update every outdated package" },
				{ key: "u", description: "update selected package" },
				{ key: "x", description: "remove selected package" },
				{ key: "d", description: "disable/enable selected package's extensions" },
				{ key: "c", description: "jump to Config, scoped to selected package" },
				{ key: "f", description: "jump to Find" },
				{ key: "s", description: "jump to Settings" },
				{ key: "\r", description: "open the row action menu" },
			],
		},
		{
			name: "mnemonic-jump (Find/Config/Settings only -- Packages' own f/c/s already cover this)",
			bindings: [
				{ key: "p", description: "jump to Packages" },
				{ key: "f", description: "jump to Find" },
				{ key: "c", description: "jump to Config" },
				{ key: "s", description: "jump to Settings" },
			],
			children: [
				{
					name: "find",
					bindings: [
						{ key: "\r", description: "search, or install the highlighted result" },
						{ key: "\x1b[A", description: "move up in results" },
						{ key: "\x1b[B", description: "move down in results" },
					],
				},
				{
					name: "config",
					bindings: [
						{ key: "\x1b[A", description: "move up" },
						{ key: "\x1b[B", description: "move down" },
						{ key: "v", description: "switch global/project scope" },
						{ key: "/", description: "start filter" },
						{ key: "r", description: "refresh" },
						{ key: " ", description: "toggle selected resource" },
						{ key: "\r", description: "toggle selected resource" },
					],
				},
				{
					name: "settings",
					bindings: [
						{ key: "\x1b[A", description: "move up" },
						{ key: "\x1b[B", description: "move down" },
						{ key: "\r", description: "change selected option" },
					],
				},
			],
		},
	],
};
