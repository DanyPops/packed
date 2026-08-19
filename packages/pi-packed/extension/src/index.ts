/**
 * pi-packed — Pi extension seam.
 *
 * Thin by design: registers agent tools (pkg_search/pkg_info/pkg_install/pkg_update/pkg_remove),
 * the /packed command, and a session_start update notification. ALL logic
 * lives in the Bun service (src/): registry access, caching, watcher,
 * catalog sync, install execution.
 *
 * Install: pi install git:github.com/DanyPops/pi-packed
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DoctorOverlay } from "./doctor-overlay.js";
import { formatUpdateNotice } from "./model.js";
import { createNatives } from "./packed.js";
import { registerProfiles } from "./profile.js";
import { handleSetupCommand } from "./setup-command.js";
import { handleResourceConfigCommand } from "./tabs/resource-config.js";
import { registerTools } from "./tools.js";
import { showPackedPanel } from "./tui.js";
import { registerPackedVehicle } from "./vehicle-tools.js";

// Async factory (pi awaits it): the seam creates authenticated daemon
// clients lazily. It never executes Bun-only adapters or opens SQLite.
export default async function (pi: ExtensionAPI) {
	registerProfiles(pi);
	const natives = await createNatives();
	registerTools(pi, natives);

	pi.registerCommand("packed", {
		description:
			"Browse and manage installed Pi packages -- i inspect, u/U update, x remove, d disable, c config, f find, s settings -- or run setup plan/apply or config directly",
		handler: async (args, ctx) => {
			if (await handleSetupCommand(args, ctx, natives)) return;
			if (await handleResourceConfigCommand(args, ctx, natives, showPackedPanel)) return;
			await showPackedPanel(ctx, natives);
		},
	});

	// registerVehicleTools() (inside registerPackedVehicle) needs
	// pi.getAllTools()/getActiveTools()/setActiveTools() -- Pi's extension runtime only finishes
	// initializing after every extension's top-level factory (this one included) has resolved, so
	// calling it directly from there throws "Extension runtime not initialized" (confirmed live in
	// the identical pi-papyrus/pi-tickets bug). session_start fires only after that initialization
	// completes, and Pi awaits every session_start handler before the model's first turn, so
	// registering here is both safe and still visible on turn one.
	let doctorOverlay: DoctorOverlay | undefined;
	pi.on("session_start", async (_event, ctx) => {
		await registerPackedVehicle(pi);
		if (!ctx.hasUI) return;
		try {
			const updates = await natives.updates();
			if (updates.length) {
				ctx.ui.notify(`${formatUpdateNotice(updates)} — /packed to review`, "info");
			}
		} catch {
			// mirror missing or unreadable — stay silent, never block startup.
		}
		doctorOverlay ??= new DoctorOverlay();
		doctorOverlay.setUI(ctx.ui);
		await doctorOverlay.refresh();
		doctorOverlay.startPolling();
	});
	pi.on("session_shutdown", async () => {
		doctorOverlay?.dispose();
	});
}
