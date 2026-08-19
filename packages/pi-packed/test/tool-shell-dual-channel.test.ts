/**
 * Adopts @danypops/vehicle-conformance's dual-channel matrix against pi-packed's own real
 * production rendering path (renderPackageToolResult/renderPackageToolCall/
 * parsePackageToolDetails) -- pi-packed's own bespoke design (doc 4e9e08c1, Finding 2) was already
 * well-built by hand (explicit discriminated PackageToolDetails.kind branches, fail-closed to
 * contentFallback on parse failure) but had never been proven against the shared ecosystem
 * contract until now.
 */
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import {
	createInfoDetails,
	createMutationDetails,
	createSearchDetails,
	renderPackageToolCall,
	renderPackageToolResult,
} from "../extension/src/tool-output.ts";
import type { PackageInfo } from "../service/src/public/protocol.ts";
import { realTheme as theme } from "./support/real-theme.ts";

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
