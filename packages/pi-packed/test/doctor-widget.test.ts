import { describe, expect, it } from "bun:test";
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { buildDoctorWidgetProjection, renderDoctorWidgetLines } from "../extension/src/doctor-widget.ts";

const theme = { fg: (_color: string, text: string) => text } as { fg(color: string, text: string): string };

function baseReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
	return {
		ok: true,
		conflicts: [],
		extensions: [],
		scanned: 9,
		truncated: false,
		serviceUnits: [],
		duplicateDependencies: [],
		...overrides,
	};
}

function rotation(pageSize: number, totalRows: number, now: () => number = () => 0): AutoRotatingWindow {
	return new AutoRotatingWindow({ totalRows, pageSize, intervalMs: 1000, now });
}

describe("buildDoctorWidgetProjection", () => {
	it("reports zero issues for a clean report", () => {
		expect(buildDoctorWidgetProjection(baseReport())).toEqual({ issues: [], total: 0 });
	});

	it("surfaces a conflict as one issue", () => {
		const report = baseReport({
			ok: false,
			conflicts: [
				{ kind: "tool", name: "metrics_query", claimants: [{ name: "a", source: "npm:a", scope: "global", extension: "index.ts" }] },
			],
		});
		const projection = buildDoctorWidgetProjection(report);
		expect(projection.total).toBe(1);
		expect(projection.issues[0]?.label).toContain("metrics_query");
	});

	it("surfaces a crashed extension as one issue, but never an 'ok' extension", () => {
		const report = baseReport({
			extensions: [
				{ name: "good", source: "npm:good", scope: "global", extension: "index.ts", status: "ok", registrations: {} as never },
				{
					name: "bad",
					source: "npm:bad",
					scope: "global",
					extension: "index.ts",
					status: "crash",
					registrations: {} as never,
					message: "Cannot find module 'x'",
				},
			],
		});
		const projection = buildDoctorWidgetProjection(report);
		expect(projection.total).toBe(1);
		expect(projection.issues[0]?.label).toContain("bad");
		expect(projection.issues[0]?.label).toContain("Cannot find module 'x'");
	});

	it("surfaces a stale service unit as one issue", () => {
		const report = baseReport({
			serviceUnits: [
				{
					code: "SERVICE_STALE_CODE",
					severity: "warning",
					package: "@danypops/pi-papyrus",
					unitName: "papyrus",
					message: "pid 123 is stale",
				},
			],
		});
		const projection = buildDoctorWidgetProjection(report);
		expect(projection.total).toBe(1);
		expect(projection.issues[0]?.label).toContain("papyrus");
		expect(projection.issues[0]?.label).toContain("pid 123 is stale");
	});

	it("surfaces a stale module cache entry as one issue, but never a fresh one", () => {
		const report = baseReport({
			moduleFreshness: [
				{ name: "fresh-pkg", loadedVersion: "1.0.0", currentVersion: "1.0.0", stale: false },
				{ name: "stale-pkg", loadedVersion: "1.0.0", currentVersion: "1.1.0", stale: true },
			],
		});
		const projection = buildDoctorWidgetProjection(report);
		expect(projection.total).toBe(1);
		expect(projection.issues[0]?.label).toContain("stale-pkg");
	});

	it("never surfaces duplicateDependencies as issues -- matches doctor.run's own 'ok' computation, which also excludes them", () => {
		const report = baseReport({
			duplicateDependencies: [
				{
					name: "@danypops/vehicle-core",
					locations: [
						{ path: "/a", version: "1.0.0" },
						{ path: "/b", version: "1.0.1" },
					],
				},
			],
		});
		expect(buildDoctorWidgetProjection(report).total).toBe(0);
	});
});

describe("renderDoctorWidgetLines", () => {
	it("returns no lines at all (hides the widget) when there are zero issues", () => {
		const lines = renderDoctorWidgetLines(theme, buildDoctorWidgetProjection(baseReport()), 80);
		expect(lines).toEqual([]);
	});

	it("renders a bordered card naming the owning Vehicle, the widget, and the issue count, plus one line per issue", () => {
		const report = baseReport({
			ok: false,
			serviceUnits: [
				{ code: "SERVICE_STALE_CODE", severity: "warning", package: "@danypops/pi-papyrus", unitName: "papyrus", message: "stale" },
			],
		});
		const lines = renderDoctorWidgetLines(theme, buildDoctorWidgetProjection(report), 80);
		expect(lines[0]).toContain("Packed · Doctor · 1 issue");
		expect(lines[0]).toContain("╭");
		expect(lines[lines.length - 1]).toContain("╰");
		expect(lines).toHaveLength(3); // top border, 1 issue row, bottom border
	});

	it("pluralizes the issue count correctly", () => {
		const report = baseReport({
			serviceUnits: [
				{ code: "SERVICE_STALE_CODE", severity: "warning", package: "a", unitName: "a", message: "x" },
				{ code: "SERVICE_STALE_CODE", severity: "warning", package: "b", unitName: "b", message: "y" },
			],
		});
		const lines = renderDoctorWidgetLines(theme, buildDoctorWidgetProjection(report), 80);
		expect(lines[0]).toContain("2 issues");
	});

	it("never produces a line wider than the given width", () => {
		const report = baseReport({
			serviceUnits: [
				{ code: "SERVICE_STALE_CODE", severity: "warning", package: "x".repeat(200), unitName: "x", message: "y".repeat(200) },
			],
		});
		const projection = buildDoctorWidgetProjection(report);
		for (const width of [40, 80, 120]) {
			for (const line of renderDoctorWidgetLines(theme, projection, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	describe("auto-rotating overflow hint", () => {
		it("never shows a page hint when every issue already fits on one page", () => {
			const report = baseReport({
				serviceUnits: [{ code: "SERVICE_STALE_CODE", severity: "warning", package: "a", unitName: "a", message: "x" }],
			});
			const lines = renderDoctorWidgetLines(theme, buildDoctorWidgetProjection(report), 80, rotation(5, 1));
			expect(lines[0]).not.toMatch(/\d\/\d ⟳/);
		});

		it("shows a page/total rotation hint once issues genuinely outgrow one page, and pages through them as the clock advances", () => {
			const report = baseReport({
				serviceUnits: Array.from({ length: 5 }, (_, i) => ({
					code: "SERVICE_STALE_CODE",
					severity: "warning" as const,
					package: `pkg${i}`,
					unitName: `unit${i}`,
					message: "stale",
				})),
			});
			const projection = buildDoctorWidgetProjection(report);
			let now = 0;
			const paging = rotation(2, 5, () => now);

			const page1 = renderDoctorWidgetLines(theme, projection, 80, paging);
			expect(page1[0]).toMatch(/1\/3 ⟳/);

			now = 1000;
			const page2 = renderDoctorWidgetLines(theme, projection, 80, paging);
			expect(page2[0]).toMatch(/2\/3 ⟳/);
		});
	});
});
