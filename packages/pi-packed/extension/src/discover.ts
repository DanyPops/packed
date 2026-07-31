/**
 * discover.ts — /packed find: query the npm registry for installable Pi
 * packages and install one. A sub-flow like settings/config, reachable
 * from the packages panel via f and returning to it on close. Search
 * itself never mutates; only Install/Cancel (behind the standard
 * approval) does.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Menu, type MenuItem } from "malevich-tui-components";
import { shouldSearch } from "./discover-model.js";
import type { Natives, PackageSummary } from "./packed.js";
import { InstallServiceError } from "./packed.js";
import { approvePackageOperation } from "./tools.js";
import { menuTheme } from "./menu-theme.js";

const SEARCH_LIMIT = 20;

interface FindPanelAction {
	type: "install" | "close";
	result?: PackageSummary;
}

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

async function showInstallMenu(ctx: ExtensionCommandContext, result: PackageSummary): Promise<boolean> {
	return ctx.ui.custom<boolean>(
		(_tui, theme, _kb, done) => {
			const items: MenuItem[] = [
				{ label: `Install ${result.name}@${result.version}`, action: () => done(true) },
				{ label: "Cancel", action: () => done(false) },
			];
			return new Menu({ items, theme: menuTheme(theme), onClose: () => done(false) });
		},
		{ overlay: true, overlayOptions: { width: 40, anchor: "center" } },
	);
}

export async function showDiscoverPanel(ctx: ExtensionCommandContext, natives: Natives): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed find requires interactive mode", "warning");
		return;
	}

	for (;;) {
		const action = await renderDiscoverPanel(ctx, natives);
		if (action.type === "close") return;
		if (!action.result) continue;
		const install = await showInstallMenu(ctx, action.result);
		if (!install) continue;
		const outcome = await applyInstall(action.result, natives, ctx);
		if (outcome === "installed") return; // ctx.reload() already replaced the session
	}
}

function renderDiscoverPanel(ctx: ExtensionCommandContext, natives: Natives): Promise<FindPanelAction> {
	return ctx.ui.custom<FindPanelAction>((tui, theme, _kb, done) => {
		const queryInput = new Input();
		let results: PackageSummary[] = [];
		let lastSearchedQuery: string | undefined;
		let selectedIndex = 0;
		let searching = false;
		let error: string | undefined;
		const maxVisible = 15;

		async function runSearch(): Promise<void> {
			const query = queryInput.getValue().trim();
			if (!query) return;
			searching = true;
			error = undefined;
			tui.requestRender();
			try {
				const response = await natives.search(query, SEARCH_LIMIT);
				results = response.results;
				lastSearchedQuery = queryInput.getValue();
				selectedIndex = 0;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				results = [];
			} finally {
				searching = false;
				tui.requestRender();
			}
		}

		const header = {
			invalidate() {},
			render(width: number): string[] {
				const title = theme.bold("Find packages");
				const hint = rawKeyHint("enter", "search/install") + theme.fg("muted", " · ") + rawKeyHint("esc", "back");
				const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
				const line1 = truncateToWidth(`${title}${" ".repeat(spacing)}`, width, "") + hint;
				const status = searching ? "searching…" : error ? theme.fg("error", error) : `${results.length} result(s)`;
				const line2 = truncateToWidth(theme.fg("muted", status), width, "");
				return [line1, line2];
			},
		};

		const list = {
			invalidate() {},
			render(width: number): string[] {
				const lines = [...queryInput.render(width), ""];
				if (results.length === 0) {
					lines.push(theme.fg("muted", searching ? "  …" : "  Type a query and press enter to search npm"));
					return lines;
				}
				const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), results.length - maxVisible));
				const end = Math.min(start + maxVisible, results.length);
				for (let i = start; i < end; i++) {
					const result = results[i]!;
					const selected = i === selectedIndex;
					const cursor = selected ? theme.fg("accent", "❯") : " ";
					const name = selected ? theme.bold(result.name) : result.name;
					const ver = theme.fg("dim", `@${result.version}`);
					const description = result.description ? theme.fg("muted", ` — ${result.description}`) : "";
					lines.push(truncateToWidth(`${cursor} ${name}${ver}${description}`, width, ""));
				}
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
				switch (data) {
					case "\x1b[A": // up
						if (results.length > 0) selectedIndex = (selectedIndex - 1 + results.length) % results.length;
						break;
					case "\x1b[B": // down
						if (results.length > 0) selectedIndex = (selectedIndex + 1) % results.length;
						break;
					case "\r":
						if (shouldSearch(queryInput.getValue(), lastSearchedQuery, results.length > 0)) {
							void runSearch();
						} else {
							const result = results[selectedIndex];
							if (result) done({ type: "install", result });
						}
						return;
					case "\x1b":
						done({ type: "close" });
						return;
					default:
						queryInput.handleInput(data);
						break;
				}
				tui.requestRender();
			},
		};
	});
}
