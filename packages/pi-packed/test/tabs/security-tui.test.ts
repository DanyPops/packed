import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Natives } from "../../extension/src/packed.ts";
import type { TabHost } from "../../extension/src/tab-host.ts";
import { createSettingsTab } from "../../extension/src/tabs/security-tui.ts";

// SettingsTab's own header line uses rawKeyHint, which reads pi-coding-agent's
// global theme singleton directly -- a real Pi session always initializes
// this before extension code runs.
initTheme();

const THEME = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function fakeHost(confirm: boolean, notices: string[]): { host: TabHost; renders: number } {
	const state = { renders: 0 };
	const host: TabHost = {
		ctx: { ui: { notify: (m: string) => notices.push(m) } } as unknown as TabHost["ctx"],
		inlineCtx: {
			ui: {
				confirm: async (_t: string, message: string) => {
					notices.push(`confirm:${message}`);
					return confirm;
				},
			},
		} as unknown as TabHost["ctx"],
		inspectPackage: () => {},
		requestRender: () => {
			state.renders += 1;
		},
		onSessionReplaced: () => {},
	};
	return { host, renders: state.renders };
}

describe("SettingsTab (/packed's Settings tab -- a real Component, not Pi's native select/confirm)", () => {
	it("loads the current value and renders it as the marked option", async () => {
		const { host } = fakeHost(true, []);
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
		} as unknown as Natives;
		const tab = await createSettingsTab(natives, host, THEME);
		const text = tab.render(80).join("\n");
		expect(text).toContain("current: always");
		expect(text).toContain("Always require mutation approval");
	});

	it("requires confirmation before writing an explicit unsafe opt-out, rendered inline via host.inlineCtx", async () => {
		let value: "always" | "never" = "always";
		let approved = false;
		const notices: string[] = [];
		const { host } = fakeHost(true, notices);
		const natives = {
			async security() {
				return { mutationApproval: value };
			},
			async setMutationApproval(next: "always" | "never", confirmation: boolean) {
				approved = confirmation;
				value = next;
				return { mutationApproval: value };
			},
		} as unknown as Natives;
		const tab = await createSettingsTab(natives, host, THEME);

		tab.handleInput("\x1b[B"); // move to "never"
		tab.handleInput("\r"); // select
		await Promise.resolve(); // let the async apply() settle
		await Promise.resolve();

		expect(approved).toBe(true);
		expect(String(value)).toBe("never");
		expect(notices.some((n) => n.startsWith("confirm:") && n.includes("install, update, remove"))).toBe(true);
		expect(notices.some((n) => n.includes("mutation confirmation disabled"))).toBe(true);
	});

	it("never mutates when the confirmation is declined", async () => {
		let calls = 0;
		const { host } = fakeHost(false, []);
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async setMutationApproval() {
				calls += 1;
				return { mutationApproval: "never" as const };
			},
		} as unknown as Natives;
		const tab = await createSettingsTab(natives, host, THEME);

		tab.handleInput("\x1b[B");
		tab.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(calls).toBe(0);
	});

	it("selecting the already-current option is a no-op -- no confirm, no mutation", async () => {
		let confirmCalled = false;
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async setMutationApproval() {
				throw new Error("must not be called");
			},
		} as unknown as Natives;
		const host: TabHost = {
			ctx: { ui: { notify() {} } } as unknown as TabHost["ctx"],
			inlineCtx: {
				ui: {
					confirm: async () => {
						confirmCalled = true;
						return true;
					},
				},
			} as unknown as TabHost["ctx"],
			inspectPackage() {},
			requestRender() {},
			onSessionReplaced() {},
		};
		const tab = await createSettingsTab(natives, host, THEME);

		tab.handleInput("\r"); // already on "always", the current value

		expect(confirmCalled).toBe(false);
	});

	it("implements the Component interface, with no capturesEscape/capturesHorizontalArrows override", async () => {
		const { host } = fakeHost(true, []);
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
		} as unknown as Natives;
		const tab = await createSettingsTab(natives, host, THEME);
		expect(typeof tab.render).toBe("function");
		expect(typeof tab.handleInput).toBe("function");
		expect((tab as { capturesEscape?(): boolean }).capturesEscape).toBeUndefined();
		expect(() => tab.invalidate()).not.toThrow();
	});
});
