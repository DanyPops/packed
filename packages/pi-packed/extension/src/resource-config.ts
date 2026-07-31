/**
 * resource-config.ts — /packed config overlay: enable/disable individual
 * extensions, skills, prompt templates, and themes declared by installed
 * Pi packages, matching pi's own `pi config` interaction model (group by
 * package, toggle with space/enter, Tab to switch global/project scope).
 * Pi's own settings mutation lives in its internal SettingsManager, which
 * extensions cannot reach -- this reads and writes the same documented
 * settings.json filter arrays (docs/packages.md, "Enable and Disable
 * Resources") entirely through Packed's authenticated daemon.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PackageResources, ResourceField } from "./packed.js";
import type { Natives } from "./packed.js";
import { packagePermissionDecision } from "./permission.js";

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

interface PanelAction {
	type: "toggle" | "switch" | "refresh" | "close";
	item?: FlatItem;
}

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
 * returns-true-if-handled shape so index.ts can chain both checks. */
export async function handleResourceConfigCommand(args: string, ctx: ExtensionCommandContext, natives: Natives): Promise<boolean> {
	if (args.trim() !== "config") return false;
	await showResourceConfig(ctx, natives);
	return true;
}

export async function showResourceConfig(ctx: ExtensionCommandContext, natives: Natives, initialFilter?: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed config requires interactive mode", "warning");
		return;
	}
	let data: { global: PackageResources[]; project: PackageResources[] };
	try { data = await natives.listResources(ctx.cwd); }
	catch (error) {
		ctx.ui.notify(`packed unavailable: ${error instanceof Error ? error.message : error}`, "error");
		return;
	}

	let scope: Scope = "global";
	let pendingReload = false;
	let filter = initialFilter ?? "";

	for (;;) {
		const action = await renderConfig(ctx, data, scope, filter);
		filter = ""; // only seeds the very first open -- a later refresh/switch starts unfiltered
		if (action.type === "close") break;
		if (action.type === "switch") { scope = scope === "global" ? "project" : "global"; continue; }
		if (action.type === "refresh") {
			try { data = await natives.listResources(ctx.cwd); }
			catch (error) { ctx.ui.notify(`refresh failed: ${error instanceof Error ? error.message : error}`, "error"); }
			continue;
		}
		const item = action.item;
		if (!item) continue;
		const outcome = await applyResourceToggle(item, natives, ctx);
		if (outcome !== "toggled") continue;
		const group = (item.scope === "global" ? data.global : data.project).find((candidate) => candidate.source === item.source);
		const entry = group?.[item.field].find((candidate) => candidate.path === item.path);
		if (entry) entry.enabled = !item.enabled;
		if (item.field === "extensions") pendingReload = true;
	}

	if (!pendingReload) return;
	const confirmed = await ctx.ui.confirm("Reload Pi now?", "Extension changes only take effect after a reload.");
	if (confirmed) await ctx.reload();
	else ctx.ui.notify("Extension changes pending -- run /reload when ready.", "warning");
}

function renderConfig(ctx: ExtensionCommandContext, data: { global: PackageResources[]; project: PackageResources[] }, scope: Scope, initialFilter = ""): Promise<PanelAction> {
	return ctx.ui.custom<PanelAction>((tui, theme, _kb, done) => {
		const searchInput = new Input();
		if (initialFilter) searchInput.setValue(initialFilter);
		let searchActive = false;
		const items = flatten(scope === "global" ? data.global : data.project, scope);
		let filtered = initialFilter ? filterItems(items, initialFilter) : items;
		let selectedIndex = 0;
		const maxVisible = 20;

		function applyFilter(): void {
			filtered = filterItems(items, searchInput.getValue());
			selectedIndex = 0;
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold(scope === "project" ? "Project Resources" : "Global Resources");
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: rawKeyHint("space", "toggle") + theme.fg("muted", " \u00b7 ") + rawKeyHint("/", "filter") + theme.fg("muted", " \u00b7 ") + rawKeyHint("tab", "scope") + theme.fg("muted", " \u00b7 ") + rawKeyHint("esc", "close");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, "");
				const line2 = truncateToWidth(theme.fg("muted", `${items.length} resource(s) \u00b7 extensions need /reload after a change`), width, "");
				return [line1, line2];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				if (searchActive) lines.push(...searchInput.render(width));
				lines.push("");
				if (filtered.length === 0) { lines.push(theme.fg("muted", "  No resources found")); return lines; }
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				for (let index = start; index < end; index++) {
					const item = filtered[index]!;
					const isSelected = index === selectedIndex;
					const cursor = isSelected ? theme.fg("accent", "\u276f") : " ";
					const box = item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					const reloadMark = item.field === "extensions" ? theme.fg("warning", " \u27f3") : "";
					const label = `${item.packageName} \u00b7 ${item.field} \u00b7 ${item.path}${reloadMark}`;
					lines.push(truncateToWidth(`${cursor} ${box} ${isSelected ? theme.bold(label) : label}`, width, "..."));
				}
				const hasScroll = start > 0 || end < filtered.length;
				if (hasScroll) lines.push(theme.fg("dim", `  ${selectedIndex + 1}/${filtered.length}`));
				return lines;
			},
		};

		const border = () => new DynamicBorder((s) => theme.fg("border", s));
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(header);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(border());

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(raw: string) {
				if (searchActive) {
					if (raw === "\x1b") { searchActive = false; searchInput.setValue?.(""); applyFilter(); }
					else if (raw === "\r") searchActive = false;
					else { searchInput.handleInput(raw); applyFilter(); }
					tui.requestRender();
					return;
				}
				switch (raw) {
					case "\x1b[A": selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1); break;
					case "\x1b[B": selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1); break;
					case "\t": done({ type: "switch" }); return;
					case "/": searchActive = true; break;
					case "r": done({ type: "refresh" }); return;
					case " ":
					case "\r": {
						const item = filtered[selectedIndex];
						if (item) done({ type: "toggle", item });
						return;
					}
					case "\x1b": done({ type: "close" }); return;
					default: return;
				}
				tui.requestRender();
			},
		};
	});
}
