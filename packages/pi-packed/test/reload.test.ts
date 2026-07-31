import { describe, expect, it } from "bun:test";
import { confirmReload, reloadWarning, type ReloadConfirmContext } from "../extension/src/reload.ts";

describe("reloadWarning (shared pre-confirmation wording)", () => {
	it("warns remove as a definite reload, install/update as a likely one", () => {
		expect(reloadWarning("remove")).toContain("will require a Pi reload");
		expect(reloadWarning("install")).toContain("will likely require a Pi reload");
		expect(reloadWarning("update")).toContain("will likely require a Pi reload");
	});
});

describe("confirmReload (the second, post-mutation reload gate -- separate from reloadWarning's pre-hoc wording)", () => {
	it("asks the user once reload is actually known to be needed, not just predicted", async () => {
		const messages: string[] = [];
		const ctx: ReloadConfirmContext = { hasUI: true, ui: { async confirm(title, message) { messages.push(`${title}: ${message}`); return true; } } };

		const result = await confirmReload(ctx);

		expect(result).toBe(true);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("Reload Pi now?");
	});

	it("returns false, deferring, when the user declines", async () => {
		const ctx: ReloadConfirmContext = { hasUI: true, ui: { async confirm() { return false; } } };

		expect(await confirmReload(ctx)).toBe(false);
	});

	it("reloads immediately without asking in a non-interactive context -- there is no one to ask", async () => {
		let confirmCalled = false;
		const ctx: ReloadConfirmContext = { hasUI: false, ui: { async confirm() { confirmCalled = true; return false; } } };

		expect(await confirmReload(ctx)).toBe(true);
		expect(confirmCalled).toBe(false);
	});
});
