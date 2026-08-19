/**
 * renderDoctorRunResult regression coverage -- doctor.run's real output shape (five array
 * fields, several with nested arrays/objects per row: duplicateDependencies' own locations
 * array, extensions' own registrations object, heterogeneous key sets across rows) defeated
 * every heuristic in vehicle-client-pi's generic shape-probing chain and fell all the way
 * through to a raw JSON.stringify dump -- a real, live incident. This asserts the curated
 * presenter actually claims that shape and renders formatDoctorReport's own text, not JSON.
 */
import { describe, expect, it } from "bun:test";
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import { renderDoctorRunResult } from "../extension/src/doctor-render.ts";
import { realTheme } from "./support/real-theme.ts";

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
			registrations: { tools: ["a"], commands: [], shortcuts: [], flags: [], providers: [], events: [], renderers: [] },
		},
		{
			name: "@scope/pi-b",
			source: "npm:@scope/pi-b",
			scope: "global",
			extension: "src/index.ts",
			status: "crash",
			registrations: { tools: [], commands: [], shortcuts: [], flags: [], providers: [], events: [], renderers: [] },
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

describe("renderDoctorRunResult", () => {
	it("claims a real DoctorReport shape instead of falling through to the generic renderer's raw JSON dump", () => {
		const component = renderDoctorRunResult(REALISTIC_REPORT, { expanded: true, isPartial: false }, realTheme);
		expect(component).toBeDefined();
		const lines = component!.render(100).join("\n");
		// The exact raw-JSON-fallback shape this incident produced -- must never appear again.
		expect(lines).not.toContain('"conflicts"');
		expect(lines).not.toContain('"duplicateDependencies"');
		// formatDoctorReport's own curated markers, proving the real formatter rendered.
		expect(lines).toContain("FAIL");
		expect(lines).toContain("CRASH");
		expect(lines).toContain("SERVICE_STALE_CODE");
		expect(lines).toContain("DUPLICATE_DEPENDENCY_VERSION");
		expect(lines).toContain("STALE_MODULE_CACHE");
	});

	it("returns undefined (falls through to the generic renderer) for a shape that isn't a DoctorReport", () => {
		expect(renderDoctorRunResult({ unrelated: true }, { expanded: false, isPartial: false }, realTheme)).toBeUndefined();
		expect(renderDoctorRunResult("a plain string", { expanded: false, isPartial: false }, realTheme)).toBeUndefined();
		expect(renderDoctorRunResult(null, { expanded: false, isPartial: false }, realTheme)).toBeUndefined();
	});

	it("collapses by default and expands fully when options.expanded is set", () => {
		const collapsed = renderDoctorRunResult(REALISTIC_REPORT, { expanded: false, isPartial: false }, realTheme);
		const expanded = renderDoctorRunResult(REALISTIC_REPORT, { expanded: true, isPartial: false }, realTheme);
		expect(collapsed!.render(100).length).toBeLessThan(expanded!.render(100).length);
	});
});
