/**
 * discover.ts — /packed's Find tab: query the npm registry for installable
 * Pi packages and install one. A real Component (not its own ctx.ui.custom
 * overlay) so it plugs straight into TabbedContainer alongside
 * Packages/Config/Settings on the same overlay -- it used to open a
 * second, visually distinct screen (no Malevich Envelope, its own
 * hand-rolled Container+DynamicBorder chrome), confirmed live as a real
 * "opens a different TUI" complaint. Search itself never mutates; only
 * Install (behind a quick inline confirm, then the standard approval
 * every mutation surface requires) does.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "malevich-tui-components";
import { shouldSearch } from "./discover-model.js";
import type { Natives, PackageSummary } from "./packed.js";
import { InstallServiceError } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import type { TabHost } from "./tab-host.js";

const SEARCH_LIMIT = 20;

export type InstallOutcome = "installed" | "cancelled" | "failed";

/** Approve-then-install-then-reload, mirroring applyPackageChoice's own
 * shape for the packages panel's mutations. Best-effort service
 * registration piggybacks on the same approval, same as the agent tool
 * path (installPackageWithPolicy) -- most packages aren't daemons at all. */
export async function applyInstall(result: PackageSummary, natives: Natives, ctx: ExtensionCommandContext): Promise<InstallOutcome> {
	const source = `npm:${result.name}`;
	const approval = await approvePackageOperation("install", `pi install ${source}`, natives, ctx);
	if (!approval.allowed) {
		ctx.ui.notify(approval.message ?? "install denied", "warning");
		return "cancelled";
	}
	try {
		const output = (await natives.install(source, approval.approved)) || `Installed ${source}`;
		try {
			await natives.installService(source, approval.approved);
		} catch (e) {
			if (!(e instanceof InstallServiceError) || !e.notADaemon) {
				ctx.ui.notify(`note: could not register a persistent service for ${result.name}: ${e instanceof Error ? e.message : e}`, "warning");
			}
		}
		ctx.ui.notify(`${output}; reloading Pi resources.`, "info");
		await ctx.reload();
		return "installed";
	} catch (e) {
		ctx.ui.notify(`install failed: ${e instanceof Error ? e.message : e}`, "error");
		return "failed";
	}
}

interface Theme { fg(color: string, s: string): string; bold(s: string): string; }

/** /packed's Find tab -- a real Component. Its query box always captures
 * free text (isCapturingInput() is unconditionally true), unlike
 * Packages/Config's toggleable search: there's no "browse mode" here to
 * fall back to, searching is the whole point of this tab. */
export class FindTab implements Component {
	private readonly queryInput = new Input();
	private results: PackageSummary[] = [];
	private lastSearchedQuery: string | undefined;
	private selectedIndex = 0;
	private searching = false;
	private error: string | undefined;
	private busy = false;
	private readonly maxVisible = 15;

	constructor(
		private readonly natives: Natives,
		private readonly host: TabHost,
		private readonly theme: Theme,
	) {}

	/** Find's query box is always in text-edit mode (no separate toggle like
	 * Packages/Config's `/`) -- Left/Right must stay cursor movement, never
	 * the host's own tab-cycling. Escape, though, is only captured while an
	 * install is actually in flight (a genuine "don't let go" moment); no one
	 * types a literal Escape byte into a search query on purpose, so it's
	 * otherwise the host's own "back to Packages" to handle. */
	capturesHorizontalArrows(): boolean {
		return true;
	}

	capturesEscape(): boolean {
		return this.busy;
	}

	/** Unlike capturesEscape, this is ALWAYS true, busy or not: every
	 * printable character (a letter that would otherwise be a global
	 * tab-jump mnemonic included) is query text here, always -- there's no
	 * separate "browse mode" to fall back to the way Packages/Config have. */
	capturesMnemonics(): boolean {
		return true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const hint = rawKeyHint("enter", "search/install");
		const status = this.searching ? "searching…" : this.error ? theme.fg("error", this.error) : `${this.results.length} result(s)`;
		const spacing = Math.max(1, width - visibleWidth(hint) - visibleWidth(status));
		const line1 = truncateToWidth(`${hint}${" ".repeat(spacing)}`, width, "") + status;
		const lines = [line1, ...this.queryInput.render(width), ""];
		if (this.results.length === 0) {
			lines.push(theme.fg("muted", this.searching ? "  …" : "  Type a query and press enter to search npm"));
			return lines;
		}
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.results.length - this.maxVisible));
		const end = Math.min(start + this.maxVisible, this.results.length);
		for (let i = start; i < end; i++) {
			const result = this.results[i]!;
			const selected = i === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "❯") : " ";
			const name = selected ? theme.bold(result.name) : result.name;
			const ver = theme.fg("dim", `@${result.version}`);
			const description = result.description ? theme.fg("muted", ` — ${result.description}`) : "";
			lines.push(truncateToWidth(`${cursor} ${name}${ver}${description}`, width, ""));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		switch (data) {
			case "\x1b[A":
				if (this.results.length > 0) this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
				break;
			case "\x1b[B":
				if (this.results.length > 0) this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
				break;
			case "\r":
				if (shouldSearch(this.queryInput.getValue(), this.lastSearchedQuery, this.results.length > 0)) void this.runSearch();
				else void this.installSelected();
				return;
			default:
				this.queryInput.handleInput(data);
				break;
		}
		this.host.requestRender();
	}

	private async runSearch(): Promise<void> {
		const query = this.queryInput.getValue().trim();
		if (!query) return;
		this.searching = true;
		this.error = undefined;
		this.host.requestRender();
		try {
			const response = await this.natives.search(query, SEARCH_LIMIT);
			this.results = response.results;
			this.lastSearchedQuery = this.queryInput.getValue();
			this.selectedIndex = 0;
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			this.results = [];
		} finally {
			this.searching = false;
			this.host.requestRender();
		}
	}

	private async installSelected(): Promise<void> {
		const result = this.results[this.selectedIndex];
		if (!result) return;
		this.busy = true;
		this.host.requestRender();
		try {
			const confirmed = await this.host.inlineCtx.ui.confirm(`Install ${result.name}@${result.version}`, "Search itself never mutates -- this is the first of two confirmations before anything installs.");
			if (!confirmed) return;
			const outcome = await applyInstall(result, this.natives, this.host.inlineCtx);
			if (outcome === "installed") this.host.onSessionReplaced();
		} finally {
			this.busy = false;
			this.host.requestRender();
		}
	}
}

export function createFindTab(natives: Natives, host: TabHost, theme: Theme): FindTab {
	return new FindTab(natives, host, theme);
}
