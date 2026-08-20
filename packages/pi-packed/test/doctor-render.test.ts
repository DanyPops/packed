/**
 * createDoctorRunRenderResult regression coverage -- doctor.run's real output shape (five array
 * fields, several with nested arrays/objects per row: duplicateDependencies' own locations
 * array, extensions' own registrations object, heterogeneous key sets across rows) defeated
 * every heuristic in vehicle-client-pi's generic shape-probing chain and fell all the way
 * through to a raw JSON.stringify dump -- a real, live incident.
 *
 * Mirrors the REAL dispatch, not just the pure formatter: registerVehicleTools' own createTool()
 * projects and PERSISTS a generic vehicle.tool-details/v1 presentation for every real invocation
 * unless the operation supplies a full renderers.renderResult override (see tool-creation.ts's
 * own presentationProjector selection) -- a first version of this fix wired the presenter as
 * renderPresenters instead, which never overrides an already-successful projected presentation,
 * and the raw JSON view kept rendering unchanged even after release. Building details exactly the
 * way createTool's own default GENERIC_PRESENTATION_PROJECTOR would (both `output` AND a real
 * projected `presentation`) is what actually catches that gap.
 */
import { describe, expect, it } from "bun:test";
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import { projectGenericVehiclePresentation } from "@danypops/vehicle-client-pi/vehicle-render-model";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { createDoctorRunRenderResult } from "../extension/src/doctor-render.ts";
import { realTheme } from "./support/real-theme.ts";

const DESCRIPTOR = {
	name: "doctor.run",
	version: 1,
	description: "Runs diagnostic health checks.",
	effect: "read",
	permissions: [],
	idempotency: { mode: "safe" },
} as unknown as VehicleOperationDescriptor;

const REALISTIC_REPORT: DoctorReport = {
	ok: false,
	conflicts: [],
	extensions: [
		{
			name: "@scope/pi-a",
			source: "npm:@scope/pi-a",
			scope: "global",
			extension: "index.ts",
			status: "ok",
			registrations: {
				tools: ["a"],
				commands: [],
				shortcuts: [],
				flags: [],
				sharedTools: [],
				sharedCommands: [],
				sharedShortcuts: [],
				sharedFlags: [],
				providers: [],
				events: [],
				renderers: [],
			},
		},
		{
			name: "@scope/pi-b",
			source: "npm:@scope/pi-b",
			scope: "global",
			extension: "src/index.ts",
			status: "crash",
			registrations: {
				tools: [],
				commands: [],
				shortcuts: [],
				flags: [],
				sharedTools: [],
				sharedCommands: [],
				sharedShortcuts: [],
				sharedFlags: [],
				providers: [],
				events: [],
				renderers: [],
			},
			message: "Cannot find package 'left-pad'",
		},
	],
	scanned: 2,
	truncated: false,
	serviceUnits: [
		{
			code: "SERVICE_STALE_CODE",
			severity: "warning",
			package: "@scope/b",
			unitName: "b",
			message: "b's process started before its own package.json was last written",
		},
	],
	duplicateDependencies: [
		{
			name: "@scope/shared",
			locations: [
				{ path: "/a/node_modules/@scope/shared", version: "1.0.0" },
				{ path: "/b/node_modules/@scope/shared", version: "1.0.1" },
			],
		},
	],
	moduleFreshness: Array.from({ length: 15 }, (_, index) => ({
		name: `@scope/module-${index}`,
		loadedVersion: "1.0.0",
		currentVersion: "1.0.1",
		stale: true,
	})),
};

/** Builds `details` exactly the way createTool's own default GENERIC_PRESENTATION_PROJECTOR
 * would for a real invocation with no renderers/presentations override at all -- both `output`
 * AND a real projected `presentation`, since that's the actual persisted shape a raw DoctorReport
 * output produces without this fix (a generic "json"-view presentation). */
function realisticDetails(output: unknown): { output: unknown; presentation: unknown } {
	return { output, presentation: projectGenericVehiclePresentation(output) };
}

function renderResult(details: unknown, options: { expanded: boolean; isPartial?: boolean }, isError = false): string[] {
	const renderResultFn = createDoctorRunRenderResult(DESCRIPTOR);
	const result = { content: [{ type: "text" as const, text: "irrelevant" }], details };
	const component = renderResultFn(result, { expanded: options.expanded, isPartial: options.isPartial ?? false }, realTheme, {
		isError,
	} as Parameters<typeof renderResultFn>[3]);
	return component.render(100);
}

describe("createDoctorRunRenderResult", () => {
	it("renders the curated formatDoctorReport text, not the generic renderer's raw JSON dump, even though a real invocation also persists a projected presentation", () => {
		const lines = renderResult(realisticDetails(REALISTIC_REPORT), { expanded: true }).join("\n");
		// The exact raw-JSON-fallback shape this incident produced -- must never appear again.
		expect(lines).not.toContain('"conflicts"');
		expect(lines).not.toContain('"duplicateDependencies"');
		expect(lines).not.toContain("omitted before persistence");
		// formatDoctorReport's own curated markers, proving the real formatter rendered.
		expect(lines).toContain("FAIL");
		expect(lines).toContain("CRASH");
		expect(lines).toContain("SERVICE_STALE_CODE");
		expect(lines).toContain("DUPLICATE_DEPENDENCY_VERSION");
		expect(lines).toContain("STALE_MODULE_CACHE");
	});

	it("falls back to the shared generic renderer for a shape that isn't a real DoctorReport (e.g. a historical session row)", () => {
		const lines = renderResult(realisticDetails({ unrelated: true }), { expanded: true }).join("\n");
		// The generic renderer's own flat-record heuristic curates this trivial shape into a
		// humanized field line -- proof the fallback delegated to it, not proof of raw JSON.
		expect(lines).toContain("Unrelated");
		expect(lines).not.toContain("FAIL");
	});

	it("falls back to the shared generic renderer for an error result, never the curated presenter", () => {
		const lines = renderResult(realisticDetails(REALISTIC_REPORT), { expanded: true }, true).join("\n");
		expect(lines).not.toContain("DUPLICATE_DEPENDENCY_VERSION");
	});

	it("collapses by default and expands fully when options.expanded is set", () => {
		const collapsed = renderResult(realisticDetails(REALISTIC_REPORT), { expanded: false });
		const expanded = renderResult(realisticDetails(REALISTIC_REPORT), { expanded: true });
		expect(collapsed.length).toBeLessThan(expanded.length);
	});
});
