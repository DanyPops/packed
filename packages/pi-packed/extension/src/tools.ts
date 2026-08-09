/** Agent-facing package tools over the authenticated daemon. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type PackageOperation, packagePermissionDecision } from "./approval/permission.js";
import { reloadWarning, targetsPackedItself } from "./approval/reload.js";
import { InstallServiceError, type Natives, PI_COMMAND_NAME } from "./packed.js";
import {
	createInfoDetails,
	createModelContent,
	createMutationDetails,
	createSearchDetails,
	type PackageToolDetails,
	renderPackageToolCall,
	renderPackageToolResult,
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
	// True only for a source/name that resolves to Packed's own npm package -- see
	// targetsPackedItself(). Every caller below computes this from the exact string it's
	// about to mutate, so the warning always reflects the real target.
	restartRequired = false,
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
		`Run: ${command}\n\nThis operation can execute package code or mutate Pi settings/install roots. ${reloadWarning(operation, { restartRequired })} Continue?`,
	);
	return approved
		? { allowed: true, approved: true }
		: { allowed: false, approved: false, reason: "cancelled", message: `${operation} cancelled by user.` };
}

export async function installPackageWithPolicy(
	source: string,
	natives: Pick<Natives, "security" | "install" | "installService">,
	ctx: ApprovalContext,
) {
	const restartRequired = targetsPackedItself(source);
	const approval = await approvePackageOperation("install", `pi install ${source}`, natives, ctx, restartRequired);
	if (!approval.allowed) {
		const output = approval.message ?? "install denied";
		return text(output, createMutationDetails("install", source, approval.reason ?? "denied", output));
	}
	const activateNote = restartRequired
		? "Restart Pi (exit and relaunch) to activate -- Packed's own running code can't hot-reload itself."
		: "Reload with /reload to activate.";
	let output = (await natives.install(source, approval.approved)) || `Installed ${source}. ${activateNote}`;
	// Piggybacks on the same approval already granted for install -- both are
	// the same code-execution mutation tier, not a new consent surface. Silent
	// for the overwhelmingly common case (most Pi packages aren't daemons at
	// all); a genuine failure is reported without failing the install itself,
	// which already succeeded.
	if (source.startsWith("npm:")) {
		try {
			const svc = await natives.installService(source, approval.approved);
			output += `\n${svc.output}`;
		} catch (e) {
			if (!(e instanceof InstallServiceError) || !e.notADaemon) {
				const message = e instanceof Error ? e.message : String(e);
				output += `\nnote: detected a persistent-service daemon but could not register it: ${message}`;
			}
		}
	}
	return text(output, createMutationDetails("install", source, "succeeded", output));
}

export async function updatePackageWithPolicy(source: string, natives: Pick<Natives, "security" | "update">, ctx: ApprovalContext) {
	const restartRequired = targetsPackedItself(source);
	const approval = await approvePackageOperation("update", `pi update --extension ${source}`, natives, ctx, restartRequired);
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
		const outOfRangeNote = outcome.outOfRangeUpdateAvailable
			? ` A newer version, ${outcome.outOfRangeUpdateAvailable}, exists outside the declared range -- widen it to update.`
			: "";
		const message = `${source} is ${reason}.${outOfRangeNote}`;
		return text(message, createMutationDetails("update", source, "succeeded", outcome.output || message, false));
	}
	const transition = outcome.previousVersion && outcome.currentVersion ? ` (${outcome.previousVersion} → ${outcome.currentVersion})` : "";
	const activateNote = restartRequired
		? "Restart Pi (exit and relaunch) to activate -- Packed's own running code can't hot-reload itself."
		: "Reload with /reload to activate.";
	const message = `${outcome.output || `Updated ${source}.`}${transition} ${activateNote}`;
	return text(message, createMutationDetails("update", source, "succeeded", outcome.output || message, true));
}

export async function removePackageWithPolicy(name: string, natives: Pick<Natives, "security" | "remove">, ctx: ApprovalContext) {
	const restartRequired = targetsPackedItself(name);
	const approval = await approvePackageOperation("remove", `pi remove npm:${name}`, natives, ctx, restartRequired);
	if (!approval.allowed) {
		const output = approval.message ?? "remove denied";
		return text(output, createMutationDetails("remove", name, approval.reason ?? "denied", output));
	}
	const deactivateNote = restartRequired
		? "Restart Pi (exit and relaunch) to deactivate -- Packed's own running code can't hot-reload itself."
		: "Reload with /reload to deactivate.";
	const output = (await natives.remove(name, approval.approved)) || `Removed ${name}. ${deactivateNote}`;
	return text(output, createMutationDetails("remove", name, "succeeded", output));
}

export function registerTools(pi: ExtensionAPI, natives: Natives): void {
	pi.registerTool({
		name: "pkg_search",
		label: "Pi Extension Search",
		description:
			"Find Pi extensions -- npm packages that add tools, skills, prompt templates, or themes to the Pi coding agent -- by keyword. This is NOT a general-purpose npm/software search: it only makes sense for 'is there a Pi extension for X' questions (e.g. an LSP integration, a Telegram tool, a new theme). Matches are npm keyword-search candidates only, not yet confirmed to be real Pi extensions -- use pkg_info on a result to verify it actually declares Pi resources before installing. Bounded read operation; defaults to 10 results and caps at 50.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Keywords describing the Pi extension/capability you want, e.g. 'lsp' or 'telegram' -- not a generic npm package search",
			}),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
		}),
		renderCall(args, theme) {
			return renderPackageToolCall("Search Pi extensions", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPackageToolResult(result, options, theme, context);
		},
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
		label: "Pi Extension Info",
		description: `Show bounded metadata and declared Pi resources (extensions, skills, prompts, themes) for one Pi extension package -- the way to confirm a pkg_search hit is a genuine Pi extension, not just a coincidental keyword match, before installing it. Special case: querying ${PI_COMMAND_NAME} (Pi itself) also reports the locally running version against the latest published release -- a different question from, and in addition to, the generic npm registry metadata every other package gets.`,
		parameters: Type.Object({ name: Type.String({ description: "npm package name of the Pi extension (or 'pi' itself)" }) }),
		renderCall(args, theme) {
			return renderPackageToolCall("Pi extension info", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPackageToolResult(result, options, theme, context);
		},
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
				// Special-cased by package identity, not by any change in risk
				// profile -- still a pure read, just answering a second, genuinely
				// different question (what's actually running here, not what npm
				// last published) that the generic registry lookup above cannot.
				if (params.name === PI_COMMAND_NAME) {
					const status = await natives.piStatus().catch(() => undefined);
					if (status?.current) {
						const comparison =
							status.latest === undefined
								? "latest release unknown"
								: status.upToDate === false
									? `behind -- latest is ${status.latest}, run pi update --self`
									: `up to date with the latest ${status.latest}`;
						lines.push(`--- Pi runtime (not npm registry data) ---`, `currently running: ${status.current}`, comparison);
					}
				}
				return text(lines.join("\n"), createInfoDetails(info));
			} catch (error) {
				throw new Error(`pkg_info failed: ${error instanceof Error ? error.message : error}`);
			}
		},
	});

	pi.registerTool({
		name: "pkg_install",
		label: "Pi Extension Install",
		description:
			"Install a Pi extension (a package that adds tools, skills, prompt templates, or a theme to the Pi coding agent) through the authenticated daemon. Not for installing arbitrary software/npm packages unrelated to Pi. Operation-aware approval is secure by default.",
		parameters: Type.Object({ source: Type.String({ description: "npm:, git:, or https source of the Pi extension" }) }),
		renderCall(args, theme) {
			return renderPackageToolCall("Install Pi extension", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPackageToolResult(result, options, theme, context);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return installPackageWithPolicy(params.source, natives, ctx);
		},
	});

	pi.registerTool({
		name: "pkg_update",
		label: "Pi Extension Update",
		description:
			"Update one already-installed Pi extension through Pi's documented update command. Operation-aware approval is secure by default.",
		parameters: Type.Object({
			source: Type.String({ description: "configured npm:, git:, or https source of the installed Pi extension" }),
		}),
		renderCall(args, theme) {
			return renderPackageToolCall("Update Pi extension", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPackageToolResult(result, options, theme, context);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return updatePackageWithPolicy(params.source, natives, ctx);
		},
	});

	pi.registerTool({
		name: "pkg_remove",
		label: "Pi Extension Remove",
		description:
			"Remove an installed Pi extension (npm package) through the authenticated daemon. Operation-aware approval is secure by default.",
		parameters: Type.Object({
			name: Type.String({ description: "bare npm name of the installed Pi extension, e.g. pi-lsp or @scope/pkg" }),
		}),
		renderCall(args, theme) {
			return renderPackageToolCall("Remove Pi extension", args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderPackageToolResult(result, options, theme, context);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return removePackageWithPolicy(params.name, natives, ctx);
		},
	});
}
