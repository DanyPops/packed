/** Agent-facing package tools over the authenticated daemon. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { packagePermissionDecision, type PackageOperation } from "./permission.js";
import type { Natives } from "./packed.js";
import { reloadWarning } from "./reload.js";
import {
	createInfoDetails,
	createModelContent,
	createMutationDetails,
	createSearchDetails,
	renderPackageToolCall,
	renderPackageToolResult,
	type PackageToolDetails,
} from "./tool-output.js";

function text(value: string, details: PackageToolDetails) {
	return { content: [{ type: "text" as const, text: createModelContent(value).text }], details };
}

type ApprovalContext = {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
};

export async function approvePackageOperation(
	operation: PackageOperation,
	command: string,
	natives: Pick<Natives, "security">,
	ctx: ApprovalContext,
): Promise<{ allowed: boolean; approved: boolean; reason?: "cancelled" | "denied"; message?: string }> {
	const settings = await natives.security();
	const decision = packagePermissionDecision(settings, operation);
	if (!decision.approvalRequired) return { allowed: true, approved: false };
	if (!ctx.hasUI) {
		return {
			allowed: false,
			approved: false,
			reason: "denied",
			message: `${operation} requires interactive approval; change mutationApproval in /packed only to deliberately opt out.`,
		};
	}
	const approved = await ctx.ui.confirm(
		`${operation[0]!.toUpperCase()}${operation.slice(1)} Pi package`,
		`Run: ${command}\n\nThis operation can execute package code or mutate Pi settings/install roots. ${reloadWarning(operation)} Continue?`,
	);
	return approved ? { allowed: true, approved: true } : { allowed: false, approved: false, reason: "cancelled", message: `${operation} cancelled by user.` };
}

export async function installPackageWithPolicy(
	source: string,
	natives: Pick<Natives, "security" | "install">,
	ctx: ApprovalContext,
) {
	const approval = await approvePackageOperation("install", `pi install ${source}`, natives, ctx);
	if (!approval.allowed) {
		const output = approval.message ?? "install denied";
		return text(output, createMutationDetails("install", source, approval.reason ?? "denied", output));
	}
	const output = await natives.install(source, approval.approved) || `Installed ${source}. Reload with /reload to activate.`;
	return text(output, createMutationDetails("install", source, "succeeded", output));
}

export async function updatePackageWithPolicy(
	source: string,
	natives: Pick<Natives, "security" | "update">,
	ctx: ApprovalContext,
) {
	const approval = await approvePackageOperation("update", `pi update --extension ${source}`, natives, ctx);
	if (!approval.allowed) {
		const output = approval.message ?? "update denied";
		return text(output, createMutationDetails("update", source, approval.reason ?? "denied", output));
	}
	const outcome = await natives.update(source, approval.approved);
	if (outcome.alreadyUpToDate) {
		const version = outcome.currentVersion ?? outcome.previousVersion;
		const reason = outcome.pinned
			? `pinned to ${version ?? "an exact version"} -- pi update intentionally leaves pinned packages unchanged; reinstall with a different (or no) version to move off the pin`
			: `already up to date${version ? ` at ${version}` : ""}`;
		const message = `${source} is ${reason}.`;
		return text(message, createMutationDetails("update", source, "succeeded", outcome.output || message, false));
	}
	const transition = outcome.previousVersion && outcome.currentVersion ? ` (${outcome.previousVersion} → ${outcome.currentVersion})` : "";
	const message = `${outcome.output || `Updated ${source}.`}${transition} Reload with /reload to activate.`;
	return text(message, createMutationDetails("update", source, "succeeded", outcome.output || message, true));
}

export async function removePackageWithPolicy(
	name: string,
	natives: Pick<Natives, "security" | "remove">,
	ctx: ApprovalContext,
) {
	const approval = await approvePackageOperation("remove", `pi remove npm:${name}`, natives, ctx);
	if (!approval.allowed) {
		const output = approval.message ?? "remove denied";
		return text(output, createMutationDetails("remove", name, approval.reason ?? "denied", output));
	}
	const output = await natives.remove(name, approval.approved) || `Removed ${name}. Reload with /reload to deactivate.`;
	return text(output, createMutationDetails("remove", name, "succeeded", output));
}

export function registerTools(pi: ExtensionAPI, natives: Natives): void {
	pi.registerTool({
		name: "pkg_search",
		label: "Pi Package Search",
		description: "Search Pi packages on npm. Bounded read operation; defaults to 10 results and caps at 50.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms, e.g. 'lsp' or 'telegram'" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
		}),
		renderCall(args, theme) { return renderPackageToolCall("Search packages", args, theme); },
		renderResult(result, options, theme, context) { return renderPackageToolResult(result, options, theme, context); },
		async execute(_id, params) {
			try {
				const response = await natives.search(params.query, params.limit ?? 10);
				const details = createSearchDetails(params.query, response.total, response.results);
				if (response.results.length === 0) return text(`No Pi packages found for "${params.query}".`, details);
				const lines = response.results.map((pkg, index) => `${index + 1}. ${pkg.name}@${pkg.version}\n   ${pkg.description ?? ""}`);
				return text(`Found ${response.total} pi package(s) (showing ${response.results.length}):\n\n${lines.join("\n")}`, details);
			} catch (error) {
				throw new Error(`pkg_search failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_info",
		label: "Pi Package Info",
		description: "Show bounded metadata and declared Pi resources for one package.",
		parameters: Type.Object({ name: Type.String({ description: "npm package name" }) }),
		renderCall(args, theme) { return renderPackageToolCall("Package info", args, theme); },
		renderResult(result, options, theme, context) { return renderPackageToolResult(result, options, theme, context); },
		async execute(_id, params) {
			try {
				const info = await natives.info(params.name);
				const lines = [
					`${info.name}@${info.version}`,
					info.description ?? "",
					info.repository ? `repo: ${info.repository}` : "",
					info.license ? `license: ${info.license}` : "",
					info.pi ? `provides: ${Object.keys(info.pi).join(", ")}` : "",
					info.unpackedSize ? `size: ${(info.unpackedSize / 1024).toFixed(0)} KB` : "",
					info.modified ? `modified: ${info.modified}` : "",
				].filter(Boolean);
				return text(lines.join("\n"), createInfoDetails(info));
			} catch (error) {
				throw new Error(`pkg_info failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_install",
		label: "Pi Package Install",
		description: "Install a Pi package through the authenticated daemon. Operation-aware approval is secure by default.",
		parameters: Type.Object({ source: Type.String({ description: "npm:, git:, or https source" }) }),
		renderCall(args, theme) { return renderPackageToolCall("Install package", args, theme); },
		renderResult(result, options, theme, context) { return renderPackageToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return installPackageWithPolicy(params.source, natives, ctx);
		},
	});

	pi.registerTool({
		name: "pkg_update",
		label: "Pi Package Update",
		description: "Update one configured Pi package through Pi's documented update command. Operation-aware approval is secure by default.",
		parameters: Type.Object({ source: Type.String({ description: "configured npm:, git:, or https source" }) }),
		renderCall(args, theme) { return renderPackageToolCall("Update package", args, theme); },
		renderResult(result, options, theme, context) { return renderPackageToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return updatePackageWithPolicy(params.source, natives, ctx);
		},
	});

	pi.registerTool({
		name: "pkg_remove",
		label: "Pi Package Remove",
		description: "Remove an installed npm Pi package through the authenticated daemon. Operation-aware approval is secure by default.",
		parameters: Type.Object({ name: Type.String({ description: "bare npm name, e.g. pi-lsp or @scope/pkg" }) }),
		renderCall(args, theme) { return renderPackageToolCall("Remove package", args, theme); },
		renderResult(result, options, theme, context) { return renderPackageToolResult(result, options, theme, context); },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return removePackageWithPolicy(params.name, natives, ctx);
		},
	});
}
