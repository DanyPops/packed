import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showPackedSettings } from "../extension/src/security-tui.ts";
import type { Natives } from "../extension/src/packed.ts";

describe("/packed package permission settings", () => {
	it("requires confirmation before writing an explicit unsafe opt-out", async () => {
		let value: "always" | "never" = "always";
		let approved = false;
		const notices: string[] = [];
		const natives = {
			async security() { return { mutationApproval: value }; },
			async setMutationApproval(next: "always" | "never", confirmation: boolean) {
				approved = confirmation;
				value = next;
				return { mutationApproval: value };
			},
		} as Natives;
		const ctx = {
			hasUI: true,
			ui: {
				async select() { return "Never require mutation approval (unsafe opt-out)"; },
				async confirm(_title: string, message: string) { expect(message).toContain("install, update, remove"); return true; },
				notify(message: string) { notices.push(message); },
			},
		} as unknown as ExtensionCommandContext;

		await showPackedSettings(ctx, natives);

		expect(approved).toBe(true);
		expect(String(value)).toBe("never");
		expect(notices.join("\n")).toContain("mutation confirmation disabled");
	});
});
