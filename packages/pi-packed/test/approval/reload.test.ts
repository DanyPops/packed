import { describe, expect, it } from "bun:test";
import { confirmReload, type ReloadConfirmContext, reloadWarning, targetsPackedItself } from "../../extension/src/approval/reload.ts";

describe("reloadWarning (shared pre-confirmation wording)", () => {
	it("warns remove as a definite reload, install/update as a likely one", () => {
		expect(reloadWarning("remove")).toContain("will require a Pi reload");
		expect(reloadWarning("install")).toContain("will likely require a Pi reload");
		expect(reloadWarning("update")).toContain("will likely require a Pi reload");
	});

	it("escalates to restart wording for Packed's own package -- plain /reload provably cannot fix this (confirmed live)", () => {
		for (const operation of ["install", "update", "remove"] as const) {
			const warning = reloadWarning(operation, { restartRequired: true });
			expect(warning).toContain("restart");
			expect(warning).toContain("exit and relaunch");
			expect(warning).toContain("not just /reload");
		}
	});
});

describe("targetsPackedItself", () => {
	it("matches Packed's own npm package, pinned or not, with or without the npm: scheme", () => {
		expect(targetsPackedItself("npm:@danypops/pi-packed")).toBe(true);
		expect(targetsPackedItself("npm:@danypops/pi-packed@0.21.14")).toBe(true);
		expect(targetsPackedItself("@danypops/pi-packed")).toBe(true);
		expect(targetsPackedItself("@danypops/pi-packed@1.0.0")).toBe(true);
	});

	it("never matches an unrelated, scoped-but-different, or non-npm source", () => {
		expect(targetsPackedItself("npm:pi-lsp")).toBe(false);
		expect(targetsPackedItself("npm:@danypops/other-package")).toBe(false);
		expect(targetsPackedItself("git:https://github.com/example/repo.git")).toBe(false);
		expect(targetsPackedItself("git:git@github.com:example/repo.git")).toBe(false);
		expect(targetsPackedItself("https://example.test/pkg.tgz")).toBe(false);
	});
});

describe("confirmReload (the second, post-mutation reload gate -- separate from reloadWarning's pre-hoc wording)", () => {
	it("asks the user once reload is actually known to be needed, not just predicted", async () => {
		const messages: string[] = [];
		const ctx: ReloadConfirmContext = {
			hasUI: true,
			ui: {
				async confirm(title, message) {
					messages.push(`${title}: ${message}`);
					return true;
				},
			},
		};

		const result = await confirmReload(ctx);

		expect(result).toBe(true);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("Reload Pi now?");
	});

	it("asks to restart, not reload, when Packed's own code is the target -- /reload cannot fix this", async () => {
		const messages: string[] = [];
		const ctx: ReloadConfirmContext = {
			hasUI: true,
			ui: {
				async confirm(title, message) {
					messages.push(`${title}: ${message}`);
					return true;
				},
			},
		};

		const result = await confirmReload(ctx, { restartRequired: true });

		expect(result).toBe(true);
		expect(messages[0]).toContain("Restart Pi now?");
		expect(messages[0]).toContain("exit and relaunch");
	});

	it("returns false, deferring, when the user declines", async () => {
		const ctx: ReloadConfirmContext = {
			hasUI: true,
			ui: {
				async confirm() {
					return false;
				},
			},
		};

		expect(await confirmReload(ctx)).toBe(false);
	});

	it("reloads immediately without asking in a non-interactive context -- there is no one to ask", async () => {
		let confirmCalled = false;
		const ctx: ReloadConfirmContext = {
			hasUI: false,
			ui: {
				async confirm() {
					confirmCalled = true;
					return false;
				},
			},
		};

		expect(await confirmReload(ctx)).toBe(true);
		expect(confirmCalled).toBe(false);
	});
});
