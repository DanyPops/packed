/**
 * tui.ts — /packed's one panel, four tabs. Mnemonics follow lazy.nvim's
 * own convention (folke/lazy.nvim lua/lazy/view/config.lua): uppercase
 * acts on every row, lowercase acts on the row under the cursor -- U/u
 * update, X/x was lazy's delete key (clean); here that pairing is
 * single-target only (x remove -- there is no safe "remove every
 * installed package" bulk analog, so no X is bound). Adds d disable/
 * enable this package's extensions, c jump to Config (scoped to the
 * selected row), f jump to Find, s jump to Settings.
 *
 * All four (Packages/Find/Config/Settings) live inside ONE
 * `ctx.ui.custom` floating overlay for the panel's whole lifetime --
 * Malevich's Envelope for the box (rounded border), TabbedContainer for
 * the persistent tab bar + active-tab content swap, and (on top of that)
 * a Dialog swapped in for any y/n decision, the same content-replacement
 * stacking Envelope's own setContent already provides, generalized one
 * level further here. This replaced each tab opening its own separate
 * screen (Find/Config: a second, visually distinct ctx.ui.custom with no
 * Envelope at all; Settings: Pi's own native ctx.ui.select/confirm) --
 * confirmed live as a real user complaint ("Find, Settings, Config all
 * open a different TUI"). Left/Right cycle tabs; Escape returns to
 * Packages from anywhere else, or closes the whole panel from Packages
 * itself -- unless the active tab's own capturesEscape()/
 * capturesHorizontalArrows() says it wants that key for itself right now
 * (an active text filter, an in-flight mutation, or Find's always-on
 * query box), in which case it's delegated straight through instead.
 *
 * Packages itself: an indeterminate spinner (Malevich's Spinner) renders
 * inline next to the row currently updating, settling into a real ✓/✗
 * plus a bounded tail of that row's own actual captured stdout/stderr
 * once it finishes, never a determinate bar (a single subprocess call has
 * no knowable percentage). Rows render through Malevich's Table (real
 * column-aligned Package/Version/status cells, per-row selection styling
 * baked into each cell since Table's own cellStyle is column-wide, not
 * row-wide) inside this tab's own scroll-window slice -- Table
 * deliberately owns no pagination of its own, so the visible-window-
 * around-selectedIndex math stays here. u/x/d and the Enter action menu
 * all run their whole approve+mutate+confirmReload flow inline, via the
 * shared TabHost's inlineCtx -- every confirm() along the way renders as
 * a real Malevich Dialog on this SAME overlay, dispatched by literal y/n
 * keys, instead of ctx.ui.confirm's own separate native dialog. Every
 * non-"changed" settle point (already up to date, pinned, deferred, a
 * genuine failure) shows its own real reason on that row too via the same
 * settled map U's batch path uses, not only as a scrollback toast. All
 * data flows through the packed CLI (thin seam).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Dialog, Envelope, Menu, Spinner, Table, TabbedContainer, type Component, type MenuItem, type TextMeasure } from "malevich-tui-components";
import { filterRows, mergeRows, nextMode, visibleRows } from "./model.js";
import type { Row, ViewMode } from "./model.js";
import type { Natives, PackageResources } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { createSettingsTab, SettingsTab } from "./security-tui.js";
import { createConfigTab, ConfigTab, applyResourceToggle } from "./resource-config.js";
import { createFindTab, FindTab } from "./discover.js";
import { dialogTheme, menuTheme, tabBarTheme } from "./menu-theme.js";
import { confirmReload } from "./reload.js";
import type { TabHost } from "./tab-host.js";

export type PackedTabKey = "packages" | "find" | "config" | "settings";

/** Outcome of a confirmed row action, resolved after any real mutation and
 * reload decision -- "changed" means the daemon state changed and Pi has
 * already been reloaded (the caller should stop showing the stale panel);
 * "deferred" means the mutation itself genuinely happened but the user
 * declined confirmReload's separate reload gate -- Pi's session is still
 * alive and the panel should refresh its rows and keep running, not close;
 * "unchanged"/"cancelled" mean the panel keeps running as-is. */
export type PackageChoiceOutcome = "changed" | "unchanged" | "cancelled" | "deferred";

/** A non-"changed" settle point's own detail -- the exact reason nothing
 * (or only a partial thing) happened, so a caller with somewhere to show
 * it inline (a row's own status cell) isn't limited to the scrollback
 * toast every outcome already gets via ctx.ui.notify. "changed" never
 * calls this: ctx.reload() already replaces the session by then. */
export interface PackageChoiceSettled { ok: boolean; message: string; }

export async function applyPackageChoice(
	choice: string | undefined,
	row: Row,
	natives: Natives,
	ctx: ExtensionCommandContext,
	onSettled?: (settled: PackageChoiceSettled) => void,
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
				onSettled?.({ ok: true, message: reason });
				return "unchanged";
			}
			const transition = outcome.previousVersion && outcome.currentVersion ? ` (${outcome.previousVersion} → ${outcome.currentVersion})` : "";
			if (!(await confirmReload(ctx))) {
				ctx.ui.notify(`Updated ${row.name}${transition}; reload pending -- run /reload when ready.`, "warning");
				onSettled?.({ ok: true, message: `updated${transition}; reload pending` });
				return "deferred";
			}
			ctx.ui.notify(`Updated ${row.name}${transition}; reloading Pi resources.`, "info");
			await ctx.reload();
			return "changed";
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			ctx.ui.notify(`update failed: ${message}`, "error");
			onSettled?.({ ok: false, message });
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
				onSettled?.({ ok: true, message: "removed; reload pending" });
				return "deferred";
			}
			ctx.ui.notify(`Removed ${row.name}; reloading Pi resources.`, "info");
			await ctx.reload();
			return "changed";
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			ctx.ui.notify(`remove failed: ${message}`, "error");
			onSettled?.({ ok: false, message });
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

interface PackagesTabTheme { fg(color: string, s: string): string; bold(s: string): string; }

/** Packages -- the panel's default/"home" tab. A real Component (not the
 * panel's own top-level ctx.ui.custom owner anymore); the shared TabHost
 * gives it inline approval/reload dialogs and a way to signal the overlay
 * should close once a mutation actually replaces the session. */
export class PackagesTab implements Component {
	private rows: Row[];
	private mode: ViewMode = "all";
	private readonly searchInput = new Input();
	private searchActive = false;
	private filtered: Row[];
	private selectedIndex = 0;
	// Set only while U's batch update (or a single row's own u/x/d) is
	// running -- blocks input for the duration (the mutation/installer owns
	// input until it finishes). Which specific row currently shows a spinner
	// vs. a settled ✓/✗ is settled's own job, not this -- a just-finished row
	// must show its glyph immediately, even for the instant before the next
	// row's "start" event reassigns this to the next name.
	private updatingRowName: string | undefined;
	private readonly spinner = new Spinner();
	private readonly settled = new Map<string, { ok: boolean; tail: string | undefined }>();
	private readonly table: Table;
	private readonly maxVisible = 20;

	constructor(
		private readonly natives: Natives,
		private readonly host: TabHost,
		private readonly theme: PackagesTabTheme,
		measure: TextMeasure,
		initialRows: Row[],
		/** c on a row, or the Enter action menu's "Configure resources" --
		 * switches the shared TabbedContainer to Config, seeded with that
		 * row's own name as its filter. f/s switch tabs with no filter. */
		private readonly switchTab: (target: "find" | "config" | "settings", configFilter?: string) => void,
	) {
		this.rows = initialRows;
		this.filtered = visibleRows(this.rows, this.mode);
		this.table = new Table({
			columns: [
				{ header: "Package", key: "name" },
				{ header: "Version", key: "version" },
				{ header: "", key: "status" },
			],
			rows: [],
			measure,
			headerStyle: (s) => theme.fg("muted", s),
		});
	}

	/** An active filter or an in-flight mutation means Escape/Left-Right
	 * belong to this tab (clearing the filter; blocking navigation away
	 * mid-mutation), not the host's own back/tab-cycle handling. Packages
	 * never uses Left/Right for itself otherwise. */
	capturesEscape(): boolean {
		return this.searchActive || this.updatingRowName !== undefined;
	}

	/** Same condition as capturesEscape -- an active filter or an in-flight
	 * mutation means every printable key (including a letter that would
	 * otherwise be a global tab-jump mnemonic) belongs to this tab right now.
	 * Packages itself never needs this check at the host level (see
	 * renderUnifiedPanel's own dispatcher), but implementing it keeps this
	 * tab's own contract honest and consistent with the other three. */
	capturesMnemonics(): boolean {
		return this.searchActive || this.updatingRowName !== undefined;
	}

	invalidate(): void {
		this.table.invalidate();
	}

	private applyFilter(): void {
		this.filtered = filterRows(visibleRows(this.rows, this.mode), this.searchInput.getValue());
		this.selectedIndex = 0;
	}

	private statusLine(): string {
		if (this.updatingRowName) return "updating…";
		const outdated = this.rows.filter((r) => r.hasUpdate).length;
		return outdated > 0 ? `${outdated} update(s)` : "up to date";
	}

	render(width: number): string[] {
		const { theme } = this;
		const hint = this.searchActive
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
				rawKeyHint("r", "refresh");
		const line1 = truncateToWidth(hint, width, "");
		const dot = "·";
		const line2 = truncateToWidth(
			theme.fg("muted", `${this.statusLine()} ${dot} view: ${this.mode} ${dot} / filter ${dot} v view ${dot} ${this.rows.length} installed`),
			width,
			"",
		);
		const lines: string[] = [line1, line2];
		if (this.searchActive) lines.push(...this.searchInput.render(width));
		lines.push("");
		if (this.filtered.length === 0) {
			lines.push(theme.fg("muted", "  No packages"));
			return lines;
		}
		// No scrolling of its own (Malevich's Table is deliberately
		// unopinionated about pagination) -- the visible window around
		// selectedIndex stays this tab's own job.
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible));
		const end = Math.min(start + this.maxVisible, this.filtered.length);
		this.table.setRows(
			this.filtered.slice(start, end).map((row, offset) => {
				const i = start + offset;
				const selected = i === this.selectedIndex;
				const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
				const name = selected ? theme.bold(row.name) : row.name;
				// A settled row shows its real outcome even for the instant before
				// the next row's "start" event moves updatingRowName off it --
				// settled always wins over "still spinning".
				const rowSettled = this.settled.get(row.name);
				const isUpdating = !rowSettled && this.updatingRowName === row.name;
				const status = isUpdating
					? theme.fg("accent", `${this.spinner.glyph()} updating…`)
					: rowSettled
						? theme.fg(rowSettled.ok ? "success" : "error", `${rowSettled.ok ? "✓" : "✗"}${rowSettled.tail ? ` ${rowSettled.tail}` : ""}`)
						: row.hasUpdate ? theme.fg("warning", `↑${row.latest}`) : "";
				return { name: `${cursor}${name}`, version: theme.fg("dim", row.version), status };
			}),
		);
		lines.push(...this.table.render(width));
		const hasScroll = start > 0 || end < this.filtered.length;
		lines.push(theme.fg("dim", `  ${hasScroll ? `${this.selectedIndex + 1}/${this.filtered.length} ` : ""}${this.mode}`));
		return lines;
	}

	handleInput(data: string): void {
		if (this.updatingRowName) return; // the mutation/installer owns input until it finishes

		if (this.searchActive) {
			if (data === "\x1b") {
				this.searchActive = false;
				this.searchInput.setValue?.("");
				this.applyFilter();
			} else if (data === "\r") {
				this.searchActive = false;
			} else {
				this.searchInput.handleInput(data);
				this.applyFilter();
			}
			this.host.requestRender();
			return;
		}

		switch (data) {
			case "\x1b[A":
				this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % Math.max(this.filtered.length, 1);
				break;
			case "\x1b[B":
				this.selectedIndex = (this.selectedIndex + 1) % Math.max(this.filtered.length, 1);
				break;
			case "v": // Tab is now reserved globally for sweeping between menus (TabbedContainer)
				this.mode = nextMode(this.mode);
				this.applyFilter();
				break;
			case "/":
				this.searchActive = true;
				break;
			case "r":
				void this.refresh();
				return;
			case "s":
				this.switchTab("settings");
				return;
			case "f":
				this.switchTab("find");
				return;
			case "U":
				void this.runUpdateAllInline();
				return;
			case "u": {
				const row = this.filtered[this.selectedIndex];
				if (row?.hasUpdate) void this.runRowActionInline({ type: "update", row });
				return;
			}
			case "x": {
				const row = this.filtered[this.selectedIndex];
				if (row) void this.runRowActionInline({ type: "remove", row });
				return;
			}
			case "d": {
				const row = this.filtered[this.selectedIndex];
				if (row) void this.runRowActionInline({ type: "disable", row });
				return;
			}
			case "c": {
				const row = this.filtered[this.selectedIndex];
				if (row) this.switchTab("config", row.name);
				return;
			}
			case "\r": {
				const row = this.filtered[this.selectedIndex];
				if (!row) return;
				void (async () => {
					const choice = await showActionMenu(this.host.inlineCtx, row);
					if (choice === "update" || choice === "remove" || choice === "disable") void this.runRowActionInline({ type: choice, row });
					else if (choice === "config") this.switchTab("config", row.name);
				})();
				return;
			}
			default:
				return;
		}
		this.host.requestRender();
	}

	private async refresh(): Promise<void> {
		const reloaded = await loadRows(this.natives);
		if (reloaded.error) this.host.ctx.ui.notify(`refresh failed: ${reloaded.error}`, "error");
		else this.rows = reloaded.rows;
		this.applyFilter();
		this.host.requestRender();
	}

	/** u/x/d and the Enter action menu all funnel through here: approval and
	 * reload confirms render inline (via host.inlineCtx) on this same
	 * overlay, never closing it first. */
	private async runRowActionInline(action: { type: "update" | "remove" | "disable"; row: Row }): Promise<void> {
		this.updatingRowName = action.row.name;
		this.host.requestRender();
		// A non-"changed" settle point (already up to date, pinned, deferred, a
		// genuine failure) shows its own real reason on this row, the same
		// settled map U's batch path already renders -- not just a scrollback
		// toast.
		const onSettled = (result: PackageChoiceSettled) => this.settled.set(action.row.name, { ok: result.ok, tail: result.message });
		const outcome = action.type === "disable"
			? await applyDisableExtensions(action.row, this.natives, this.host.inlineCtx)
			: await applyPackageChoice(action.type === "update" ? `Update to ${action.row.latest}` : "Remove", action.row, this.natives, this.host.inlineCtx, onSettled);
		this.updatingRowName = undefined;
		if (outcome === "changed") {
			this.host.onSessionReplaced(); // ctx.reload() already replaced the session
			return;
		}
		const reloaded = await loadRows(this.natives);
		if (reloaded.error) this.host.ctx.ui.notify(`refresh failed: ${reloaded.error}`, "error");
		else this.rows = reloaded.rows;
		this.applyFilter();
		this.host.requestRender();
	}

	/** U -- runs the whole approve+update+notify+reload flow without ever
	 * closing this tab or replacing the list: each row's own settled outcome
	 * (spinner while in flight, then a real ✓/✗ plus a bounded tail of its
	 * actual captured output) appears inline next to that row. Rows refresh
	 * in place afterward unless a reload already ended the session. */
	private async runUpdateAllInline(): Promise<void> {
		const outdated = this.rows.filter((row) => row.hasUpdate);
		this.settled.clear();
		const outcome = await approveAndRunUpdateAll(outdated, this.natives, this.host.inlineCtx, (batch, approved) => {
			this.spinner.start(() => this.host.requestRender());
			return performUpdateAll(batch, this.natives, approved, (event) => {
				this.updatingRowName = event.row.name;
				if (event.phase === "done" && event.result) {
					this.settled.set(event.row.name, { ok: event.result.ok, tail: logTail(event.result.output) });
				}
				this.host.requestRender();
			}).finally(() => this.spinner.stop());
		});
		this.updatingRowName = undefined;
		if (outcome === "changed") {
			this.host.onSessionReplaced(); // ctx.reload() already replaced the session
			return;
		}
		const reloaded = await loadRows(this.natives);
		if (reloaded.error) this.host.ctx.ui.notify(`refresh failed: ${reloaded.error}`, "error");
		else this.rows = reloaded.rows;
		this.settled.clear(); // fresh state for a subsequent batch
		this.applyFilter();
		this.host.requestRender();
	}
}

interface TabScope {
	/** True while this tab wants Escape for itself right now (an active
	 * filter, an in-flight mutation) instead of the host's own "back to
	 * Packages, or close from Packages" handling. Defaults to false. */
	capturesEscape?(): boolean;
	/** True while this tab wants Left/Right for itself right now (Find's
	 * always-on query cursor) instead of the host's own tab-cycling via
	 * TabbedContainer. Tab/Shift-Tab have no such exception -- nothing needs
	 * a literal Tab character for itself, so they always sweep between
	 * menus. Defaults to false. */
	capturesHorizontalArrows?(): boolean;
	/** True while this tab wants every printable character for itself (an
	 * active filter, an in-flight mutation, or Find's permanent query box)
	 * instead of the host's own mnemonic letter-jump (p/f/c/s). Defaults to
	 * false. Never consulted while Packages itself is active -- Packages'
	 * own f/c/s bindings already do the same jump (c additionally scopes
	 * Config to the selected row), so the generic host-level jump only
	 * matters for reaching a tab from one of the OTHER three. */
	capturesMnemonics?(): boolean;
}

export async function showPackedPanel(
	ctx: ExtensionCommandContext,
	natives: Natives,
	opts?: { initialTab?: PackedTabKey; initialConfigFilter?: string },
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed requires interactive mode", "warning");
		return;
	}

	const { rows, error } = await loadRows(natives);
	if (error) {
		ctx.ui.notify(`packed unavailable: ${error}`, "error");
		return;
	}

	await renderUnifiedPanel(ctx, natives, rows, opts?.initialTab ?? "packages", opts?.initialConfigFilter);
}

function renderUnifiedPanel(
	ctx: ExtensionCommandContext,
	natives: Natives,
	initialRows: Row[],
	initialTab: PackedTabKey,
	initialConfigFilter: string | undefined,
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		// A y/n decision rendered as this SAME overlay's own content (via a real
		// Malevich Dialog, dispatched by literal key press) instead of
		// ctx.ui.confirm's separate native dialog -- shared by every tab via
		// host.inlineCtx below, exactly like the panel's own approval/reload
		// dialogs always have been.
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
					framed: false, // this overlay's own Envelope already draws a border; a second rule would double up on it
				});
				tui.requestRender();
			});
		}

		const inlineCtx: ExtensionCommandContext = { ...ctx, hasUI: true, ui: { ...ctx.ui, confirm: confirmInline } };
		const host: TabHost = {
			ctx,
			inlineCtx,
			requestRender: () => tui.requestRender(),
			onSessionReplaced: () => done(undefined),
		};

		const measure: TextMeasure = { visibleWidth, truncateToWidth };

		const packagesTab = new PackagesTab(natives, host, theme, measure, initialRows, (target, configFilter) => {
			if (target === "config" && configFilter !== undefined) configTab.setFilter(configFilter);
			tabbedContainer.setActive(target);
		});

		const findTab = createFindTab(natives, host, theme);

		// Config/Settings both need theme (only available once this factory
		// runs) so they're constructed here rather than before the overlay
		// opens; both load their own data asynchronously in the background and
		// render their own "Loading…" state until it resolves -- no
		// placeholder-swap machinery needed.
		const configTab = new ConfigTab(natives, host, theme, initialTab === "config" ? initialConfigFilter : undefined);
		void configTab.load().then(() => tui.requestRender());

		const settingsTab = new SettingsTab(natives, host, theme);
		void settingsTab.load().then(() => tui.requestRender());

		const tabByKey: Record<PackedTabKey, Component & TabScope> = {
			packages: packagesTab,
			find: findTab,
			config: configTab,
			settings: settingsTab,
		};

		const tabbedContainer = new TabbedContainer({
			tabs: [
				{ key: "packages", label: "Packages", content: tabByKey.packages },
				{ key: "find", label: "Find", content: tabByKey.find },
				{ key: "config", label: "Config", content: tabByKey.config },
				{ key: "settings", label: "Settings", content: tabByKey.settings },
			],
			theme: tabBarTheme(theme),
			initialKey: initialTab,
			// Malevich's own default matcher only recognizes legacy CSI sequences;
			// pi-tui's real matchesKey also covers the Kitty keyboard protocol and
			// xterm's modifyOtherKeys encodings for the same keys. Malevich's
			// KeyMatcher type takes a bare string (it doesn't share pi-tui's KeyId
			// union), so this only ever forwards the small fixed set of key names
			// TabbedContainer itself actually calls with (left/right/tab/shift+tab).
			matchesKey: (data, keyId) => matchesKey(data, keyId as Parameters<typeof matchesKey>[1]),
		});

		// measure must be explicit: Envelope's own default is ASCII-only (raw
		// .length, blind to ANSI escape codes) and every tab's own content is
		// styled through theme.fg/theme.bold -- without this, Envelope pads
		// each line against its own escape-code-inflated "length" instead of
		// its real visible width, so the right border lands at a different
		// column on every line depending on how much styling it carries.
		const envelope = new Envelope({
			title: "packed",
			borderStyle: "rounded",
			style: (s) => theme.fg("border", s),
			titleStyle: (s) => theme.bold(theme.fg("accent", s)),
			measure,
		});

		return {
			render(width: number): string[] {
				envelope.setContent(pendingDialog ?? tabbedContainer);
				return envelope.render(width);
			},
			invalidate: () => envelope.invalidate(),
			handleInput(data: string) {
				if (pendingDialog) {
					pendingDialog.handleInput(data);
					tui.requestRender();
					return;
				}
				const activeKey = tabbedContainer.getActiveKey() as PackedTabKey;
				const activeTab = tabByKey[activeKey];
				// Each host-level key is checked against that tab's own capture flag
				// independently -- conflating them would, e.g., let Find's always-on
				// capturesHorizontalArrows() also swallow Escape into the query box
				// instead of navigating back.
				if (data === "\x1b" && !(activeTab.capturesEscape?.() ?? false)) {
					if (activeKey !== "packages") tabbedContainer.setActive("packages");
					else { done(undefined); return; }
					tui.requestRender();
					return;
				}
				// Tab/Shift-Tab always sweep between menus -- nothing needs a literal
				// Tab character for itself (Packages'/Config's own former Tab bindings
				// moved to v once Tab was claimed globally; see the mnemonics.test.ts
				// conflict check for why that reassignment was necessary). Real
				// matchesKey(), not a hardcoded "\x1b[Z" literal, because Shift-Tab has
				// no single universal encoding: legacy terminals send CSI Z, but the
				// Kitty keyboard protocol and xterm's modifyOtherKeys mode both send a
				// different sequence for the same keypress -- a literal check silently
				// misses whichever ones it doesn't happen to be pinned to.
				if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
					tabbedContainer.handleInput(data);
					tui.requestRender();
					return;
				}
				if ((matchesKey(data, "right") || matchesKey(data, "left")) && !(activeTab.capturesHorizontalArrows?.() ?? false)) {
					tabbedContainer.handleInput(data); // owns Left/Right cycling itself
					tui.requestRender();
					return;
				}
				// The first letter of each tab's label is a jump mnemonic
				// (Packages/Find/Config/Settings -> p/f/c/s), highlighted in the tab
				// bar itself -- but only reachable FROM one of the other three tabs.
				// Packages' own f/c/s bindings already do the same jump (c
				// additionally scopes Config to the selected row); letting the
				// generic version fire there too would just be redundant, not wrong,
				// but skipping it keeps this one dispatcher the single source of
				// truth for "which code path actually owns key X" per active tab.
				if (activeKey !== "packages" && data.length === 1) {
					const target = tabbedContainer.resolveMnemonic(data);
					if (target && target !== activeKey && !(activeTab.capturesMnemonics?.() ?? false)) {
						tabbedContainer.setActive(target as PackedTabKey);
						tui.requestRender();
						return;
					}
				}
				activeTab.handleInput?.(data);
				tui.requestRender();
			},
		};
		// Pinned to the very top (anchor:"top-center"+offsetY:1 -- a fixed row
		// count regardless of terminal size), not row:"40%". The percentage
		// positioning was tried instead but reverted: pi-tui's row-percentage
		// formula interpolates over the range of positions that still fit the
		// CURRENT content height, so the panel visibly jittered up and down
		// every time a tab with a different content height (Packages' table vs.
		// Config's shorter list) became active. A fixed top offset keeps the
		// header pinned in place and only the footer moves as content grows.
	}, { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "top-center", offsetY: 1 } });
}
