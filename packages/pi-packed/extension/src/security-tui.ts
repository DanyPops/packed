import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SecuritySettings } from "@danypops/packed/protocol";
type MutationApproval = SecuritySettings["mutationApproval"];
import type { Natives } from "./packed.ts";

const OPTIONS: Array<{ value: MutationApproval; label: string }> = [
	{ value: "always", label: "Always require mutation approval (recommended)" },
	{ value: "never", label: "Never require mutation approval (unsafe opt-out)" },
];

export async function showPackedSettings(ctx: ExtensionCommandContext, natives: Natives): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/packed requires interactive mode", "warning");
		return;
	}
	try {
		const current = await natives.security();
		const choice = await ctx.ui.select(
			`Package mutation approval · current: ${current.mutationApproval}`,
			[...OPTIONS.map(({ label }) => label), "Cancel"],
		);
		const selected = OPTIONS.find(({ label }) => label === choice);
		if (!selected || selected.value === current.mutationApproval) return;
		const approved = await ctx.ui.confirm(
			"Change package mutation approval",
			selected.value === "never"
				? "Disable confirmation for install, update, remove, and package security changes? Packages can execute arbitrary code."
				: "Restore confirmation for install, update, remove, and package security changes?",
		);
		if (!approved) return;
		const updated = await natives.setMutationApproval(selected.value, true);
		ctx.ui.notify(
			updated.mutationApproval === "always"
				? "Package mutations now require confirmation."
				: "Package mutation confirmation disabled. Packages can execute arbitrary code.",
			updated.mutationApproval === "always" ? "info" : "warning",
		);
	} catch (error) {
		ctx.ui.notify(`packed security settings failed: ${error instanceof Error ? error.message : error}`, "error");
	}
}
