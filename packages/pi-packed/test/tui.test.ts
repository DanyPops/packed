import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { applyDisableExtensions, applyPackageChoice, applyUpdateAll, showPackedPanel } from "../extension/src/tui.ts";
import type { Natives, PackageResources } from "../extension/src/packed.ts";
import type { Row } from "../extension/src/model.ts";

// rawKeyHint (used by the panel's own header) reads pi-coding-agent's global
// theme singleton directly, the same as DynamicBorder -- a real Pi session
// always initializes this before extension code runs; tests that actually
// call render() must do the same or it throws.
initTheme();

const row: Row = { name: "pi-lsp", version: "1.0.0", latest: "1.1.0", hasUpdate: true };

function fakeCtx(confirm: boolean, notices: string[], reloads: { count: number }): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			async confirm(_title: string, message: string) {
				notices.push(`confirm:${message}`);
				return confirm;
			},
			notify(message: string) { notices.push(message); },
		},
		async reload() { reloads.count += 1; },
	} as unknown as ExtensionCommandContext;
}

/** Runs a ctx.ui.custom factory the same way the real TUI would -- immediately,
 * with no-op tui/theme/kb stubs -- and resolves once the factory's own async
 * work calls done(). Fits any overlay that resolves itself (a progress bar)
 * rather than waiting on simulated keypresses. */
function autoResolvingCustom() {
	return <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown): Promise<T> =>
		new Promise<T>((resolve) => {
			factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
		});
}

describe("showPackedPanel (/packed folds packages + settings into one panel)", () => {
	it("opens on the packages panel, and pressing s returns to it afterward instead of exiting", async () => {
		// ctx.ui.custom is faked directly rather than simulating keypresses --
		// asserts the panel loop's own dispatch, not the real TUI's rendering.
		const customCalls: unknown[] = [];
		let customCallCount = 0;
		const securityCalls: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(_factory: unknown) {
					customCallCount += 1;
					customCalls.push(_factory);
					// First open: settings. Second open (after settings returns): close.
					return customCallCount === 1 ? { type: "settings" } : undefined;
				},
				async select() { return "Cancel"; },
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return []; },
			async updates() { return []; },
			async security() { securityCalls.push("security"); return { mutationApproval: "always" as const }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(customCallCount).toBe(2); // packages panel opened, then reopened after settings
		expect(securityCalls).toEqual(["security"]); // settings flow actually ran once
	});

	it("closes without ever touching settings when the panel itself is dismissed", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				async custom() { return undefined; }, // esc
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		let securityCalled = false;
		const natives = {
			async installed() { return []; },
			async updates() { return []; },
			async security() { securityCalled = true; return { mutationApproval: "always" as const }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(securityCalled).toBe(false);
	});

	it("opens as a real overlay anchored to the top, not centered -- so its own header height never shifts as content height changes", async () => {
		let capturedOptions: unknown;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(_factory: unknown, options: unknown) {
					capturedOptions = options;
					return undefined; // esc
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = { async installed() { return []; }, async updates() { return []; } } as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(capturedOptions).toMatchObject({ overlay: true, overlayOptions: { anchor: "top-center" } });
	});

	it("renders a real bordered box with rounded corners, not just a horizontal rule", async () => {
		let rendered: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[] }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						rendered = component.render(60);
						resolve(undefined);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = { async installed() { return [{ name: "pi-a", installed: "1.0.0" }]; }, async updates() { return []; } } as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(rendered[0]).toStartWith("╭"); // rounded top-left corner
		expect(rendered[0]).toContain("╮"); // rounded top-right corner
		expect(rendered.at(-1)).toStartWith("╰"); // rounded bottom-left corner
		expect(rendered.at(-1)).toEndWith("╯"); // rounded bottom-right corner
		expect(rendered.some((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true); // real vertical sides, not just top/bottom rules
	});

	it("renders the installer's own progress bar inline next to the updating row, without replacing the rest of the package list", async () => {
		const renderedFrames: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
						const tui = { requestRender() { renderedFrames.push(component.render(60).join("\n")); } };
						const component = factory(tui, theme, {}, resolve);
						component.handleInput("U");
					});
				},
				async confirm() { return true; },
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-a", installed: "1.0.0" }, { name: "pi-b", installed: "2.0.0" }]; },
			async updates() { return [{ name: "pi-a", installed: "1.0.0", latest: "1.1.0" }]; },
			async security() { return { mutationApproval: "always" as const }; },
			async update() { return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		// A frame captured mid-update: the updating row carries an inline bar
		// (progress glyphs + "updating…"), and the OTHER, non-updating row is
		// still rendered in the same frame -- the list was never replaced.
		const midUpdate = renderedFrames.find((frame) => frame.includes("updating…"));
		expect(midUpdate).toBeDefined();
		expect(midUpdate).toContain("pi-a");
		expect(midUpdate).toContain("pi-b");
		expect(midUpdate).toMatch(/[\u2588\u2591]/); // the bar's own filled/empty glyphs
		expect(renderedFrames.every((frame) => !frame.includes("Updating packages"))).toBe(true); // no separate full-screen swap
	});

	it("U runs the installer inline on the same overlay and closes once the batch actually changed something", async () => {
		// U is handled entirely inside renderPanel's own component now -- no
		// second ctx.ui.custom call for progress. Simulate the real keypress
		// on the real returned component instead of scripting a canned action.
		let customCallCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const component = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("U");
					});
				},
				async confirm() { return true; },
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const updated: string[] = [];
		const natives = {
			async installed() { return [{ name: "pi-a", installed: "1.0.0" }]; },
			async updates() { return [{ name: "pi-a", installed: "1.0.0", latest: "1.1.0" }]; },
			async security() { return { mutationApproval: "always" as const }; },
			async update(source: string) { updated.push(source); return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(updated).toEqual(["npm:pi-a"]);
		expect(customCallCount).toBe(1); // one overlay throughout: list -> installer -> closed
	});

	it("U refreshes rows in place and stays open on the same overlay when nothing actually changed", async () => {
		let customCallCount = 0;
		const updateCalls: string[] = [];
		let renderRequests = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const component = factory({ requestRender() { renderRequests += 1; } }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("U");
						// after the inline update settles (nothing changed, back in list mode), press esc to close
						setTimeout(() => component.handleInput("\x1b"), 0);
					});
				},
				async confirm() { return true; },
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-a", installed: "1.0.0" }]; },
			async updates() { return [{ name: "pi-a", installed: "1.0.0", latest: "1.1.0" }]; },
			async security() { return { mutationApproval: "always" as const }; },
			async update(source: string) { updateCalls.push(source); return { output: "", reloadRequired: false, alreadyUpToDate: true, pinned: false }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(updateCalls).toEqual(["npm:pi-a"]); // the installer genuinely ran
		expect(customCallCount).toBe(1); // never reopened a second overlay -- ran inline, returned to the list, closed on esc
		expect(renderRequests).toBeGreaterThan(0); // switched into and back out of installer mode, not a silent no-op
	});

	it("dispatches config to showResourceConfig, scoped to the selected row, then returns to the same panel", async () => {
		let customCallCount = 0;
		let listResourcesCalled = false;
		const ctx = {
			hasUI: true,
			ui: {
				async custom() {
					customCallCount += 1;
					// 1st: packages panel -> "config". 2nd: showResourceConfig's own panel -> close. 3rd: packages panel reopened -> close.
					if (customCallCount === 1) return { type: "config", row };
					if (customCallCount === 2) return { type: "close" };
					return undefined;
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return []; },
			async updates() { return []; },
			async listResources() { listResourcesCalled = true; return { global: [], project: [] }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(listResourcesCalled).toBe(true);
		expect(customCallCount).toBe(3);
	});

	it("dispatches find to showDiscoverPanel, then returns to the same panel when nothing was installed", async () => {
		let customCallCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom() {
					customCallCount += 1;
					// 1st: packages panel -> "find". 2nd: showDiscoverPanel's own panel -> close. 3rd: packages panel reopened -> close.
					if (customCallCount === 1) return { type: "find" };
					if (customCallCount === 2) return { type: "close" };
					return undefined;
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return []; },
			async updates() { return []; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(customCallCount).toBe(3);
	});

	it("dispatches disable and returns without reopening once toggling something actually reloaded", async () => {
		let customCallCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom() { customCallCount += 1; return { type: "disable", row }; },
				async confirm() { return true; },
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const toggled: string[] = [];
		const natives = {
			async installed() { return []; },
			async updates() { return []; },
			async security() { return { mutationApproval: "always" as const }; },
			async listResources() { return { global: [{ source: "npm:pi-lsp", name: "pi-lsp", scope: "global" as const, extensions: [{ path: "extension/index.ts", enabled: true }], skills: [], prompts: [], themes: [] }], project: [] }; },
			async toggleResource(_s: string, _f: string, path: string) { toggled.push(path); return "ok"; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(toggled).toEqual(["extension/index.ts"]);
		expect(customCallCount).toBe(1);
	});
});

describe("applyPackageChoice (/packed panel mutation + reload honesty)", () => {
	it("warns inline before running, in the same confirm dialog every other mutation surface shares", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;

		await applyPackageChoice("Update to 1.1.0", row, natives, fakeCtx(true, notices, reloads));

		expect(notices.some((n) => n.startsWith("confirm:") && n.includes("will likely require a Pi reload"))).toBe(true);
	});

	it("does not reload when the honest reloadRequired signal says nothing changed (pinned or already latest)", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { return { output: "", reloadRequired: false, alreadyUpToDate: true, pinned: false, currentVersion: "1.0.0" }; },
		} as unknown as Natives;

		const outcome = await applyPackageChoice("Update to 1.1.0", row, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("unchanged");
		expect(reloads.count).toBe(0);
		expect(notices.join("\n")).toContain("already up to date at 1.0.0");
	});

	it("reloads exactly once after a genuine update, using reloadRequired instead of always reloading", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false, previousVersion: "1.0.0", currentVersion: "1.1.0" }; },
		} as unknown as Natives;

		const outcome = await applyPackageChoice("Update to 1.1.0", row, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("changed");
		expect(reloads.count).toBe(1);
		expect(notices.join("\n")).toContain("Updated pi-lsp (1.0.0 → 1.1.0)");
	});

	it("reloads after a successful remove and says so, unlike before where remove never mentioned reload at all", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		let removed = 0;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async remove(name: string) { expect(name).toBe("pi-lsp"); removed += 1; return ""; },
		} as unknown as Natives;

		const outcome = await applyPackageChoice("Remove", row, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("changed");
		expect(removed).toBe(1);
		expect(reloads.count).toBe(1);
		expect(notices.some((n) => n.includes("Removed pi-lsp") && n.includes("reloading"))).toBe(true);
	});

	it("never mutates or reloads when the pre-confirmation is declined", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		let called = 0;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { called += 1; return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
			async remove() { called += 1; return ""; },
		} as unknown as Natives;

		const updateOutcome = await applyPackageChoice("Update to 1.1.0", row, natives, fakeCtx(false, notices, reloads));
		const removeOutcome = await applyPackageChoice("Remove", row, natives, fakeCtx(false, notices, reloads));

		expect(updateOutcome).toBe("cancelled");
		expect(removeOutcome).toBe("cancelled");
		expect(called).toBe(0);
		expect(reloads.count).toBe(0);
	});

	it("treats Cancel as a no-op that neither mutates nor reloads", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {} as Natives;

		const outcome = await applyPackageChoice("Cancel", row, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("cancelled");
		expect(reloads.count).toBe(0);
	});
});

describe("applyUpdateAll (U -- one combined approval and one reload, not N)", () => {
	const outdated: Row[] = [
		{ name: "pi-a", version: "1.0.0", latest: "1.1.0", hasUpdate: true },
		{ name: "pi-b", version: "2.0.0", latest: "2.1.0", hasUpdate: true },
		{ name: "pi-c", version: "3.0.0", hasUpdate: false },
	];

	it("does nothing and never confirms when nothing is outdated", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		let confirmCalled = false;
		const natives = { async security() { return { mutationApproval: "always" as const }; } } as unknown as Natives;
		const ctx = { hasUI: true, ui: { async confirm() { confirmCalled = true; return true; }, notify(m: string) { notices.push(m); } }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll([{ name: "pi-c", version: "1.0.0", hasUpdate: false }], natives, ctx);

		expect(outcome).toBe("unchanged");
		expect(confirmCalled).toBe(false);
		expect(reloads.count).toBe(0);
	});

	it("confirms once for every outdated package, updates each, and reloads exactly once", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const confirmMessages: string[] = [];
		const updated: string[] = [];
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update(source: string) { updated.push(source); return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;
		const ctx = {
			hasUI: true,
			ui: { async confirm(_t: string, message: string) { confirmMessages.push(message); return true; }, notify(m: string) { notices.push(m); }, custom: autoResolvingCustom() },
			async reload() { reloads.count += 1; },
		} as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll(outdated, natives, ctx);

		expect(outcome).toBe("changed");
		expect(confirmMessages).toHaveLength(1);
		expect(confirmMessages[0]).toContain("npm:pi-a");
		expect(confirmMessages[0]).toContain("npm:pi-b");
		expect(confirmMessages[0]).not.toContain("npm:pi-c"); // not outdated, never included
		expect(updated).toEqual(["npm:pi-a", "npm:pi-b"]);
		expect(reloads.count).toBe(1);
	});

	it("reports partial failure without losing the packages that did succeed", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update(source: string) {
				if (source === "npm:pi-a") throw new Error("registry unavailable");
				return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false };
			},
		} as unknown as Natives;
		const ctx = { hasUI: true, ui: { async confirm() { return true; }, notify(m: string) { notices.push(m); }, custom: autoResolvingCustom() }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll(outdated, natives, ctx);

		expect(outcome).toBe("changed");
		expect(reloads.count).toBe(1);
		expect(notices.some((n) => n.includes("pi-a") && n.includes("registry unavailable"))).toBe(true);
		expect(notices.some((n) => n.includes("1 failed"))).toBe(true);
	});

	it("never reloads when every update in the batch fails", async () => {
		const reloads = { count: 0 };
		const notices: string[] = [];
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { throw new Error("boom"); },
		} as unknown as Natives;
		const ctx = { hasUI: true, ui: { async confirm() { return true; }, notify(m: string) { notices.push(m); }, custom: autoResolvingCustom() }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll(outdated, natives, ctx);

		expect(outcome).toBe("cancelled");
		expect(reloads.count).toBe(0);
	});

	it("never mutates or reloads when the combined approval is declined", async () => {
		const reloads = { count: 0 };
		let updateCalled = false;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { updateCalled = true; return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;
		const ctx = { hasUI: true, ui: { async confirm() { return false; }, notify() {} }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll(outdated, natives, ctx);

		expect(outcome).toBe("cancelled");
		expect(updateCalled).toBe(false);
		expect(reloads.count).toBe(0);
	});

	it("renders a real progress bar that advances label and value across the batch, not one static line", async () => {
		let renderCount = 0;
		let component: { render(width: number): string[] } | undefined;
		const renders: string[][] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async confirm() { return true; },
				notify() {},
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[] }) {
					return new Promise((resolve) => {
						const tui = { requestRender() { renderCount += 1; if (component) renders.push(component.render(60)); } };
						component = factory(tui, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
					});
				},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;

		await applyUpdateAll(outdated, natives, ctx);

		expect(renderCount).toBeGreaterThanOrEqual(4); // 2 outdated rows, at least a before/after render each -- a real animation, not one frame
		const rendered = renders.map((lines) => lines.join("\n"));
		expect(rendered.some((text) => text.includes("pi-a"))).toBe(true);
		expect(rendered.some((text) => text.includes("pi-b"))).toBe(true);
		expect(renders.at(-1)?.some((line) => line.includes("100%"))).toBe(true); // finishes at the bar's max
	});
});

describe("applyDisableExtensions (d -- toggles this package's own extensions on or off)", () => {
	function resourceGroup(overrides: Partial<PackageResources> = {}): PackageResources {
		return { source: "npm:pi-lsp", name: "pi-lsp", scope: "global", extensions: [], skills: [], prompts: [], themes: [], ...overrides };
	}

	it("reports nothing to disable when the package declares no extensions", async () => {
		const natives = { async listResources() { return { global: [resourceGroup()], project: [] }; } } as unknown as Natives;
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify(m: string) { notices.push(m); } } } as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("unchanged");
		expect(notices.some((n) => n.includes("no extensions"))).toBe(true);
	});

	it("disables every currently-enabled extension, confirms once per item, and reloads once", async () => {
		const toggled: Array<{ path: string; enabled: boolean }> = [];
		const natives = {
			async listResources() {
				return { global: [resourceGroup({ extensions: [{ path: "extension/index.ts", enabled: true }] })], project: [] };
			},
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource(_source: string, _field: string, path: string, enabled: boolean) { toggled.push({ path, enabled }); return "ok"; },
		} as unknown as Natives;
		const notices: string[] = [];
		const reloads = { count: 0 };
		const ctx = { hasUI: true, ui: { async confirm() { return true; }, notify(m: string) { notices.push(m); } }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("changed");
		expect(toggled).toEqual([{ path: "extension/index.ts", enabled: false }]);
		expect(reloads.count).toBe(1);
		expect(notices.some((n) => n.includes("Disabled"))).toBe(true);
	});

	it("re-enables every currently-disabled extension when all are already off", async () => {
		const toggled: Array<{ path: string; enabled: boolean }> = [];
		const natives = {
			async listResources() {
				return { global: [resourceGroup({ extensions: [{ path: "extension/index.ts", enabled: false }] })], project: [] };
			},
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource(_source: string, _field: string, path: string, enabled: boolean) { toggled.push({ path, enabled }); return "ok"; },
		} as unknown as Natives;
		const reloads = { count: 0 };
		const ctx = { hasUI: true, ui: { async confirm() { return true; }, notify() {} }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("changed");
		expect(toggled).toEqual([{ path: "extension/index.ts", enabled: true }]);
	});

	it("never mutates or reloads when the per-item confirmation is declined", async () => {
		const natives = {
			async listResources() {
				return { global: [resourceGroup({ extensions: [{ path: "extension/index.ts", enabled: true }] })], project: [] };
			},
			async security() { return { mutationApproval: "always" as const }; },
		} as unknown as Natives;
		const reloads = { count: 0 };
		const ctx = { hasUI: true, ui: { async confirm() { return false; }, notify() {} }, async reload() { reloads.count += 1; } } as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("cancelled");
		expect(reloads.count).toBe(0);
	});

	it("is unaffected by an unrelated package with no matching resource group", async () => {
		const natives = { async listResources() { return { global: [], project: [] }; } } as unknown as Natives;
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify(m: string) { notices.push(m); } } } as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("unchanged");
		expect(notices.some((n) => n.includes("no extensions"))).toBe(true);
	});
});
