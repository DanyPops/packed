/**
 * resource-config.ts — /packed's Config tab: enable/disable individual
 * extensions, skills, prompt templates, and themes declared by installed
 * Pi packages, matching pi's own `pi config` interaction model (group by
 * package, toggle with space/enter, Tab to switch global/project scope).
 * Pi's own settings mutation lives in its internal SettingsManager, which
 * extensions cannot reach -- this reads and writes the same documented
 * settings.json filter arrays (docs/packages.md, "Enable and Disable
 * Resources") entirely through Packed's authenticated daemon. A real
 * Component (not its own ctx.ui.custom overlay) so it plugs straight into
 * TabbedContainer alongside Packages/Find/Settings on the same overlay --
 * it used to open a second, visually distinct screen (no Malevich
 * Envelope, its own hand-rolled Container+DynamicBorder chrome), confirmed
 * live as a real "opens a different TUI" complaint.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "malevich-tui-components";
import type { PackageResources, ResourceField } from "./packed.js";
import type { Natives } from "./packed.js";
import { packagePermissionDecision } from "./permission.js";
import { confirmReload } from "./reload.js";
import type { TabHost } from "./tab-host.js";

type Scope = "global" | "project";
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceField[];

interface FlatItem {
	scope: Scope;
	source: string;
	packageName: string;
	field: ResourceField;
	path: string;
	enabled: boolean;
}

export function flatten(groups: PackageResources[], scope: Scope): FlatItem[] {
	const items: FlatItem[] = [];
	for (const group of groups) {
		for (const field of RESOURCE_FIELDS) {
			for (const item of group[field]) items.push({ scope, source: group.source, packageName: group.name, field, path: item.path, enabled: item.enabled });
		}
	}
	return items.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.field.localeCompare(b.field) || a.path.localeCompare(b.path));
}

export function filterItems(items: FlatItem[], query: string): FlatItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter((item) => `${item.packageName} ${item.field} ${item.path}`.toLowerCase().includes(q));
}

export type { FlatItem };

async function approveToggle(
	natives: Pick<Natives, "security">,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
	item: FlatItem,
	nextEnabled: boolean,
): Promise<boolean> {
	const settings = await natives.security();
	if (!packagePermissionDecision(settings, "toggle").approvalRequired) return true;
	if (!ctx.hasUI) return false;
	const reloadNote = item.field === "extensions" ? " This will require a Pi reload (/reload) to take effect." : "";
	return ctx.ui.confirm(
		`${nextEnabled ? "Enable" : "Disable"} ${item.field.slice(0, -1)}`,
		`${item.packageName} \u00b7 ${item.path}.${reloadNote} Continue?`,
	);
}

export type ToggleOutcome = "toggled" | "cancelled" | "failed";

/** Warns inline (in the pre-toggle confirm dialog, not a footer note),
 * requires the same approval every other settings-mutating operation
 * requires, and reports -- never silently assumes -- whether the toggle
 * actually reached the daemon. Extracted from the render loop so this
 * approve-then-mutate decision is directly testable without faking a full
 * ctx.ui.custom interaction. */
export async function applyResourceToggle(item: FlatItem, natives: Pick<Natives, "security" | "toggleResource">, ctx: ExtensionCommandContext): Promise<ToggleOutcome> {
	const nextEnabled = !item.enabled;
	const approved = await approveToggle(natives, ctx, item, nextEnabled);
	if (!approved) { ctx.ui.notify("toggle cancelled", "warning"); return "cancelled"; }
	try {
		await natives.toggleResource(item.source, item.field, item.path, nextEnabled, item.scope === "project" ? ctx.cwd : undefined, true);
		return "toggled";
	} catch (error) {
		ctx.ui.notify(`toggle failed: ${error instanceof Error ? error.message : error}`, "error");
		return "failed";
	}
}

/** `/packed config` dispatch, matching handleSetupCommand's own
 * returns-true-if-handled shape so index.ts can chain both checks.
 * openPanel is injected (rather than importing showPackedPanel from
 * tui.ts directly) to avoid a cycle: tui.ts already imports ConfigTab
 * from this file. */
export async function handleResourceConfigCommand(
	args: string,
	ctx: ExtensionCommandContext,
	natives: Natives,
	openPanel: (ctx: ExtensionCommandContext, natives: Natives, opts?: { initialTab?: "config" }) => Promise<void>,
): Promise<boolean> {
	if (args.trim() !== "config") return false;
	await openPanel(ctx, natives, { initialTab: "config" });
	return true;
}

interface Theme { fg(color: string, s: string): string; bold(s: string): string; }

/** /packed's Config tab -- a real Component, not its own ctx.ui.custom
 * overlay. Each toggle's reload decision (confirmReload) fires
 * immediately after that toggle, the same as Packages' own u/x/d --
 * replacing the old standalone panel's "accumulate pendingReload, ask
 * once when this whole screen finally closes" (there is no "closes"
 * anymore; this tab can stay mounted indefinitely while other tabs are
 * active). */
export class ConfigTab implements Component {
	private data: { global: PackageResources[]; project: PackageResources[] } = { global: [], project: [] };
	private scope: Scope = "global";
	private readonly searchInput = new Input();
	private searchActive = false;
	private items: FlatItem[] = [];
	private filtered: FlatItem[] = [];
	private selectedIndex = 0;
	private busy = false;
	private readonly maxVisible = 20;

	constructor(
		private readonly natives: Pick<Natives, "listResources" | "security" | "toggleResource">,
		private readonly host: TabHost,
		private readonly theme: Theme,
		initialFilter?: string,
	) {
		if (initialFilter) this.searchInput.setValue(initialFilter);
	}

	async load(): Promise<void> {
		try {
			this.data = await this.natives.listResources(this.host.ctx.cwd);
		} catch (error) {
			this.host.ctx.ui.notify(`packed unavailable: ${error instanceof Error ? error.message : error}`, "error");
		}
		this.rebuildItems();
		this.applyFilter(this.searchInput.getValue());
	}

	/** True while an active filter or an in-flight toggle+reload flow means
	 * Escape should clear/wait rather than the host's own "back to Packages"
	 * handling. Config never needs Left/Right for itself (no free-text
	 * cursor movement outside the filter box, which doesn't use them either). */
	capturesEscape(): boolean {
		return this.searchActive || this.busy;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const scopeLabel = theme.bold(this.scope === "project" ? "Project Resources" : "Global Resources");
		const hint = this.searchActive
			? rawKeyHint("esc", "clear")
			: rawKeyHint("space", "toggle") + theme.fg("muted", " \u00b7 ") + rawKeyHint("/", "filter") + theme.fg("muted", " \u00b7 ") + rawKeyHint("tab", "scope") + theme.fg("muted", " \u00b7 ") + rawKeyHint("r", "refresh");
		const spacing = Math.max(1, width - visibleWidth(scopeLabel) - visibleWidth(hint));
		const line1 = truncateToWidth(`${scopeLabel}${" ".repeat(spacing)}${hint}`, width, "");
		const line2 = truncateToWidth(theme.fg("muted", `${this.items.length} resource(s) \u00b7 extensions need a reload after a change`), width, "");
		const lines = [line1, line2];
		if (this.searchActive) lines.push(...this.searchInput.render(width));
		lines.push("");
		if (this.filtered.length === 0) {
			lines.push(theme.fg("muted", "  No resources found"));
			return lines;
		}
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible));
		const end = Math.min(start + this.maxVisible, this.filtered.length);
		for (let index = start; index < end; index++) {
			const item = this.filtered[index]!;
			const isSelected = index === this.selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "\u276f") : " ";
			const box = item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			const reloadMark = item.field === "extensions" ? theme.fg("warning", " \u27f3") : "";
			const label = `${item.packageName} \u00b7 ${item.field} \u00b7 ${item.path}${reloadMark}`;
			lines.push(truncateToWidth(`${cursor} ${box} ${isSelected ? theme.bold(label) : label}`, width, "..."));
		}
		const hasScroll = start > 0 || end < this.filtered.length;
		if (hasScroll) lines.push(theme.fg("dim", `  ${this.selectedIndex + 1}/${this.filtered.length}`));
		return lines;
	}

	handleInput(raw: string): void {
		if (this.busy) return;
		if (this.searchActive) {
			if (raw === "\x1b") { this.searchActive = false; this.searchInput.setValue?.(""); this.applyFilter(); }
			else if (raw === "\r") this.searchActive = false;
			else { this.searchInput.handleInput(raw); this.applyFilter(); }
			this.host.requestRender();
			return;
		}
		switch (raw) {
			case "\x1b[A": this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % Math.max(this.filtered.length, 1); break;
			case "\x1b[B": this.selectedIndex = (this.selectedIndex + 1) % Math.max(this.filtered.length, 1); break;
			case "\t":
				this.scope = this.scope === "global" ? "project" : "global";
				this.rebuildItems();
				this.applyFilter();
				break;
			case "/": this.searchActive = true; break;
			case "r": void this.refresh(); return;
			case " ":
			case "\r": void this.toggleSelected(); return;
			default: return;
		}
		this.host.requestRender();
	}

	setFilter(filter: string): void {
		this.searchInput.setValue(filter);
		this.applyFilter(filter);
	}

	private rebuildItems(): void {
		this.items = flatten(this.scope === "global" ? this.data.global : this.data.project, this.scope);
	}

	private applyFilter(seed?: string): void {
		this.filtered = filterItems(this.items, seed ?? this.searchInput.getValue());
		this.selectedIndex = 0;
	}

	private async refresh(): Promise<void> {
		await this.load();
		this.host.requestRender();
	}

	private async toggleSelected(): Promise<void> {
		const item = this.filtered[this.selectedIndex];
		if (!item) return;
		this.busy = true;
		this.host.requestRender();
		try {
			const outcome = await applyResourceToggle(item, this.natives, this.host.inlineCtx);
			if (outcome !== "toggled") return;
			const group = (item.scope === "global" ? this.data.global : this.data.project).find((candidate) => candidate.source === item.source);
			const entry = group?.[item.field].find((candidate) => candidate.path === item.path);
			if (entry) entry.enabled = !item.enabled;
			if (item.field !== "extensions") return;
			if (await confirmReload(this.host.inlineCtx)) {
				this.host.ctx.ui.notify("Toggled; reloading Pi resources.", "info");
				await this.host.ctx.reload();
				this.host.onSessionReplaced();
			} else {
				this.host.ctx.ui.notify("Extension changes pending -- run /reload when ready.", "warning");
			}
		} finally {
			this.busy = false;
			this.applyFilter();
			this.host.requestRender();
		}
	}
}

export async function createConfigTab(natives: Natives, host: TabHost, theme: Theme, initialFilter?: string): Promise<ConfigTab> {
	const tab = new ConfigTab(natives, host, theme, initialFilter);
	await tab.load();
	return tab;
}
