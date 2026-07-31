/**
 * tui.ts — /packed's default panel. Mnemonics follow lazy.nvim's own
 * convention (folke/lazy.nvim lua/lazy/view/config.lua): uppercase acts on
 * every row, lowercase acts on the row under the cursor -- U/u update,
 * X/x was lazy's delete key (clean); here that pairing is single-target
 * only (x remove -- there is no safe "remove every installed package"
 * bulk analog, so no X is bound). Adds d disable/enable this package's
 * extensions, c jump to full resource config, f find/install new
 * packages, s settings. Enter opens a floating (`ctx.ui.custom` with
 * overlay:true) action menu instead of a full-screen prompt, so the list
 * underneath never disappears. All data flows through the packed CLI
 * (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Menu, type MenuItem } from "malevich-tui-components";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives, PackageResources } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { showPackedSettings } from "./security-tui.js";
import { showResourceConfig, applyResourceToggle } from "./resource-config.js";
import { showDiscoverPanel } from "./discover.js";
import { menuTheme } from "./menu-theme.js";

interface PanelAction {
	type: "update" | "updateAll" | "remove" | "disable" | "config" | "find" | "refresh" | "settings";
	row?: Row;
}

/** Outcome of a confirmed row action, resolved after any real mutation and
 * reload decision -- "changed" means the daemon state changed and Pi has
 * already been reloaded (the caller should stop showing the stale panel);
 * "unchanged"/"cancelled" mean the panel keeps running as-is. */
export type PackageChoiceOutcome = "changed" | "unchanged" | "cancelled";

export async function applyPackageChoice(
	choice: string | undefined,
	row: Row,
	natives: Natives,
	ctx: ExtensionCommandContext,
): Promise<PackageChoiceOutcome> {
	if (choice?.startsWith("Update")) {
		try {
			const approval = await approvePackageOperation("update", `pi update --extension npm:${row.name}`, natives, ctx);
			if (!approval.allowed) {
				ctx.ui.notify(approval.message ?? "update denied", "warning");
				return "cancelled";
			}
			ctx.ui.notify(`Updating ${row.name}…`, "info");
			const outcome = await natives.update(`npm:${row.name}`, approval.approved);
			if (!outcome.reloadRequired) {
				const version = outcome.currentVersion ?? outcome.previousVersion;
				const reason = outcome.pinned
					? `pinned to ${version ?? "an exact version"} -- pi update intentionally leaves pinned packages unchanged`
					: `already up to date${version ? ` at ${version}` : ""}`;
				ctx.ui.notify(`${row.name} is ${reason}.`, "info");
				return "unchanged";
			}
			const transition = outcome.previousVersion && outcome.currentVersion ? ` (${outcome.previousVersion} → ${outcome.currentVersion})` : "";
			ctx.ui.notify(`Updated ${row.name}${transition}; reloading Pi resources.`, "info");
			await ctx.reload();
			return "changed";
		} catch (e) {
			ctx.ui.notify(`update failed: ${e instanceof Error ? e.message : e}`, "error");
			return "cancelled";
		}
	}
	if (choice === "Remove") {
		try {
			const approval = await approvePackageOperation("remove", `pi remove npm:${row.name}`, natives, ctx);
			if (!approval.allowed) {
				ctx.ui.notify(approval.message ?? "remove denied", "warning");
				return "cancelled";
			}
			await natives.remove(row.name, approval.approved);
			ctx.ui.notify(`Removed ${row.name}; reloading Pi resources.`, "info");
			await ctx.reload();
			return "changed";
		} catch (e) {
			ctx.ui.notify(`remove failed: ${e instanceof Error ? e.message : e}`, "error");
			return "cancelled";
		}
	}
	return "cancelled";
}

/** U -- update every outdated row with one combined approval and one
 * reload, instead of applyPackageChoice's own per-call reload (which
 * would end the session after the first successful update). */
export async function applyUpdateAll(rows: Row[], natives: Natives, ctx: ExtensionCommandContext): Promise<PackageChoiceOutcome> {
	const outdated = rows.filter((row) => row.hasUpdate);
	if (outdated.length === 0) {
		ctx.ui.notify("Nothing to update.", "info");
		return "unchanged";
	}
	const approval = await approvePackageOperation(
		"update",
		`pi update --extension ${outdated.map((row) => `npm:${row.name}`).join(" ")}`,
		natives,
		ctx,
	);
	if (!approval.allowed) {
		ctx.ui.notify(approval.message ?? "update denied", "warning");
		return "cancelled";
	}
	ctx.ui.notify(`Updating ${outdated.length} package(s)…`, "info");
	let changed = 0;
	let failed = 0;
	for (const row of outdated) {
		try {
			const outcome = await natives.update(`npm:${row.name}`, approval.approved);
			if (outcome.reloadRequired) changed += 1;
		} catch (e) {
			failed += 1;
			ctx.ui.notify(`${row.name} update failed: ${e instanceof Error ? e.message : e}`, "error");
		}
	}
	if (changed === 0) {
		ctx.ui.notify(failed > 0 ? `No packages updated; ${failed} failed.` : "All packages already up to date.", failed > 0 ? "warning" : "info");
		return failed > 0 ? "cancelled" : "unchanged";
	}
	ctx.ui.notify(`Updated ${changed} package(s)${failed > 0 ? `, ${failed} failed` : ""}; reloading Pi resources.`, "info");
	await ctx.reload();
	return "changed";
}

/** d -- toggles every declared extension of this package on or off in one
 * step (disables if any are enabled, otherwise re-enables all). Reuses
 * applyResourceToggle per item for its own tested approval/mutation path
 * rather than a bespoke bulk mutation -- the common case is one extension
 * per package, so this rarely shows more than a single confirm. */
export async function applyDisableExtensions(row: Row, natives: Natives, ctx: ExtensionCommandContext): Promise<PackageChoiceOutcome> {
	let data: { global: PackageResources[]; project: PackageResources[] };
	try {
		data = await natives.listResources();
	} catch (e) {
		ctx.ui.notify(`packed unavailable: ${e instanceof Error ? e.message : e}`, "error");
		return "cancelled";
	}
	const group = data.global.find((candidate) => candidate.name === row.name);
	const extensions = group?.extensions ?? [];
	if (!group || extensions.length === 0) {
		ctx.ui.notify(`${row.name} declares no extensions to disable.`, "info");
		return "unchanged";
	}
	const disabling = extensions.some((item) => item.enabled);
	const targets = extensions.filter((item) => item.enabled === disabling);
	let toggled = 0;
	for (const item of targets) {
		const outcome = await applyResourceToggle(
			{ scope: "global", source: group.source, packageName: group.name, field: "extensions", path: item.path, enabled: item.enabled },
			natives,
			ctx,
		);
		if (outcome === "toggled") toggled += 1;
		else if (outcome === "cancelled") return toggled > 0 ? "changed" : "cancelled";
	}
	if (toggled === 0) return "unchanged";
	ctx.ui.notify(`${disabling ? "Disabled" : "Enabled"} ${toggled} extension(s) for ${row.name}; reloading Pi resources.`, "info");
	await ctx.reload();
	return "changed";
}

async function loadRows(natives: Natives): Promise<{ rows: Row[]; error?: string }> {
	try {
		const [installed, updates] = await Promise.all([
			natives.installed(),
			natives.updates().catch(() => []),
		]);
		return { rows: mergeRows(installed, updates) };
	} catch (e) {
		return { rows: [], error: e instanceof Error ? e.message : String(e) };
	}
}

/** Enter's action menu, floated on top of the still-open packages panel
 * via ctx.ui.custom's own overlay:true -- no full-screen teardown, unlike
 * the ctx.ui.select this replaced. */
async function showActionMenu(ctx: ExtensionCommandContext, row: Row): Promise<"update" | "remove" | "disable" | "config" | undefined> {
	type Choice = "update" | "remove" | "disable" | "config";
	return ctx.ui.custom<Choice | undefined>(
		(_tui, theme, _kb, done) => {
			const items: MenuItem[] = [
				...(row.hasUpdate ? [{ label: `Update to ${row.latest}`, action: () => done("update" as Choice) }] : []),
				{ label: "Disable/enable extensions", action: () => done("disable") },
				{ label: "Configure resources", action: () => done("config") },
				{ label: "Remove", action: () => done("remove") },
			];
			return new Menu({ items, theme: menuTheme(theme), onClose: () => done(undefined) });
		},
		{ overlay: true, overlayOptions: { width: 40, anchor: "center" } },
	);
}

export async function showPackedPanel(ctx: ExtensionCommandContext, natives: Natives): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed requires interactive mode", "warning");
		return;
	}

	let { rows, error } = await loadRows(natives);
	if (error) {
		ctx.ui.notify(`packed unavailable: ${error}`, "error");
		return;
	}

	// Panel loop: actions resolve the component, run outside it, then reopen.
	for (;;) {
		const action = await renderPanel(ctx, rows);
		if (!action) return; // closed

		if (action.type === "refresh") {
			({ rows, error } = await loadRows(natives));
			if (error) ctx.ui.notify(`refresh failed: ${error}`, "error");
			continue;
		}

		if (action.type === "settings") {
			await showPackedSettings(ctx, natives);
			continue; // settings never changes package rows -- reopen as-is
		}

		if (action.type === "find") {
			await showDiscoverPanel(ctx, natives);
			continue; // a successful install already reloaded; a no-op returns here
		}

		if (action.type === "updateAll") {
			const outcome = await applyUpdateAll(rows, natives, ctx);
			if (outcome === "changed") return; // ctx.reload() already replaced the session
			continue;
		}

		if (action.type === "config") {
			await showResourceConfig(ctx, natives, action.row?.name);
			continue; // showResourceConfig already handles its own reload prompt
		}

		const row = action.row;
		if (!row) continue;

		if (action.type === "disable") {
			const outcome = await applyDisableExtensions(row, natives, ctx);
			if (outcome === "changed") return;
			continue;
		}

		const outcome = await applyPackageChoice(action.type === "update" ? `Update to ${row.latest}` : "Remove", row, natives, ctx);
		if (outcome === "changed") return; // ctx.reload() already replaced the session
	}
}

function renderPanel(ctx: ExtensionCommandContext, rows: Row[]): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		let mode: ViewMode = "all";
		const searchInput = new Input();
		let searchActive = false;
		let filtered = visibleRows(rows, mode);
		let selectedIndex = 0;

		const maxVisible = 20;

		function applyFilter(): void {
			filtered = filterRows(visibleRows(rows, mode), searchInput.getValue());
			selectedIndex = 0;
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold("Packages");
				const outdated = rows.filter((r) => r.hasUpdate).length;
				const badge = outdated > 0 ? theme.fg("warning", ` ${outdated} update(s)`) : "";
				const hint = searchActive
					? rawKeyHint("esc", "clear")
					: rawKeyHint("enter", "menu") +
						theme.fg("muted", " · ") +
						rawKeyHint("u/U", "update/all") +
						theme.fg("muted", " · ") +
						rawKeyHint("x", "remove") +
						theme.fg("muted", " · ") +
						rawKeyHint("d", "disable") +
						theme.fg("muted", " · ") +
						rawKeyHint("c", "config") +
						theme.fg("muted", " · ") +
						rawKeyHint("f", "find") +
						theme.fg("muted", " · ") +
						rawKeyHint("s", "settings") +
						theme.fg("muted", " · ") +
						rawKeyHint("esc", "close");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(badge) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${badge}${" ".repeat(spacing)}${hint}`, width, "");
				const dot = "·";
				const line2 = truncateToWidth(
					theme.fg("muted", `view: ${mode} ${dot} / filter ${dot} tab view ${dot} r refresh ${dot} ${rows.length} installed`),
					width,
					"",
				);
				return [line1, line2];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				if (searchActive) lines.push(...searchInput.render(width));
				lines.push("");
				if (filtered.length === 0) {
					lines.push(theme.fg("muted", "  No packages"));
					return lines;
				}
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				for (let i = start; i < end; i++) {
					const row = filtered[i]!;
					const selected = i === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					const name = selected ? theme.bold(row.name) : row.name;
					const ver = theme.fg("dim", `@${row.version}`);
					const upd = row.hasUpdate ? theme.fg("warning", ` ↑${row.latest}`) : "";
					lines.push(truncateToWidth(`${cursor} ${name}${ver}${upd}`, width, ""));
				}
				const hasScroll = start > 0 || end < filtered.length;
				lines.push(theme.fg("dim", `  ${hasScroll ? `${selectedIndex + 1}/${filtered.length} ` : ""}${mode}`));
				return lines;
			},
		};

		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());
		container.addChild(new Spacer(1));
		container.addChild(header);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (searchActive) {
					if (data === "\x1b") {
						searchActive = false;
						searchInput.setValue?.("");
						applyFilter();
					} else if (data === "\r") {
						searchActive = false;
					} else {
						searchInput.handleInput(data);
						applyFilter();
					}
					tui.requestRender();
					return;
				}

				switch (data) {
					case "\x1b[A": // up
						selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1);
						break;
					case "\x1b[B": // down
						selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
						break;
					case "\t":
						mode = nextMode(mode);
						applyFilter();
						break;
					case "/":
						searchActive = true;
						break;
					case "r":
						done({ type: "refresh" });
						return;
					case "s":
						done({ type: "settings" });
						return;
					case "f":
						done({ type: "find" });
						return;
					case "U":
						done({ type: "updateAll" });
						return;
					case "u": {
						const row = filtered[selectedIndex];
						if (row?.hasUpdate) done({ type: "update", row });
						return;
					}
					case "x": {
						const row = filtered[selectedIndex];
						if (row) done({ type: "remove", row });
						return;
					}
					case "d": {
						const row = filtered[selectedIndex];
						if (row) done({ type: "disable", row });
						return;
					}
					case "c": {
						const row = filtered[selectedIndex];
						if (row) done({ type: "config", row });
						return;
					}
					case "\r": {
						const row = filtered[selectedIndex];
						if (!row) return;
						void (async () => {
							const choice = await showActionMenu(ctx, row);
							if (choice === "update") done({ type: "update", row });
							else if (choice === "remove") done({ type: "remove", row });
							else if (choice === "disable") done({ type: "disable", row });
							else if (choice === "config") done({ type: "config", row });
						})();
						return;
					}
					case "\x1b":
						done(undefined);
						return;
					default:
						return;
				}
				tui.requestRender();
			},
		};
	});
}
