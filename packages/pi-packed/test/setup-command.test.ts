import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleSetupCommand } from "../extension/src/setup-command.ts";

function fixture(options: { hasUI?: boolean; confirm?: boolean; reloadRequired?: boolean; planOperations?: any[] } = {}) {
	const calls: string[] = [];
	const notifications: string[] = [];
	const operations = options.planOperations ?? [
		{ kind: "install-package", packageName: "x", scope: "global", source: "npm:x@1", resolved: "1" },
	];
	const natives = {
		async setupPlan(path: string, prune?: boolean) {
			calls.push(`plan:${path}:${prune}`);
			return { ok: true, manifestPath: path, operations, diagnostics: [] };
		},
		async setupApply(path: string, approved?: boolean, prune?: boolean) {
			calls.push(`apply:${path}:${approved}:${prune}`);
			return { ok: true, manifestPath: path, operations: [], reloadRequired: options.reloadRequired ?? true, diagnostics: [] };
		},
	};
	const ctx = {
		cwd: "/work",
		hasUI: options.hasUI ?? true,
		ui: {
			async confirm() {
				calls.push("confirm");
				return options.confirm ?? true;
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
		async reload() {
			calls.push("reload");
		},
	} as unknown as ExtensionCommandContext;
	return { calls, notifications, natives, ctx };
}

describe("in-Pi setup command", () => {
	it("plans without confirmation or mutation", async () => {
		const f = fixture();
		expect(await handleSetupCommand("setup plan ./pi-setup.json --prune", f.ctx, f.natives)).toBe(true);
		expect(f.calls).toEqual(["plan:/work/pi-setup.json:true"]);
		expect(f.notifications[0]).toContain("with prune");
	});

	it("confirms exactly once, applies with daemon approval, then treats reload as terminal", async () => {
		const f = fixture({ reloadRequired: true });
		await handleSetupCommand("setup apply", f.ctx, f.natives);
		expect(f.calls).toEqual(["plan:/work/pi-setup.json:false", "confirm", "apply:/work/pi-setup.json:true:false", "reload"]);
		expect(f.notifications).toEqual([]);
	});

	it("does not apply after cancellation or without UI", async () => {
		const cancelled = fixture({ confirm: false });
		await handleSetupCommand("setup apply", cancelled.ctx, cancelled.natives);
		expect(cancelled.calls).toEqual(["plan:/work/pi-setup.json:false", "confirm"]);
		const headless = fixture({ hasUI: false });
		await handleSetupCommand("setup apply", headless.ctx, headless.natives);
		expect(headless.calls).toEqual([]);
	});

	it("does not reload for profile-only or already-converged applies", async () => {
		const profile = fixture({
			reloadRequired: false,
			planOperations: [{ kind: "write-profile", name: "work", scope: "global", fields: ["model"] }],
		});
		await handleSetupCommand("setup apply", profile.ctx, profile.natives);
		expect(profile.calls.at(-1)).toBe("apply:/work/pi-setup.json:true:false");
		expect(profile.notifications.at(-1)).toContain("Applied");
		const empty = fixture({ planOperations: [] });
		await handleSetupCommand("setup apply", empty.ctx, empty.natives);
		expect(empty.calls).toEqual(["plan:/work/pi-setup.json:false"]);
	});
});
