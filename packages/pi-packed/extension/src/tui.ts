/**
 * tui.ts — /packed's default panel. Mnemonics follow lazy.nvim's own
 * convention (folke/lazy.nvim lua/lazy/view/config.lua): uppercase acts on
 * every row, lowercase acts on the row under the cursor -- U/u update,
 * X/x was lazy's delete key (clean); here that pairing is single-target
 * only (x remove -- there is no safe "remove every installed package"
 * bulk analog, so no X is bound). Adds d disable/enable this package's
 * extensions, c jump to full resource config, f find/install new
 * packages, s settings. The panel itself is a real bordered (rounded)
 * floating overlay (`ctx.ui.custom` with overlay:true, Malevich's
 * Envelope for the box), anchored to the top so its header stays put and
 * only the footer moves as content height changes. Enter opens a second,
 * smaller overlay action menu on top of it. U's batch update stays on
 * this same package list -- progress renders inline next to the row
 * currently being updated, not as a separate screen. Rows render through
 * Malevich's Table (real column-aligned Package/Version/status cells,
 * per-row selection styling baked into each cell since Table's own
 * cellStyle is column-wide, not row-wide) inside this panel's own
 * scroll-window slice -- Table deliberately owns no pagination of its
 * own, so the visible-window-around-selectedIndex math stays here. All
 * data flows through the packed CLI (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Envelope, Menu, ProgressBar, Table, type MenuItem, type TableColumn, type TextMeasure } from "malevich-tui-components";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives, PackageResources } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { showPackedSettings } from "./security-tui.js";
import { showResourceConfig, applyResourceToggle } from "./resource-config.js";
import { showDiscoverPanel } from "./discover.js";
import { menuTheme } from "./menu-theme.js";

interface PanelAction {
	type: "update" | "remove" | "disable" | "config" | "find" | "refresh" | "settings";
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

interface UpdateAllResult { changed: number; failedNames: string[]; }

interface UpdateProgressEvent { row: Row; index: number; total: number; phase: "start" | "done"; }

/** The core sequential-update loop, with no UI of its own -- reports each
 * step via onProgress so any host surface (a floating overlay, or the
 * packages panel's own body) can render it however fits. */
async function performUpdateAll(
	outdated: Row[],
	natives: Natives,
	approved: boolean | undefined,
	onProgress?: (event: UpdateProgressEvent) => void,
): Promise<UpdateAllResult> {
	let changed = 0;
	const failedNames: string[] = [];
	for (let i = 0; i < outdated.length; i++) {
		const row = outdated[i]!;
		onProgress?.({ row, index: i, total: outdated.length, phase: "start" });
		try {
			const outcome = await natives.update(`npm:${row.name}`, approved);
			if (outcome.reloadRequired) changed += 1;
		} catch (e) {
			failedNames.push(`${row.name}: ${e instanceof Error ? e.message : e}`);
		}
		onProgress?.({ row, index: i, total: outdated.length, phase: "done" });
	}
	return { changed, failedNames };
}

/** Approves once for the whole batch, runs it via whatever runBatch does
 * (a floating overlay for applyUpdateAll's own public API, or renderPanel's
 * embedded progress bar), then reports the combined result -- shared so
 * both surfaces stay behaviorally identical. */
async function approveAndRunUpdateAll(
	outdated: Row[],
	natives: Natives,
	ctx: ExtensionCommandContext,
	runBatch: (outdated: Row[], approved: boolean | undefined) => Promise<UpdateAllResult>,
): Promise<PackageChoiceOutcome> {
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
	const { changed, failedNames } = await runBatch(outdated, approval.approved);
	for (const failure of failedNames) ctx.ui.notify(`update failed: ${failure}`, "error");
	if (changed === 0) {
		ctx.ui.notify(failedNames.length > 0 ? `No packages updated; ${failedNames.length} failed.` : "All packages already up to date.", failedNames.length > 0 ? "warning" : "info");
		return failedNames.length > 0 ? "cancelled" : "unchanged";
	}
	ctx.ui.notify(`Updated ${changed} package(s)${failedNames.length > 0 ? `, ${failedNames.length} failed` : ""}; reloading Pi resources.`, "info");
	await ctx.reload();
	return "changed";
}

/** Floats its own progress-bar overlay over the still-open panel -- kept
 * for applyUpdateAll's own public API (and anything calling it directly,
 * outside the packages panel). renderPanel's own U key does not use this;
 * it renders the same progress bar inline on its own already-open overlay
 * instead of stacking a second one. */
async function runUpdatesWithProgress(
	outdated: Row[],
	natives: Natives,
	approved: boolean | undefined,
	ctx: ExtensionCommandContext,
): Promise<UpdateAllResult> {
	return ctx.ui.custom<UpdateAllResult>(
		(tui, theme, _kb, done) => {
			const bar = new ProgressBar({ value: 0, max: outdated.length, label: `${outdated[0]?.name ?? ""} (1/${outdated.length})`, style: (s) => theme.fg("accent", s) });
			const border = () => new DynamicBorder((s) => theme.fg("border", s));
			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(border());
			container.addChild({ invalidate() {}, render: (_width: number) => [theme.bold("Updating packages")] });
			container.addChild(new Spacer(1));
			container.addChild(bar);
			container.addChild(new Spacer(1));
			container.addChild(border());

			performUpdateAll(outdated, natives, approved, (event) => {
				bar.setLabel(`${event.row.name} (${event.index + 1}/${event.total})`);
				if (event.phase === "done") bar.setValue(event.index + 1);
				tui.requestRender();
			}).then(done);

			return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput() {} };
		},
		{ overlay: true, overlayOptions: { width: 50, anchor: "center" } },
	);
}

/** U -- update every outdated row with one combined approval and one
 * reload, instead of applyPackageChoice's own per-call reload (which
 * would end the session after the first successful update). Public API:
 * opens its own progress overlay. renderPanel's own U key instead renders
 * progress inline via approveAndRunUpdateAll + performUpdateAll directly. */
export async function applyUpdateAll(rows: Row[], natives: Natives, ctx: ExtensionCommandContext): Promise<PackageChoiceOutcome> {
	const outdated = rows.filter((row) => row.hasUpdate);
	return approveAndRunUpdateAll(outdated, natives, ctx, (batch, approved) => runUpdatesWithProgress(batch, natives, approved, ctx));
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
	// U/updateAll is handled entirely inside renderPanel itself (progress
	// rendered on the same already-open overlay) and never reaches here.
	for (;;) {
		const action = await renderPanel(ctx, natives, rows);
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

function renderPanel(ctx: ExtensionCommandContext, natives: Natives, initialRows: Row[]): Promise<PanelAction | undefined> {
	return ctx.ui.custom<PanelAction | undefined>((tui, theme, _kb, done) => {
		let rows = initialRows;
		let mode: ViewMode = "all";
		const searchInput = new Input();
		let searchActive = false;
		let filtered = visibleRows(rows, mode);
		let selectedIndex = 0;
		// Set only while U's batch update is running. The list stays fully
		// visible throughout -- this just names which row the shared bar
		// (below) is currently sitting next to.
		let updatingRowName: string | undefined;
		const updatingBar = new ProgressBar({ value: 0, max: 1, width: 10, style: (s) => theme.fg("accent", s) });

		const maxVisible = 20;

		function applyFilter(): void {
			filtered = filterRows(visibleRows(rows, mode), searchInput.getValue());
			selectedIndex = 0;
		}

		/** U -- runs the whole approve+update+notify+reload flow without ever
		 * closing this panel or replacing the list: each step's progress
		 * appears inline next to the row currently being updated, via
		 * updatingRowName/updatingBar, which list's own render checks. Rows
		 * refresh in place afterward unless a reload already ended the
		 * session. */
		async function runUpdateAllInline(): Promise<void> {
			const outdated = rows.filter((row) => row.hasUpdate);
			const outcome = await approveAndRunUpdateAll(outdated, natives, ctx, (batch, approved) => {
				updatingBar.setValue(0);
				updatingBar.setMax(batch.length);
				return performUpdateAll(batch, natives, approved, (event) => {
					updatingRowName = event.row.name;
					if (event.phase === "done") updatingBar.setValue(event.index + 1);
					tui.requestRender();
				});
			});
			updatingRowName = undefined;
			if (outcome === "changed") {
				done(undefined); // ctx.reload() already replaced the session
				return;
			}
			const reloaded = await loadRows(natives);
			if (reloaded.error) ctx.ui.notify(`refresh failed: ${reloaded.error}`, "error");
			else rows = reloaded.rows;
			applyFilter();
			tui.requestRender();
		}

		function panelTitle(): string {
			if (updatingRowName) return "Packages · updating…";
			const outdated = rows.filter((r) => r.hasUpdate).length;
			return outdated > 0 ? `Packages · ${outdated} update(s)` : "Packages";
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
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
				const line1 = truncateToWidth(hint, width, "");
				const dot = "·";
				const line2 = truncateToWidth(
					theme.fg("muted", `view: ${mode} ${dot} / filter ${dot} tab view ${dot} r refresh ${dot} ${rows.length} installed`),
					width,
					"",
				);
				return [line1, line2];
			},
		};

		// pi-tui's own visibleWidth/truncateToWidth are ANSI-aware (they strip
		// escape codes for measurement, matching the pair Malevich's TextMeasure
		// port expects) -- rows below bake selection/status styling directly
		// into each cell's text since Table's own cellStyle is column-wide, not
		// per-row.
		const measure: TextMeasure = { visibleWidth, truncateToWidth };
		const columns: TableColumn[] = [
			{ header: "Package", key: "name" },
			{ header: "Version", key: "version" },
			{ header: "", key: "status" },
		];
		const table = new Table({ columns, rows: [], measure, headerStyle: (s) => theme.fg("muted", s) });

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
				// No scrolling of its own (Malevich's Table is deliberately
				// unopinionated about pagination) -- the visible window around
				// selectedIndex stays this panel's own job, same as before.
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
				const end = Math.min(start + maxVisible, filtered.length);
				table.setRows(
					filtered.slice(start, end).map((row, offset) => {
						const i = start + offset;
						const selected = i === selectedIndex;
						const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
						const name = selected ? theme.bold(row.name) : row.name;
						const isUpdating = updatingRowName === row.name;
						const status = isUpdating
							? theme.fg("accent", `${updatingBar.format(10)} updating…`)
							: row.hasUpdate ? theme.fg("warning", `↑${row.latest}`) : "";
						return { name: `${cursor}${name}`, version: theme.fg("dim", row.version), status };
					}),
				);
				lines.push(...table.render(width));
				const hasScroll = start > 0 || end < filtered.length;
				lines.push(theme.fg("dim", `  ${hasScroll ? `${selectedIndex + 1}/${filtered.length} ` : ""}${mode}`));
				return lines;
			},
		};

		// Real bordered box (rounded corners), not just a horizontal rule --
		// title carries the live update badge/status instead of a header line.
		const envelope = new Envelope({
			title: panelTitle(),
			borderStyle: "rounded",
			style: (s) => theme.fg("border", s),
			titleStyle: (s) => theme.bold(theme.fg("accent", s)),
		});
		const body = {
			invalidate() { header.invalidate(); list.invalidate(); },
			render(width: number): string[] {
				return [...header.render(width), "", ...list.render(width)];
			},
		};
		envelope.setContent(body);

		return {
			render(width: number): string[] {
				envelope.setTitle(panelTitle());
				return envelope.render(width);
			},
			invalidate: () => envelope.invalidate(),
			handleInput(data: string) {
				if (updatingRowName) return; // the installer owns input until it finishes

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
						void runUpdateAllInline();
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
	}, { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "top-center", offsetY: 1 } });
}
