/**
 * doctor.run's own curated renderResult -- its DoctorReport output shape (five array fields,
 * several with nested arrays/objects per row: duplicateDependencies' own locations array,
 * extensions' own registrations object) defeats every heuristic in vehicle-render's generic
 * shape-probing chain, so without this it fell all the way through to a raw JSON.stringify dump
 * -- a real, live incident, not a hypothetical.
 *
 * A FULL renderResult override via registerVehicleTools' `renderers` option, deliberately NOT
 * `renderPresenters`: without any presentations/renderers override at all, EVERY real doctor.run
 * invocation gets a generic vehicle.tool-details/v1 "json"-view presentation projected and
 * PERSISTED at invocation time (createTool's own default presentationProjector), and that
 * projected presentation always wins ahead of a renderPresenters entry -- renderPresenters only
 * ever customizes the output-to-Component step for the non-projected branch, never overriding an
 * already-successful projection (see vehicle-render/result-rendering.ts's own renderVehicleResult:
 * `if (projected) return renderProjectedPresentation(...)` runs before presenters are ever
 * consulted). A real, live incident: wiring this as renderPresenters first left the raw JSON view
 * rendering completely unchanged after release. `renderers.renderResult` sets
 * presentationProjector to undefined for this one operation (see tool-creation.ts's own
 * presentationProjector selection), so this function is now responsible for the operation's every
 * result shape -- it delegates to the shared generic renderer (renderVehicleResult) for anything
 * that isn't a real, complete DoctorReport (a partial/error state, a historical session row, or a
 * future field addition), rather than re-implementing that handling here.
 */
import { type DoctorReport, formatDoctorReport } from "@danypops/pi-packed/doctor-format";
import { renderVehicleResult } from "@danypops/vehicle-client-pi/vehicle-render";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { asciiTextMeasure, CollapsibleText } from "malevich-tui-components";

const DOCTOR_REPORT_COLLAPSED_LINES = 12;

function isDoctorReport(value: unknown): value is DoctorReport {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<DoctorReport>;
	return typeof candidate.ok === "boolean" && Array.isArray(candidate.conflicts) && Array.isArray(candidate.extensions);
}

export function createDoctorRunRenderResult(descriptor: VehicleOperationDescriptor): NonNullable<ToolDefinition["renderResult"]> {
	return (result, options, theme, context) => {
		if (!context.isError && !options.isPartial) {
			const details = result.details as { output?: unknown } | undefined;
			const output = details && Object.hasOwn(details, "output") ? details.output : undefined;
			if (isDoctorReport(output)) {
				const collapsible = new CollapsibleText({
					text: theme.fg("text", formatDoctorReport(output, false)),
					collapsedLines: DOCTOR_REPORT_COLLAPSED_LINES,
					headerStyle: (s) => theme.fg("dim", s),
					measure: asciiTextMeasure,
				});
				if (options.expanded) collapsible.expand();
				return collapsible;
			}
		}
		return renderVehicleResult(descriptor, result, options, theme, context);
	};
}
