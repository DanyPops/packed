/**
 * Pure projection/render pair for the Doctor status widget -- mirrors pi-papyrus's own
 * task-widget.ts / pi-pipes' own jobs-widget.ts split: a DoctorReport in, a bounded intermediate
 * shape out, no I/O, no TUI, fully unit-testable without a real daemon or terminal. See
 * doctor-overlay.ts for the stateful ctx.ui.setWidget-registered class that drives these from a
 * live doctor.run poll.
 */
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AutoRotatingWindow, renderCardRow, type TextMeasure } from "malevich-tui-components";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** The daemon's own manifest name (see service/src/daemon/service.ts's `new VehicleRegistry({ name: "packed" })`) -- vehicleWidgetTitle capitalizes it for display. */
const VEHICLE_NAME = "packed";

/** Visible issue rows per page before the auto-rotating overflow hint pages to the next. */
export const PACKED_DOCTOR_WIDGET_VISIBLE_ROWS = 5;

export interface DoctorWidgetIssue {
	label: string;
}

export interface DoctorWidgetProjection {
	issues: DoctorWidgetIssue[];
	total: number;
}

/**
 * Mirrors doctor.run's own `ok` computation (conflicts + non-ok extensions + serviceUnits), plus
 * stale module-cache entries (directly actionable: "restart the daemon"). Deliberately excludes
 * duplicateDependencies -- doctor.run's own `ok` boolean excludes them too (see doctor-format.ts's
 * own doc comment on why), and they're common enough in this ecosystem's own staggered version
 * rollout to be low-signal for a persistent glance-at-a-widget summary.
 */
export function buildDoctorWidgetProjection(report: DoctorReport): DoctorWidgetProjection {
	const issues: DoctorWidgetIssue[] = [];
	for (const conflict of report.conflicts) {
		issues.push({ label: `${conflict.kind} "${conflict.name}" claimed by ${conflict.claimants.length} extensions` });
	}
	for (const extension of report.extensions) {
		if (extension.status === "ok") continue;
		issues.push({ label: `${extension.status} ${extension.name}${extension.message ? `: ${extension.message}` : ""}` });
	}
	for (const unit of report.serviceUnits) {
		issues.push({ label: `${unit.package} (${unit.unitName}): ${unit.message}` });
	}
	for (const module of report.moduleFreshness ?? []) {
		if (!module.stale) continue;
		issues.push({ label: `${module.name} loaded ${module.loadedVersion ?? "?"}, disk has ${module.currentVersion ?? "?"}` });
	}
	return { issues, total: issues.length };
}

/** "Packed · Doctor · <N> issue(s)", plus a "page/total ⟳" suffix once genuinely paging. */
function doctorCardLabel(projection: DoctorWidgetProjection, rotation?: AutoRotatingWindow): string {
	const base = vehicleWidgetTitle(VEHICLE_NAME, "Doctor", `${projection.total} issue${projection.total === 1 ? "" : "s"}`);
	return rotation?.isPaging ? `${base} · ${rotation.pageIndex + 1}/${rotation.pageCount} ⟳` : base;
}

/** Renders the widget as a single bordered card -- `[]` (hide the whole widget) when there are no
 * real issues, matching every other overlay's own "hide when nothing to show" convention. */
export function renderDoctorWidgetLines(
	theme: { fg(color: string, text: string): string },
	projection: DoctorWidgetProjection,
	width: number,
	rotation?: AutoRotatingWindow,
): string[] {
	if (projection.total === 0) return [];
	rotation?.setTotalRows(projection.issues.length);
	const { start, end } = rotation?.currentPageBounds() ?? { start: 0, end: projection.issues.length };
	const visibleIssues = projection.issues.slice(start, end);

	return renderCardRow(
		[
			{
				label: doctorCardLabel(projection, rotation),
				render: (innerWidth: number) =>
					visibleIssues.map((issue) => truncateToWidth(`${theme.fg("warning", "!")} ${issue.label}`, innerWidth, "…")),
			},
		],
		width,
		{ measure, frameStyle: (s) => theme.fg("borderMuted", s) },
	);
}
