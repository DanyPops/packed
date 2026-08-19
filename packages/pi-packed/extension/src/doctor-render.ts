/**
 * doctor.run's own curated presenter -- its DoctorReport output shape (five array fields, several
 * with nested arrays/objects per row: duplicateDependencies' own locations array, extensions'
 * own registrations object) defeats every heuristic in vehicle-render's generic shape-probing
 * chain, so without this it fell all the way through to a raw JSON.stringify dump -- a real, live
 * incident, not a hypothetical. Reuses formatDoctorReport, the exact same human-readable text the
 * CLI's own `packed doctor` (non-JSON) path already renders, so the tool and the CLI never drift
 * into two different descriptions of the same report.
 */
import { type DoctorReport, formatDoctorReport } from "@danypops/pi-packed/doctor-format";
import type { VehiclePresenter } from "@danypops/vehicle-client-pi/vehicle-render";
import { asciiTextMeasure, CollapsibleText } from "malevich-tui-components";

const DOCTOR_REPORT_COLLAPSED_LINES = 12;

function isDoctorReport(value: unknown): value is DoctorReport {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<DoctorReport>;
	return typeof candidate.ok === "boolean" && Array.isArray(candidate.conflicts) && Array.isArray(candidate.extensions);
}

export const renderDoctorRunResult: VehiclePresenter = (output, options, theme) => {
	if (!isDoctorReport(output)) return undefined;
	const collapsible = new CollapsibleText({
		text: theme.fg("text", formatDoctorReport(output, false)),
		collapsedLines: DOCTOR_REPORT_COLLAPSED_LINES,
		headerStyle: (s) => theme.fg("dim", s),
		measure: asciiTextMeasure,
	});
	if (options.expanded) collapsible.expand();
	return collapsible;
};
