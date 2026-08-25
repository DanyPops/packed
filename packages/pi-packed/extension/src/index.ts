import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNatives } from "./packed.js";
import { registerProfiles } from "./profile.js";
import { registerDeferredStartup } from "./startup.js";
import { registerTools } from "./tools.js";

const VEHICLE_PRIORITY = 900;
const UPDATE_NOTICE_PRIORITY = 500;
const DOCTOR_OVERLAY_PRIORITY = 100;

/**
 * Registers only turn-one capabilities synchronously. Daemon-backed status,
 * diagnostics, and large UI modules load after Pi's startup turn, ordered by
 * user value rather than package import order.
 */
export default function (pi: ExtensionAPI) {
	registerProfiles(pi);
	const natives = createNatives();
	registerTools(pi, natives);

	pi.registerCommand("packed", {
		description:
			"Browse and manage installed Pi packages -- i inspect, u/U update, x remove, d disable, c config, f find, s settings -- or run setup plan/apply or config directly",
		handler: async (args, ctx) => {
			const [{ handleSetupCommand }, { handleResourceConfigCommand }, { showPackedPanel }] = await Promise.all([
				import("./setup-command.js"),
				import("./tabs/resource-config.js"),
				import("./tui.js"),
			]);
			if (await handleSetupCommand(args, ctx, natives)) return;
			if (await handleResourceConfigCommand(args, ctx, natives, showPackedPanel)) return;
			await showPackedPanel(ctx, natives);
		},
	});

	let doctorOverlay: import("./doctor-overlay.js").DoctorOverlay | undefined;
	registerDeferredStartup(pi, [
		{
			id: "vehicle-tools",
			priority: VEHICLE_PRIORITY,
			async run() {
				const { registerPackedVehicle } = await import("./vehicle-tools.js");
				await registerPackedVehicle(pi);
			},
		},
		{
			id: "update-notice",
			priority: UPDATE_NOTICE_PRIORITY,
			async run(ctx, isCurrent) {
				const updates = await natives.updates();
				if (!isCurrent() || updates.length === 0) return;
				const { formatUpdateNotice } = await import("./model.js");
				if (isCurrent()) ctx.ui.notify(`${formatUpdateNotice(updates)} — /packed to review`, "info");
			},
		},
		{
			id: "doctor-overlay",
			priority: DOCTOR_OVERLAY_PRIORITY,
			async run(ctx, isCurrent) {
				if (!ctx.hasUI) return;
				const { DoctorOverlay } = await import("./doctor-overlay.js");
				const overlay = new DoctorOverlay();
				await overlay.refresh();
				if (!isCurrent()) {
					overlay.dispose();
					return;
				}
				doctorOverlay?.dispose();
				doctorOverlay = overlay;
				overlay.setUI(ctx.ui);
				overlay.startPolling();
			},
			dispose() {
				doctorOverlay?.dispose();
				doctorOverlay = undefined;
			},
		},
	]);
}
