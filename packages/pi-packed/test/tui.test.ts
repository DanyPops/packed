import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { applyPackageChoice, showPackedPanel } from "../extension/src/tui.ts";
import type { Natives } from "../extension/src/packed.ts";
import type { Row } from "../extension/src/model.ts";

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
