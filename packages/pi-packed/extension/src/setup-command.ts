import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Natives } from "./packed.js";

interface SetupCommandArgs {
	action: "plan" | "apply";
	path: string;
	prune: boolean;
}

function parseSetupCommand(args: string, cwd: string): SetupCommandArgs | undefined {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts[0] !== "setup" || (parts[1] !== "plan" && parts[1] !== "apply")) return undefined;
	const prune = parts.includes("--prune");
	const path = parts.slice(2).find((part) => !part.startsWith("--")) ?? "pi-setup.json";
	return { action: parts[1], path: resolve(cwd, path), prune };
}

export async function handleSetupCommand(
	args: string,
	ctx: ExtensionCommandContext,
	natives: Pick<Natives, "setupPlan" | "setupApply">,
): Promise<boolean> {
	const parsed = parseSetupCommand(args, ctx.cwd);
	if (!parsed) return false;
	if (!ctx.hasUI) return true;
	const plan = await natives.setupPlan(parsed.path, parsed.prune);
	if (!plan.ok) {
		ctx.ui.notify(plan.diagnostics[0]?.message ?? "Setup manifest is invalid", "error");
		return true;
	}
	if (parsed.action === "plan") {
		const suffix = parsed.prune ? " with prune" : "";
		ctx.ui.notify(`${plan.operations.length} setup operation(s)${suffix}`, "info");
		return true;
	}
	if (plan.operations.length === 0) {
		ctx.ui.notify("Setup already matches", "info");
		return true;
	}
	const packageChanges = plan.operations.filter((operation) => operation.kind.includes("package")).length;
	const confirmed = await ctx.ui.confirm(
		"Apply Pi setup?",
		`Apply ${plan.operations.length} operation(s)${parsed.prune ? ", including prune removals" : ""}. ${packageChanges} package operation(s) may execute package code.`,
	);
	if (!confirmed) return true;
	const result = await natives.setupApply(parsed.path, true, parsed.prune);
	if (!result.ok) {
		ctx.ui.notify(result.diagnostics[0]?.message ?? "Setup apply failed", "error");
		return true;
	}
	if (result.reloadRequired) {
		await ctx.reload();
		return true;
	}
	ctx.ui.notify(`Applied ${result.operations.length} setup operation(s)`, "info");
	return true;
}
