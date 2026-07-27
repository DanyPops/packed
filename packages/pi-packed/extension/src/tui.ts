/**
 * tui.ts — /packages interactive panel. Follows the pi-extension-manager
 * idiom: ctx.ui.custom with Container/DynamicBorder layout, header hints,
 * type-to-filter (/), Tab view modes, Enter → actions, r refresh, esc close.
 * All data flows through the packed CLI (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives } from "./packed.js";
import { approvePackageOperation } from "./tools.js";

interface PanelAction {
	type: "menu" | "refresh";
	row?: Row;
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

export async function showPackages(ctx: ExtensionCommandContext, natives: Natives): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packages requires interactive mode", "warning");
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

		const row = action.row;
		if (!row) continue;

		const choice = await ctx.ui.select(
			`${row.name}@${row.version}${row.hasUpdate ? `  →  ${row.latest}` : ""}`,
			[
				...(row.hasUpdate ? [`Update to ${row.latest}`] : []),
				"Remove",
				"Cancel",
			],
		);

		if (choice?.startsWith("Update")) {
			try {
				const approval = await approvePackageOperation("update", `pi update --extension npm:${row.name}`, natives, ctx);
				if (!approval.allowed) {
					ctx.ui.notify(approval.message ?? "update denied", "warning");
					continue;
				}
				ctx.ui.notify(`Updating ${row.name}…`, "info");
				await natives.update(`npm:${row.name}`, approval.approved);
				ctx.ui.notify(`Updated ${row.name} to ${row.latest}; reloading Pi resources`, "info");
				await ctx.reload();
				return;
			} catch (e) {
				ctx.ui.notify(`update failed: ${e instanceof Error ? e.message : e}`, "error");
			}
		} else if (choice === "Remove") {
			try {
				const approval = await approvePackageOperation("remove", `pi remove npm:${row.name}`, natives, ctx);
				if (approval.allowed) {
					await natives.remove(row.name, approval.approved);
					ctx.ui.notify(`Removed ${row.name}`, "info");
					rows = rows.filter((r) => r.name !== row.name);
				} else {
					ctx.ui.notify(approval.message ?? "remove denied", "warning");
				}
			} catch (e) {
				ctx.ui.notify(`remove failed: ${e instanceof Error ? e.message : e}`, "error");
			}
		}
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
					: rawKeyHint("enter", "actions") +
						theme.fg("muted", " · ") +
						rawKeyHint("/", "filter") +
						theme.fg("muted", " · ") +
						rawKeyHint("tab", "view") +
						theme.fg("muted", " · ") +
						rawKeyHint("esc", "close");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(badge) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${badge}${" ".repeat(spacing)}${hint}`, width, "");
				const dot = "·";
				const line2 = truncateToWidth(
					theme.fg("muted", `view: ${mode} ${dot} r refresh ${dot} ${rows.length} installed`),
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
					case "\r": {
						const row = filtered[selectedIndex];
						if (row) done({ type: "menu", row });
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
