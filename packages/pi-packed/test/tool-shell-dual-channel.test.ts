/**
 * Adopts @danypops/vehicle-conformance's dual-channel matrix against pi-packed's own real
 * production rendering path (renderPackageToolResult/renderPackageToolCall/
 * parsePackageToolDetails) -- pi-packed's own bespoke design (doc 4e9e08c1, Finding 2) was already
 * well-built by hand (explicit discriminated PackageToolDetails.kind branches, fail-closed to
 * contentFallback on parse failure) but had never been proven against the shared ecosystem
 * contract until now.
 */
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	createInfoDetails,
	createMutationDetails,
	createSearchDetails,
	renderPackageToolCall,
	renderPackageToolResult,
} from "../extension/src/tool-output.ts";
import type { PackageInfo } from "../service/src/public/protocol.ts";

// A real Theme emitting real ANSI SGR escapes -- required because the conformance suite's own
// physical-line-width assertion strips real ANSI via a CSI regex before counting visible width.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const theme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

function render(details: unknown, contentText: string, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }): string[] {
	const result = { content: [{ type: "text" as const, text: contentText }], details };
	return renderPackageToolResult(result, { expanded: options.expanded, isPartial: options.partial ?? false }, theme, {
		isPartial: options.partial ?? false,
	}).render(options.width);
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-packed",
	async create() {
		const subject = {
			bounds: { modelContentBytes: 2_000, presentationDetailsBytes: 32_000 },
			execute: async () => {
				const details = createSearchDetails("query", 1, [{ name: "PRESENTATION_ONLY-pkg", version: "1.0.0", description: "d" }]);
				return { content: "MODEL_ONLY: semantic result", details };
			},
			render: (snapshot: { content: string; details: unknown }, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }) =>
				render(snapshot.details, snapshot.content, options),
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
				render(details, fallbackContent, { ...options, expanded: false }),
			renderCall: (args: unknown, width: 40 | 80 | 120) =>
				renderPackageToolCall("Search Pi extensions", args as Record<string, unknown>, theme).render(width),
			invalidProjection: async () => {
				// parsePackageToolDetails's own real guard (`JSON.stringify(value).length > ...`)
				// throws for a cyclic value before its own try/catch swallows it and fails closed to
				// undefined -- this reproduces that exact real exception, the production analog of
				// "the documented projector exception policy" for a consumer with no separate
				// projector at all (details ARE the discriminated union directly).
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				JSON.stringify(cyclic);
			},
			// One representative real payload per PackageToolDetails.kind -- proves the real
			// discriminated-union renderer differentiates all 3 declared kinds instead of collapsing
			// into an undifferentiated raw-JSON dump (the pi-web-spider bug class, generalized).
			declaredValueCases: [
				{
					value: "search",
					rawPayload: createSearchDetails("query", 1, [{ name: "example-pkg", version: "1.0.0", description: "An example." }]),
				},
				{
					value: "info",
					rawPayload: createInfoDetails({
						name: "example-pkg",
						version: "1.0.0",
						description: "An example.",
						keywords: ["pi-package"],
						pi: { extensions: ["./src/index.ts"] },
					} satisfies PackageInfo),
				},
				{
					value: "mutation",
					rawPayload: createMutationDetails("install", "example-pkg", "succeeded", "Installed example-pkg@1.0.0"),
				},
			],
			renderDeclaredValue: (_value: string, rawPayload: unknown, options: { width: 40 | 80 | 120; expanded: boolean }) =>
				render(rawPayload, "MODEL_ONLY", options),
		};
		return { subject, cleanup: () => Promise.resolve() };
	},
};

runToolShellDualChannelConformance(fixture);
