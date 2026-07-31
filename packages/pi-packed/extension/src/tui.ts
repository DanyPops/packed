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
 * Envelope for the box), positioned at 40% of terminal height (pi-tui's
 * own row percentage, not a fixed row count -- scales with the real
 * terminal, unlike the anchor:"top-center"+offsetY this replaced, which
 * was pinned 1 row below the absolute top on any terminal size). Enter
 * opens a second, smaller overlay action menu on top of it. U's batch
 * update stays on this same package list -- an indeterminate spinner
 * (Malevich's Spinner, extracted upstream from this panel's original need
 * once no embeddable one existed anywhere) renders inline next to the row
 * currently updating, settling into a real ✓/✗ plus a bounded tail of
 * that row's own actual captured stdout/stderr once it finishes, never a
 * determinate bar (a single subprocess call has no knowable percentage).
 * Rows render through Malevich's Table (real column-aligned
 * Package/Version/status cells, per-row selection styling baked into each
 * cell since Table's own cellStyle is column-wide, not row-wide) inside
 * this panel's own scroll-window slice -- Table deliberately owns no
 * pagination of its own, so the visible-window-around-selectedIndex math
 * stays here. u/x/d and the Enter action menu all run their whole
 * approve+mutate+confirmReload flow inline, without ever closing this
 * overlay first -- every confirm() along the way (mutation approval,
 * confirmReload's separate reload gate) renders as a real Malevich Dialog
 * on this SAME overlay, dispatched by literal y/n keys, instead of
 * ctx.ui.confirm's own separate native dialog (arrow-select only, and a
 * genuinely different overlay stacked on top -- confirmed live as a real
 * user complaint). Declining a reload defers it: the mutation itself
 * already happened, and the panel stays open with refreshed rows instead
 * of ending the session. All data flows through the packed CLI (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Dialog, Envelope, Menu, Spinner, Table, type MenuItem, type TableColumn, type TextMeasure } from "malevich-tui-components";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives, PackageResources } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { showPackedSettings } from "./security-tui.js";
import { showResourceConfig, applyResourceToggle } from "./resource-config.js";
import { showDiscoverPanel } from "./discover.js";
import { dialogTheme, menuTheme } from "./menu-theme.js";
import { confirmReload } from "./reload.js";

interface PanelAction {
	type: "config" | "find" | "refresh" | "settings";
	row?: Row;
}

/** Outcome of a confirmed row action, resolved after any real mutation and
 * reload decision -- "changed" means the daemon state changed and Pi has
 * already been reloaded (the caller should stop showing the stale panel);
 * "deferred" means the mutation itself genuinely happened but the user
 * declined confirmReload's separate reload gate -- Pi's session is still
 * alive and the panel should refresh its rows and keep running, not close;
 * "unchanged"/"cancelled" mean the panel keeps running as-is. */
export type PackageChoiceOutcome = "changed" | "unchanged" | "cancelled" | "deferred";

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
			if (!(await confirmReload(ctx))) {
				ctx.ui.notify(`Updated ${row.name}${transition}; reload pending -- run /reload when ready.`, "warning");
				return "deferred";
			}
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
			if (!(await confirmReload(ctx))) {
				ctx.ui.notify(`Removed ${row.name}; reload pending -- run /reload when ready.`, "warning");
				return "deferred";
			}
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

/** Present only on phase "done" -- the real captured stdout+stderr from
 * ExecInstaller (ok: true) or the thrown error's message (ok: false). This
 * is the actual execution output, not a synthetic status string, so a host
 * can show a genuine success/failure sign instead of guessing from
 * reloadRequired alone. */
interface UpdateProgressResult { ok: boolean; output: string; }
interface UpdateProgressEvent { row: Row; index: number; total: number; phase: "start" | "done"; result?: UpdateProgressResult; }

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
			onProgress?.({ row, index: i, total: outdated.length, phase: "done", result: { ok: true, output: outcome.output } });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failedNames.push(`${row.name}: ${message}`);
			onProgress?.({ row, index: i, total: outdated.length, phase: "done", result: { ok: false, output: message } });
		}
	}
	return { changed, failedNames };
}

const MAX_LOG_TAIL_CHARS = 60;

/** The last non-empty line of real captured output, bounded -- never the
 * full stdout/stderr dump inline (a noisy npm install can produce hundreds
 * of lines). undefined when there's nothing worth showing (the common
 * case: `pi update` often produces no output on success at all). */
function logTail(output: string): string | undefined {
	const line = output.trim().split("\n").filter(Boolean).at(-1);
	if (!line) return undefined;
	return line.length > MAX_LOG_TAIL_CHARS ? `${line.slice(0, MAX_LOG_TAIL_CHARS - 1)}…` : line;
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
	const failedSuffix = failedNames.length > 0 ? `, ${failedNames.length} failed` : "";
	if (!(await confirmReload(ctx))) {
		ctx.ui.notify(`Updated ${changed} package(s)${failedSuffix}; reload pending -- run /reload when ready.`, "warning");
		return "deferred";
	}
	ctx.ui.notify(`Updated ${changed} package(s)${failedSuffix}; reloading Pi resources.`, "info");
	await ctx.reload();
	return "changed";
}

const MAX_SETTLED_LOG_LINES = 5;

/** Floats its own spinner+log overlay over the still-open panel -- kept
 * for applyUpdateAll's own public API (and anything calling it directly,
 * outside the packages panel). renderPanel's own U key does not use this;
 * it renders the same spinner+log inline on its own already-open overlay
 * instead of stacking a second one. An indeterminate spinner (not a
 * determinate bar) because a single subprocess call has no knowable
 * percentage -- only "still running" or "settled". Each settled row
 * appends one bounded log line (real captured output, not a synthetic
 * status) with a genuine success/failure glyph, up to a small scrollback. */
async function runUpdatesWithProgress(
	outdated: Row[],
	natives: Natives,
	approved: boolean | undefined,
	ctx: ExtensionCommandContext,
): Promise<UpdateAllResult> {
	return ctx.ui.custom<UpdateAllResult>(
		(tui, theme, _kb, done) => {
			const spinner = new Spinner();
			const settledLines: string[] = [];
			let currentLabel = `${outdated[0]?.name ?? ""} (1/${outdated.length})`;
			const border = () => new DynamicBorder((s) => theme.fg("border", s));
			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(border());
			container.addChild({ invalidate() {}, render: (_width: number) => [theme.bold("Updating packages")] });
			container.addChild(new Spacer(1));
			container.addChild({ invalidate() {}, render: (width: number) => [truncateToWidth(`${theme.fg("accent", spinner.glyph())} ${currentLabel}`, width, "")] });
			container.addChild(new Spacer(1));
			container.addChild({
				invalidate() {},
				render: (width: number) => settledLines.slice(-MAX_SETTLED_LOG_LINES).map((line) => truncateToWidth(line, width, "")),
			});
			container.addChild(new Spacer(1));
			container.addChild(border());

			spinner.start(() => tui.requestRender());
			performUpdateAll(outdated, natives, approved, (event) => {
				if (event.phase === "start") {
					currentLabel = `${event.row.name} (${event.index + 1}/${event.total})`;
				} else {
					const glyph = event.result?.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const tail = event.result ? logTail(event.result.output) : undefined;
					settledLines.push(`${glyph} ${event.row.name}${tail ? theme.fg("dim", ` -- ${tail}`) : ""}`);
				}
				tui.requestRender();
			}).finally(() => spinner.stop()).then(done);

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
	const verb = disabling ? "Disabled" : "Enabled";
	if (!(await confirmReload(ctx))) {
		ctx.ui.notify(`${verb} ${toggled} extension(s) for ${row.name}; reload pending -- run /reload when ready.`, "warning");
		return "deferred";
	}
	ctx.ui.notify(`${verb} ${toggled} extension(s) for ${row.name}; reloading Pi resources.`, "info");
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

	// A deferred reload means the mutation itself genuinely happened but
	// ctx.reload() was declined -- the session is still alive, so refresh
	// rows (real on-disk versions) and keep the panel open, same as "refresh".
	async function refreshRows(): Promise<void> {
		({ rows, error } = await loadRows(natives));
		if (error) ctx.ui.notify(`refresh failed: ${error}`, "error");
	}

	// Panel loop: actions resolve the component, run outside it, then reopen.
	// Every mutation (u/x/d, U, and whatever the Enter action menu picks) is
	// handled entirely inside renderPanel itself -- approval and reload
	// confirms render inline on the same already-open overlay -- and never
	// reaches here; only non-mutation navigation resolves this loop.
	for (;;) {
		const action = await renderPanel(ctx, natives, rows);
		if (!action) return; // closed

		if (action.type === "refresh") {
			await refreshRows();
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

		await showResourceConfig(ctx, natives, action.row?.name);
		// showResourceConfig already handles its own reload prompt
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
		// Set only while U's batch update is running -- blocks input for the
		// whole batch (the installer owns input until it finishes), same as
		// before. The list stays fully visible throughout. Which specific row
		// currently shows a spinner vs. a settled ✓/✗ is settled's own job
		// (below), not this -- a just-finished row must show its glyph
		// immediately, even for the instant before the next row's "start"
		// event reassigns this to the next name.
		let updatingRowName: string | undefined;
		const spinner = new Spinner();
		const settled = new Map<string, { ok: boolean; tail: string | undefined }>();

		const maxVisible = 20;

		function applyFilter(): void {
			filtered = filterRows(visibleRows(rows, mode), searchInput.getValue());
			selectedIndex = 0;
		}

		// A y/n decision rendered as this SAME overlay's own content (via a real
		// Malevich Dialog, dispatched by literal key press) instead of
		// ctx.ui.confirm's separate native dialog -- confirmed live as a real
		// user complaint: ctx.ui.confirm opens as its own distinct overlay on
		// top of this one ("a new window"), arrow-select only, no y/n keys.
		let pendingDialog: Dialog | undefined;

		function confirmInline(title: string, message: string): Promise<boolean> {
			return new Promise((resolve) => {
				const settle = (value: boolean) => {
					pendingDialog = undefined;
					tui.requestRender();
					resolve(value);
				};
				pendingDialog = new Dialog({
					title,
					body: message,
					actions: [
						{ label: "Yes", key: "y", action: () => settle(true) },
						{ label: "No", key: "n", action: () => settle(false) },
					],
					theme: dialogTheme(theme),
				});
				tui.requestRender();
			});
		}

		// Every confirm() call inside a mutation flow driven from this open
		// overlay (approvePackageOperation's own approval, confirmReload's
		// separate reload gate) routes through confirmInline instead of the
		// real ctx.ui.confirm -- notify/reload/etc. stay the genuine ctx.
		const inlineCtx: ExtensionCommandContext = { ...ctx, hasUI: true, ui: { ...ctx.ui, confirm: confirmInline } };

		/** u/x/d and the Enter action menu all funnel through here: approval and
		 * reload confirms render inline (via inlineCtx/confirmInline) on this
		 * same overlay, never closing it first the way done()-dispatch used to. */
		async function runRowActionInline(action: { type: "update" | "remove" | "disable"; row: Row }): Promise<void> {
			updatingRowName = action.row.name;
			tui.requestRender();
			const outcome = action.type === "disable"
				? await applyDisableExtensions(action.row, natives, inlineCtx)
				: await applyPackageChoice(action.type === "update" ? `Update to ${action.row.latest}` : "Remove", action.row, natives, inlineCtx);
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

		/** U -- runs the whole approve+update+notify+reload flow without ever
		 * closing this panel or replacing the list: each row's own settled
		 * outcome (spinner while in flight, then a real ✓/✗ plus a bounded tail
		 * of its actual captured output) appears inline next to that row, via
		 * updatingRowName/spinner/settled, which list's own render checks. Rows
		 * refresh in place afterward unless a reload already ended the session. */
		async function runUpdateAllInline(): Promise<void> {
			const outdated = rows.filter((row) => row.hasUpdate);
			settled.clear();
			const outcome = await approveAndRunUpdateAll(outdated, natives, inlineCtx, (batch, approved) => {
				spinner.start(() => tui.requestRender());
				return performUpdateAll(batch, natives, approved, (event) => {
					updatingRowName = event.row.name;
					if (event.phase === "done" && event.result) {
						settled.set(event.row.name, { ok: event.result.ok, tail: logTail(event.result.output) });
					}
					tui.requestRender();
				}).finally(() => spinner.stop());
			});
			updatingRowName = undefined;
			if (outcome === "changed") {
				done(undefined); // ctx.reload() already replaced the session
				return;
			}
			const reloaded = await loadRows(natives);
			if (reloaded.error) ctx.ui.notify(`refresh failed: ${reloaded.error}`, "error");
			else rows = reloaded.rows;
			settled.clear(); // fresh state for a subsequent batch
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
						// A settled row shows its real outcome even for the instant
						// before the next row's "start" event moves updatingRowName
						// off it -- settled always wins over "still spinning".
						const rowSettled = settled.get(row.name);
						const isUpdating = !rowSettled && updatingRowName === row.name;
						const status = isUpdating
							? theme.fg("accent", `${spinner.glyph()} updating…`)
							: rowSettled
								? theme.fg(rowSettled.ok ? "success" : "error", `${rowSettled.ok ? "✓" : "✗"}${rowSettled.tail ? ` ${rowSettled.tail}` : ""}`)
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
		// measure must be explicit: Envelope's own default is ASCII-only (raw
		// .length, blind to ANSI escape codes) and every line below is styled
		// through theme.fg/theme.bold -- without this, Envelope pads each line
		// against its own escape-code-inflated "length" instead of its real
		// visible width, so the right border lands at a different column on
		// every line depending on how much styling that particular line has.
		const envelope = new Envelope({
			title: panelTitle(),
			borderStyle: "rounded",
			style: (s) => theme.fg("border", s),
			titleStyle: (s) => theme.bold(theme.fg("accent", s)),
			measure,
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
				envelope.setContent(pendingDialog ?? body);
				return envelope.render(width);
			},
			invalidate: () => envelope.invalidate(),
			handleInput(data: string) {
				if (pendingDialog) {
					pendingDialog.handleInput(data);
					tui.requestRender();
					return;
				}
				if (updatingRowName) return; // the mutation/installer owns input until it finishes

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
						if (row?.hasUpdate) void runRowActionInline({ type: "update", row });
						return;
					}
					case "x": {
						const row = filtered[selectedIndex];
						if (row) void runRowActionInline({ type: "remove", row });
						return;
					}
					case "d": {
						const row = filtered[selectedIndex];
						if (row) void runRowActionInline({ type: "disable", row });
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
							if (choice === "update" || choice === "remove" || choice === "disable") void runRowActionInline({ type: choice, row });
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
		// row is a real percentage of terminal height (0%=top, 100%=bottom) --
		// unlike anchor:"top-center"+offsetY (a fixed row count, effectively
		// pinned to the very top on any terminal size), this scales with the
		// actual screen. anchor:"center" still governs horizontal centering
		// (row overrides only the vertical resolution). Note this isn't fully
		// content-height-independent -- pi-tui's own row-percentage formula
		// interpolates over the range of positions that still fit the current
		// content height, so a shorter/taller row count shifts this somewhat;
		// only exactly 0%/100% are perfectly jitter-free in that library.
	}, { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center", row: "40%" } });
}
