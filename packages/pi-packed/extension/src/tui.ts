/**
 * tui.ts — /packed's default panel. Follows the pi-extension-manager idiom:
 * ctx.ui.custom with Container/DynamicBorder layout, header hints,
 * type-to-filter (/), Tab view modes, Enter → actions, r refresh, s
 * settings, esc close. Packages is the landing page; s opens settings
 * (mutation approval) as a sub-flow and returns to the same panel
 * afterward, rather than a second rendered page. All data flows through
 * the packed CLI (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { showPackedSettings } from "./security-tui.js";

interface PanelAction {
	type: "menu" | "refresh" | "settings";
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

		const outcome = await applyPackageChoice(choice, row, natives, ctx);
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
					: rawKeyHint("enter", "actions") +
						theme.fg("muted", " · ") +
						rawKeyHint("/", "filter") +
						theme.fg("muted", " · ") +
						rawKeyHint("tab", "view") +
						theme.fg("muted", " · ") +
						rawKeyHint("s", "settings") +
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
					case "s":
						done({ type: "settings" });
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
