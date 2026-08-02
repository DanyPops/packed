/**
 * security-tui.ts — /packed's Settings tab: a small radio-style list
 * (Malevich's Component contract, not a bespoke Menu) so it can plug
 * straight into TabbedContainer alongside Packages/Find/Config on the
 * same overlay. Previously ran through Pi's own native
 * ctx.ui.select/ctx.ui.confirm -- a genuinely separate, arrow-select-only
 * dialog from any custom overlay, confirmed live as the same "opens a
 * different TUI" complaint the other three tabs had.
 */

import type { SecuritySettings } from "@danypops/pi-packed/protocol";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "malevich-tui-components";

type MutationApproval = SecuritySettings["mutationApproval"];

import type { Natives } from "../packed.ts";
import type { TabHost } from "../tab-host.ts";

const OPTIONS: Array<{ value: MutationApproval; label: string }> = [
	{ value: "always", label: "Always require mutation approval (recommended)" },
	{ value: "never", label: "Never require mutation approval (unsafe opt-out)" },
];

interface Theme {
	fg(color: string, s: string): string;
	bold(s: string): string;
}

export class SettingsTab implements Component {
	private current: MutationApproval = "always";
	private selectedIndex = 0;
	private loaded = false;

	constructor(
		private readonly natives: Pick<Natives, "security" | "setMutationApproval">,
		private readonly host: TabHost,
		// biome-ignore lint/correctness/noUnusedPrivateClassMembers: read via `const { theme } = this` in render(), which Biome's usage check doesn't trace
		private readonly theme: Theme,
	) {}

	async load(): Promise<void> {
		try {
			const settings = await this.natives.security();
			this.current = settings.mutationApproval;
		} catch (error) {
			this.host.ctx.ui.notify(`packed unavailable: ${error instanceof Error ? error.message : error}`, "error");
		}
		this.selectedIndex = OPTIONS.findIndex((o) => o.value === this.current);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
		this.loaded = true;
	}

	// No capturesEscape/capturesHorizontalArrows override -- no free-text entry
	// or in-flight blocking state here, so the host's own global Escape/Left/
	// Right handling is always safe (both default to false when absent).

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const hint = rawKeyHint("up/down", "move") + theme.fg("muted", " · ") + rawKeyHint("enter", "change");
		const line1 = truncateToWidth(hint, width, "");
		const line2 = truncateToWidth(theme.fg("muted", `current: ${this.current}`), width, "");
		const lines = [line1, line2, ""];
		if (!this.loaded) {
			lines.push(theme.fg("muted", "  Loading…"));
			return lines;
		}
		for (let i = 0; i < OPTIONS.length; i++) {
			const option = OPTIONS[i]!;
			const selected = i === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
			const mark = option.value === this.current ? theme.fg("success", "●") : theme.fg("dim", "○");
			const label = selected ? theme.bold(option.label) : option.label;
			lines.push(truncateToWidth(`${cursor}${mark} ${label}`, width, "…"));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (!this.loaded) return;
		switch (data) {
			case "\x1b[A":
				this.selectedIndex = (this.selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
				this.host.requestRender();
				return;
			case "\x1b[B":
				this.selectedIndex = (this.selectedIndex + 1) % OPTIONS.length;
				this.host.requestRender();
				return;
			case "\r":
				void this.apply(OPTIONS[this.selectedIndex]!);
				return;
			default:
				return;
		}
	}

	private async apply(selected: { value: MutationApproval; label: string }): Promise<void> {
		if (selected.value === this.current) return;
		const approved = await this.host.inlineCtx.ui.confirm(
			"Change package mutation approval",
			selected.value === "never"
				? "Disable confirmation for install, update, remove, and package security changes? Packages can execute arbitrary code."
				: "Restore confirmation for install, update, remove, and package security changes?",
		);
		this.host.requestRender();
		if (!approved) return;
		const updated = await this.natives.setMutationApproval(selected.value, true);
		this.current = updated.mutationApproval;
		this.selectedIndex = OPTIONS.findIndex((o) => o.value === this.current);
		this.host.ctx.ui.notify(
			updated.mutationApproval === "always"
				? "Package mutations now require confirmation."
				: "Package mutation confirmation disabled. Packages can execute arbitrary code.",
			updated.mutationApproval === "always" ? "info" : "warning",
		);
		this.host.requestRender();
	}
}

export async function createSettingsTab(natives: Natives, host: TabHost, theme: Theme): Promise<SettingsTab> {
	const tab = new SettingsTab(natives, host, theme);
	await tab.load();
	return tab;
}
