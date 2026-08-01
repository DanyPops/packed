import { describe, expect, it } from "bun:test";
import { findMnemonicConflicts } from "malevich-tui-components";
import { PANEL_MNEMONIC_TREE } from "../extension/src/keymap.ts";

describe("PANEL_MNEMONIC_TREE (the /packed panel's real keybindings)", () => {
	// The actual "built-in mnemonic conflict detector" this whole file
	// exists for: a future keybinding added to any tab that collides with
	// something already reachable at the same time (a global shortcut, or
	// another binding on the same tab) fails this test immediately instead
	// of surfacing as a confusing runtime surprise. Two SIBLING tabs (never
	// simultaneously active) freely reusing a key -- e.g. both Packages and
	// Config binding "v" to their own, different "cycle a sub-view" concept
	// -- is correctly not a conflict; see mnemonics.ts's own doc comment.
	it("has zero real conflicts anywhere in the tree", () => {
		expect(findMnemonicConflicts(PANEL_MNEMONIC_TREE)).toEqual([]);
	});

	// A deliberately introduced conflict, to prove the check above isn't
	// vacuously passing on an empty or trivial tree.
	it("genuinely detects a conflict when one is deliberately introduced", () => {
		const broken = {
			...PANEL_MNEMONIC_TREE,
			children: PANEL_MNEMONIC_TREE.children!.map((child) =>
				child.name === "packages" ? { ...child, bindings: [...child.bindings, { key: "\t", description: "a fake conflicting Tab binding" }] } : child,
			),
		};
		const conflicts = findMnemonicConflicts(broken);
		expect(conflicts.length).toBeGreaterThan(0);
		expect(conflicts.some((c) => c.key === "\t")).toBe(true);
	});

	// Every tab currently reachable via the panel's own TabbedContainer
	// (see tui.ts's renderUnifiedPanel) has its label's own first letter
	// as its dedicated jump mnemonic -- this is the literal invariant the
	// tab bar's own highlighting promises the user.
	it("every mnemonic-jump binding matches the tab label's own first letter", () => {
		const labelsByKey: Record<string, string> = { p: "Packages", f: "Find", c: "Config", s: "Settings" };
		const jumpContext = PANEL_MNEMONIC_TREE.children!.find((c) => c.name.startsWith("mnemonic-jump"))!;
		for (const binding of jumpContext.bindings) {
			const label = labelsByKey[binding.key];
			expect(label).toBeDefined();
			expect(label!.toLowerCase().startsWith(binding.key)).toBe(true);
		}
	});
});
