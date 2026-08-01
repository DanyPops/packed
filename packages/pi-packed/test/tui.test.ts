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

// A theme that wraps text in genuine ANSI SGR codes, the way every real pi
// theme does -- unlike the identity-passthrough fake theme (`fg: (_c, s) =>
// s`) every other test below uses, which cannot exercise any bug that only
// shows up once content actually contains escape sequences. Confirmed live:
// the panel's own border landed at a different column on every row because
// Envelope's default measure counts ANSI escape bytes as visible characters.
const ANSI_ORANGE = "\u001b[38;5;208m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;
const realishTheme = {
	fg: (_color: string, s: string) => `${ANSI_ORANGE}${s}${ANSI_RESET}`,
	bg: (_color: string, s: string) => `${ANSI_ORANGE}${s}${ANSI_RESET}`,
	bold: (s: string) => `${ANSI_BOLD}${s}${ANSI_RESET}`,
};
function stripAnsi(s: string): string {
	return s.replace(ANSI_ESCAPE_PATTERN, "");
}

// Every test below opens the real unified panel, which always constructs
// all four tabs up front -- Settings and Config both kick off their own
// async load() in the background regardless of which tab a test actually
// cares about, so every fake `natives` needs at least these two or the
// panel throws reaching for a method that was never mocked.
function baseNatives(overrides: Partial<Natives> = {}): Natives {
	return {
		async installed() { return []; },
		async updates() { return []; },
		async security() { return { mutationApproval: "always" as const }; },
		async listResources() { return { global: [], project: [] }; },
		...overrides,
	} as unknown as Natives;
}

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

/** Approves the mutation itself (1st confirm call) but declines the
 * separate, later confirmReload gate (every call after) -- the shape every
 * deferral test below needs, distinct from fakeCtx's single fixed answer. */
function fakeCtxDeferReload(notices: string[], reloads: { count: number }): ExtensionCommandContext {
	let calls = 0;
	return {
		hasUI: true,
		ui: {
			async confirm(_title: string, message: string) {
				calls += 1;
				notices.push(`confirm:${message}`);
				return calls === 1;
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
			factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
		});
}

describe("showPackedPanel (/packed folds packages + settings into one panel)", () => {
	it("s switches to the Settings tab inline, and Escape returns to Packages instead of closing -- one overlay throughout", async () => {
		// Real bug, diagnosed live: s used to open a genuinely separate screen
		// (Pi's own native ctx.ui.select/confirm) instead of staying on this
		// same floating panel. Simulate real keypresses on the real returned
		// component instead of scripting a canned dispatch action.
		let customCallCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						component.handleInput("s");
						setTimeout(() => {
							// Settings' own content is genuinely part of THIS SAME component's render output.
							expect(component.render(60).join("\n")).toContain("current: always");
							component.handleInput("\x1b"); // back to Packages, not close
							expect(component.render(60).join("\n")).toContain("No packages");
							component.handleInput("\x1b"); // close, now that Packages is the active tab
						}, 0);
					});
				},
				async select() { throw new Error("must not be called -- settings is a real inline tab now, not ctx.ui.select"); },
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives();

		await showPackedPanel(ctx, natives);

		expect(customCallCount).toBe(1); // one overlay throughout -- never closed and reopened for settings
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

	it("opens as a real overlay pinned to the top of the terminal, not floating around content", async () => {
		// anchor:"top-center"+offsetY:1 is a fixed row count regardless of
		// terminal size -- the header stays put and only the footer moves as
		// content height changes. A row-percentage position was tried instead
		// and reverted: it visibly jittered as tabs with different content
		// heights (Packages' table vs. Config's shorter list) became active.
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

		expect(capturedOptions).toMatchObject({ overlay: true, overlayOptions: { anchor: "top-center", offsetY: 1 } });
	});

	it("renders a real bordered box with rounded corners, not just a horizontal rule", async () => {
		let rendered: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[] }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
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

	it("renders the package list as a real column-aligned table (Malevich's Table), not ad hoc concatenated strings", async () => {
		let rendered: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[] }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						rendered = component.render(90);
						resolve(undefined);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() {
				return [
					{ name: "pi-lsp", installed: "1.0.0" },
					{ name: "@scope/pi-longer-package-name", installed: "0.3.12" },
				];
			},
			async updates() { return [{ name: "pi-lsp", installed: "1.0.0", latest: "1.1.0" }]; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		const text = rendered.join("\n");
		expect(text).toContain("Package"); // a real table header, not a bare list
		expect(text).toContain("Version");
		const nameLine = rendered.find((line) => line.includes("@scope/pi-longer-package-name"));
		const versionLine = rendered.find((line) => line.includes("pi-lsp") && line.includes("1.0.0"));
		expect(nameLine).toBeDefined();
		expect(versionLine).toBeDefined();
		// Real column alignment: the version cell starts at the same character
		// column on both rows regardless of how long each package name is --
		// impossible with the old `${cursor} ${name}@${version}` concatenation.
		const longNameVersionCol = nameLine!.indexOf("0.3.12");
		const shortNameVersionCol = versionLine!.indexOf("1.0.0");
		expect(longNameVersionCol).toBe(shortNameVersionCol);
	});

	it("keeps every rendered line at the exact same real (ANSI-stripped) width, under genuine theme styling, not a plain fake theme", async () => {
		// This is the actual regression test for a real, screenshot-reported
		// bug: every other test in this file uses an identity-passthrough fake
		// theme (`fg: (_c, s) => s`), which can never exercise a bug that only
		// shows up once content contains real ANSI escape codes -- exactly why
		// it shipped and was only caught by eye, not by any of these tests.
		let rendered: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[] }) {
					return new Promise((resolve) => {
						const component = factory({ requestRender() {} }, realishTheme, {}, resolve);
						rendered = component.render(90);
						resolve(undefined);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() {
				return [
					{ name: "pi-lsp", installed: "1.0.0" },
					{ name: "@scope/pi-longer-package-name", installed: "0.3.12" },
					{ name: "pi-x", installed: "10.20.30-beta.1" },
				];
			},
			async updates() { return [{ name: "pi-lsp", installed: "1.0.0", latest: "1.1.0" }]; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		const widths = new Set(rendered.map((line) => stripAnsi(line).length));
		expect(widths).toEqual(new Set([90])); // every line, every column -- not a mix of 60/75/90
	});

	it("renders the installer's own progress bar inline next to the updating row, without replacing the rest of the package list", async () => {
		const renderedFrames: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const tui = { requestRender() { renderedFrames.push(component.render(60).join("\n")); } };
						const component = factory(tui, theme, {}, resolve);
						component.handleInput("U");
						// approval dialog, then (once the batch genuinely changed something) the separate reload dialog -- both inline now.
						setTimeout(() => {
							component.handleInput("y");
							setTimeout(() => component.handleInput("y"), 0);
						}, 0);
					});
				},
				async confirm() { throw new Error("must not be called -- confirms route through the inline Dialog"); },
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

		// A frame captured mid-update: the updating row carries an inline
		// spinner (a real braille frame glyph + "updating…"), and the OTHER,
		// non-updating row is still rendered in the same frame -- the list was
		// never replaced.
		const midUpdate = renderedFrames.find((frame) => frame.includes("updating…"));
		expect(midUpdate).toBeDefined();
		expect(midUpdate).toContain("pi-a");
		expect(midUpdate).toContain("pi-b");
		expect(midUpdate).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // a real spinner frame, not a determinate bar
		// A later frame, once pi-a has settled: a genuine success glyph replaces the spinner.
		const settled = renderedFrames.find((frame) => frame.includes("✓"));
		expect(settled).toBeDefined();
		expect(settled).toContain("pi-a");
		expect(renderedFrames.every((frame) => !frame.includes("Updating packages"))).toBe(true); // no separate full-screen swap
	});

	it("settles a failed row with a real failure glyph and the actual captured error output, not just a toast", async () => {
		const renderedFrames: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const tui = { requestRender() { renderedFrames.push(component.render(60).join("\n")); } };
						const component = factory(tui, theme, {}, resolve);
						component.handleInput("U");
						// approval only -- a fully-failed batch (changed === 0) never reaches
						// the separate reload confirm at all. Then close once settled.
						setTimeout(() => {
							component.handleInput("y");
							setTimeout(() => component.handleInput("\x1b"), 0);
						}, 0);
					});
				},
				async confirm() { throw new Error("must not be called -- confirms route through the inline Dialog"); },
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-a", installed: "1.0.0" }]; },
			async updates() { return [{ name: "pi-a", installed: "1.0.0", latest: "1.1.0" }]; },
			async security() { return { mutationApproval: "always" as const }; },
			async update() { throw new Error("npm error 404 Not Found"); },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		const settled = renderedFrames.find((frame) => frame.includes("✗"));
		expect(settled).toBeDefined();
		expect(settled).toContain("pi-a");
		expect(settled).toContain("npm error 404 Not Found"); // the real captured error, not a generic "failed" label
		expect(renderedFrames.some((frame) => frame.includes("✓"))).toBe(false); // never a false success glyph
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
						const component = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("U");
						setTimeout(() => {
							component.handleInput("y"); // approval
							setTimeout(() => component.handleInput("y"), 0); // reload
						}, 0);
					});
				},
				async confirm() { throw new Error("must not be called -- confirms route through the inline Dialog"); },
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
						const component = factory({ requestRender() { renderRequests += 1; } }, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("U");
						// approval only -- nothing changed (changed === 0) never reaches the
						// separate reload confirm. Then, back in list mode, press esc to close.
						setTimeout(() => {
							component.handleInput("y");
							setTimeout(() => component.handleInput("\x1b"), 0);
						}, 0);
					});
				},
				async confirm() { throw new Error("must not be called -- confirms route through the inline Dialog"); },
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

	it("shows 'already up to date' inline on the row itself, not only as a scrollback toast -- real bug, screenshot-reported", async () => {
		// Confirmed live: pressing u on a row whose update call reports
		// alreadyUpToDate produces ONLY a ctx.ui.notify toast (scrollback) --
		// the panel's own rendered row gives zero indication anything happened,
		// unlike a genuine update or failure (both settle into a real ✓/✗
		// inline via the batch path's `settled` map, which runRowActionInline
		// never populates for single-row actions at all).
		const renderedFrames: string[] = [];
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const tui = { requestRender() { renderedFrames.push(component.render(70).join("\n")); } };
						const component = factory(tui, theme, {}, resolve);
						component.handleInput("u");
						// "unchanged" never closes the panel (matches the batch path's own
						// behavior) -- close it once settled, back in list mode.
						setTimeout(() => component.handleInput("\x1b"), 0);
					});
				},
				async confirm() { throw new Error("must not be called -- mutationApproval is never"); },
				notify(m: string) { notices.push(m); },
			},
			async reload() { throw new Error("must not reload -- nothing changed"); },
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-tickets", installed: "0.14.0" }]; },
			async updates() { return [{ name: "pi-tickets", installed: "0.14.0", latest: "0.9.4" }]; }, // stale mirror, but that's a separate bug
			async security() { return { mutationApproval: "never" as const }; },
			async update() { return { output: "", reloadRequired: false, alreadyUpToDate: true, pinned: false, currentVersion: "0.14.0" }; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		// The toast still fires (scrollback is fine for that) --
		expect(notices.some((n) => n.includes("already up to date at 0.14.0"))).toBe(true);
		// -- but the panel itself must ALSO show it inline, next to the row.
		const settledFrame = renderedFrames.find((frame) => frame.includes("pi-tickets") && frame.includes("already up to date"));
		expect(settledFrame).toBeDefined();
	});

	it("c switches to the Config tab inline, scoped to the selected row's cwd, then Escape returns to Packages -- one overlay throughout", async () => {
		let customCallCount = 0;
		let listResourcesCwd: string | undefined;
		const ctx = {
			hasUI: true,
			cwd: "/project",
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						expect(component.render(60).join("\n")).toContain("pi-lsp"); // Packages tab, already loaded
						component.handleInput("c");
						expect(component.render(60).join("\n")).toContain("Global Resources"); // now on the Config tab, same component
						component.handleInput("\x1b"); // back to Packages, not close
						expect(component.render(60).join("\n")).toContain("pi-lsp");
						component.handleInput("\x1b"); // close, now that Packages is the active tab
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives({
			async installed() { return [{ name: "pi-lsp", installed: "1.0.0" }]; },
			async listResources(projectRoot?: string) { listResourcesCwd = projectRoot; return { global: [], project: [] }; },
		});

		await showPackedPanel(ctx, natives);

		expect(listResourcesCwd).toBe("/project");
		expect(customCallCount).toBe(1); // one overlay throughout -- never closed and reopened for config
	});

	it("f switches to the Find tab inline, then Escape returns to Packages -- one overlay throughout", async () => {
		let customCallCount = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						component.handleInput("f");
						expect(component.render(60).join("\n")).toContain("Type a query and press enter to search npm"); // now on the Find tab
						component.handleInput("\x1b"); // back to Packages, not close
						expect(component.render(60).join("\n")).toContain("No packages");
						component.handleInput("\x1b"); // close, now that Packages is the active tab
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives();

		await showPackedPanel(ctx, natives);

		expect(customCallCount).toBe(1); // one overlay throughout -- never closed and reopened for find
	});

	it("Tab and Shift-Tab sweep between every menu, wrapping at both ends, same as Left/Right", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						expect(component.render(60).join("\n")).toContain("No packages"); // Packages, the default
						component.handleInput("\t"); // tab -> Find
						expect(component.render(60).join("\n")).toContain("Type a query and press enter to search npm");
						component.handleInput("\x1b[Z"); // shift+tab -> back to Packages
						expect(component.render(60).join("\n")).toContain("No packages");
						component.handleInput("\x1b[Z"); // shift+tab wraps backward -> Settings (the last tab)
						setTimeout(() => {
							expect(component.render(60).join("\n")).toContain("current: always");
							resolve(undefined);
						}, 0);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives();

		await showPackedPanel(ctx, natives);
	});

	it("Shift-Tab is recognized under xterm's modifyOtherKeys encoding too, not just the legacy CSI Z literal", async () => {
		// Real bug, reported live: Shift-Tab "isn't working". Root cause: CSI Z
		// (\x1b[Z) is only ONE possible encoding for Shift-Tab -- terminals using
		// xterm's modifyOtherKeys mode (CSI 27 ; modifier ; keycode ~) or the
		// Kitty keyboard protocol send a completely different sequence for the
		// same keypress. A hardcoded literal comparison silently misses whichever
		// encoding it isn't pinned to; matchesKey() from pi-tui recognizes all of
		// them. "\x1b[27;2;9~" is modifyOtherKeys' own encoding for shift+tab
		// (modifier 2 = shift, keycode 9 = tab).
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						expect(component.render(60).join("\n")).toContain("No packages"); // Packages, the default
						component.handleInput("\x1b[27;2;9~"); // modifyOtherKeys shift+tab -> wraps backward to Settings
						setTimeout(() => {
							expect(component.render(60).join("\n")).toContain("current: always");
							resolve(undefined);
						}, 0);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives();

		await showPackedPanel(ctx, natives);
	});

	it("a tab's own first-letter mnemonic (p/f/c/s) jumps to it from any OTHER non-Packages tab", async () => {
		// From Config (idle, not filtering) -- a tab whose capturesMnemonics()
		// isn't unconditionally true -- "s" jumps straight to Settings.
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						component.handleInput("c"); // Packages' own c -> Config, scoped to the selected row
						expect(component.render(60).join("\n")).toContain("Global Resources");
						component.handleInput("s"); // Config -> Settings via the generic host-level mnemonic
						setTimeout(() => {
							expect(component.render(60).join("\n")).toContain("current: always");
							resolve(undefined);
						}, 0);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives({ async installed() { return [{ name: "pi-lsp", installed: "1.0.0" }]; } });

		await showPackedPanel(ctx, natives);
	});

	it("never steals a letter as a mnemonic while Config is mid-filter, or while Find's query box is focused (always true there)", async () => {
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);

						// Config's own filter box: typing "s" while filtering must not jump.
						component.handleInput("c");
						component.handleInput("/"); // start filtering
						component.handleInput("s");
						expect(component.render(60).join("\n")).not.toContain("current: always"); // did NOT jump to Settings
						component.handleInput("\x1b"); // clear the filter, still on Config

						// Find's query box: every letter is always query text, never a mnemonic.
						component.handleInput("\x1b"); // back to Packages
						component.handleInput("f");
						component.handleInput("s");
						component.handleInput("e");
						expect(component.render(60).join("\n")).toContain("se"); // typed into the query box
						expect(component.render(60).join("\n")).not.toContain("current: always"); // did NOT jump to Settings
						resolve(undefined);
					});
				},
				notify() {},
			},
		} as unknown as ExtensionCommandContext;
		const natives = baseNatives({ async installed() { return [{ name: "pi-lsp", installed: "1.0.0" }]; } });

		await showPackedPanel(ctx, natives);
	});

	it("renders its approval and reload confirms as an inline Dialog on this SAME overlay, dispatched by literal y/n keys -- never a separate ctx.ui.confirm", async () => {
		// mutationApproval "never" skips the approval step entirely, leaving
		// confirmReload as the one dialog to interact with -- isolates the
		// exact behavior a real user reported: ctx.ui.confirm opened as its
		// own distinct overlay ("a new window"), arrow-select only, no y/n.
		let nativeConfirmCalled = false;
		let customCallCount = 0;
		let removed = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
						const component = factory({ requestRender() {} }, theme, {}, resolve);
						component.handleInput("x");
						setTimeout(() => {
							// the inline dialog is genuinely part of THIS SAME component's own render output.
							expect(component.render(60).join("\n")).toContain("Reload Pi now?");
							component.handleInput("y");
						}, 0);
					});
				},
				async confirm() { nativeConfirmCalled = true; return true; }, // must never be reached
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-lsp", installed: "1.0.0" }]; },
			async updates() { return []; },
			async security() { return { mutationApproval: "never" as const }; },
			async remove(name: string) { expect(name).toBe("pi-lsp"); removed += 1; return ""; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(removed).toBe(1);
		expect(nativeConfirmCalled).toBe(false); // routed inline, never the native dialog
		expect(customCallCount).toBe(1); // one overlay throughout -- never closed and reopened
	});

	it("d disables extensions inline via its own approval+reload dialogs, closing this same overlay once it actually reloaded", async () => {
		let customCallCount = 0;
		const toggled: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const component = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("d");
						setTimeout(() => {
							component.handleInput("y"); // per-item toggle approval
							setTimeout(() => component.handleInput("y"), 0); // reload confirm
						}, 0);
					});
				},
				notify() {},
			},
			async reload() {},
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { return [{ name: "pi-lsp", installed: "1.0.0" }]; },
			async updates() { return []; },
			async security() { return { mutationApproval: "always" as const }; },
			async listResources() { return { global: [{ source: "npm:pi-lsp", name: "pi-lsp", scope: "global" as const, extensions: [{ path: "extension/index.ts", enabled: true }], skills: [], prompts: [], themes: [] }], project: [] }; },
			async toggleResource(_s: string, _f: string, path: string) { toggled.push(path); return "ok"; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(toggled).toEqual(["extension/index.ts"]);
		expect(customCallCount).toBe(1); // one overlay throughout -- confirms rendered inline, not stacked
	});

	it("refreshes rows and stays open (never reopens) when a toggle's reload is deferred rather than declined outright", async () => {
		let customCallCount = 0;
		let installedCalls = 0;
		const ctx = {
			hasUI: true,
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => { handleInput(data: string): void }) {
					customCallCount += 1;
					return new Promise((resolve) => {
						const component = factory({ requestRender() {} }, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
						component.handleInput("d");
						setTimeout(() => {
							component.handleInput("y"); // per-item toggle approval
							setTimeout(() => {
								component.handleInput("n"); // reload gate -- decline, defer
								setTimeout(() => component.handleInput("\x1b"), 0); // close once settled, back in list mode
							}, 0);
						}, 0);
					});
				},
				notify() {},
			},
			async reload() { throw new Error("must not reload -- this test defers"); },
		} as unknown as ExtensionCommandContext;
		const natives = {
			async installed() { installedCalls += 1; return [{ name: "pi-lsp", installed: "1.0.0" }]; },
			async updates() { return []; },
			async security() { return { mutationApproval: "always" as const }; },
			async listResources() { return { global: [{ source: "npm:pi-lsp", name: "pi-lsp", scope: "global" as const, extensions: [{ path: "extension/index.ts", enabled: true }], skills: [], prompts: [], themes: [] }], project: [] }; },
			async toggleResource() { return "ok"; },
		} as unknown as Natives;

		await showPackedPanel(ctx, natives);

		expect(customCallCount).toBe(1); // never reopened a second overlay -- stayed on the same one throughout
		expect(installedCalls).toBe(2); // initial load + the deferred-outcome refresh
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

	it("defers the reload on update when the separate reload prompt is declined, without losing the update itself", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		let updateCalled = false;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update() { updateCalled = true; return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false, previousVersion: "1.0.0", currentVersion: "1.1.0" }; },
		} as unknown as Natives;

		const outcome = await applyPackageChoice("Update to 1.1.0", row, natives, fakeCtxDeferReload(notices, reloads));

		expect(outcome).toBe("deferred");
		expect(updateCalled).toBe(true); // the update itself still genuinely ran
		expect(reloads.count).toBe(0); // but reload was declined
		expect(notices.some((n) => n.includes("Updated pi-lsp") && n.includes("reload pending"))).toBe(true);
	});

	it("defers the reload on remove when the separate reload prompt is declined, without losing the removal itself", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		let removed = 0;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async remove() { removed += 1; return ""; },
		} as unknown as Natives;

		const outcome = await applyPackageChoice("Remove", row, natives, fakeCtxDeferReload(notices, reloads));

		expect(outcome).toBe("deferred");
		expect(removed).toBe(1); // the removal itself still genuinely ran
		expect(reloads.count).toBe(0);
		expect(notices.some((n) => n.includes("Removed pi-lsp") && n.includes("reload pending"))).toBe(true);
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
		// Two distinct confirm dialogs, not one: the batch mutation approval
		// (still collapsed to a single dialog for the whole batch, not N), then
		// confirmReload's separate post-mutation reload gate.
		expect(confirmMessages).toHaveLength(2);
		expect(confirmMessages[0]).toContain("npm:pi-a");
		expect(confirmMessages[0]).toContain("npm:pi-b");
		expect(confirmMessages[0]).not.toContain("npm:pi-c"); // not outdated, never included
		expect(confirmMessages[1]).toContain("only takes effect after a reload");
		expect(updated).toEqual(["npm:pi-a", "npm:pi-b"]);
		expect(reloads.count).toBe(1);
	});

	it("defers the reload when the user approves the update but declines the separate reload prompt, without losing the update itself", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const updated: string[] = [];
		let confirmCalls = 0;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async update(source: string) { updated.push(source); return { output: "", reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
		} as unknown as Natives;
		const ctx = {
			hasUI: true,
			ui: {
				// 1st call: mutation approval (yes). 2nd call: reload gate (no, defer).
				async confirm() { confirmCalls += 1; return confirmCalls === 1; },
				notify(m: string) { notices.push(m); },
				custom: autoResolvingCustom(),
			},
			async reload() { reloads.count += 1; },
		} as unknown as ExtensionCommandContext;

		const outcome = await applyUpdateAll(outdated, natives, ctx);

		expect(outcome).toBe("deferred");
		expect(updated).toEqual(["npm:pi-a", "npm:pi-b"]); // the update itself still genuinely ran
		expect(reloads.count).toBe(0); // but reload was declined
		expect(notices.some((n) => n.includes("reload pending"))).toBe(true);
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

	it("renders a real spinner across the batch and settles both rows with genuine success glyphs, not one static line", async () => {
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
						component = factory(tui, { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
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
		// Finishes with both rows settled (real success glyphs), not a bar at 100%.
		const last = renders.at(-1)?.join("\n") ?? "";
		expect(last).toContain("✓ pi-a");
		expect(last).toContain("✓ pi-b");
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

	it("defers the reload when the separate reload prompt is declined, without losing the toggle itself", async () => {
		const toggled: Array<{ path: string; enabled: boolean }> = [];
		const notices: string[] = [];
		const reloads = { count: 0 };
		let confirmCalls = 0;
		const natives = {
			async listResources() {
				return { global: [resourceGroup({ extensions: [{ path: "extension/index.ts", enabled: true }] })], project: [] };
			},
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource(_source: string, _field: string, path: string, enabled: boolean) { toggled.push({ path, enabled }); return "ok"; },
		} as unknown as Natives;
		const ctx = {
			hasUI: true,
			// 1st call: per-item toggle approval (yes). 2nd call: reload gate (no, defer).
			ui: { async confirm() { confirmCalls += 1; return confirmCalls === 1; }, notify(m: string) { notices.push(m); } },
			async reload() { reloads.count += 1; },
		} as unknown as ExtensionCommandContext;

		const outcome = await applyDisableExtensions(row, natives, ctx);

		expect(outcome).toBe("deferred");
		expect(toggled).toEqual([{ path: "extension/index.ts", enabled: false }]); // the toggle itself still genuinely ran
		expect(reloads.count).toBe(0);
		expect(notices.some((n) => n.includes("Disabled") && n.includes("reload pending"))).toBe(true);
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
