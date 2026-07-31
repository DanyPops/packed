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
import { registerTools } from "./tools.js";
import { showPackedPanel } from "./tui.js";
import { createNatives } from "./packed.js";
import { formatUpdateNotice } from "./model.js";
import { registerProfiles } from "./profile.js";
import { handleSetupCommand } from "./setup-command.js";
import { handleResourceConfigCommand } from "./resource-config.js";

// Async factory (pi awaits it): the seam creates authenticated daemon
// clients lazily. It never executes Bun-only adapters or opens SQLite.
export default async function (pi: ExtensionAPI) {
	registerProfiles(pi);
	const natives = await createNatives();
	registerTools(pi, natives);

	pi.registerCommand("packed", {
		description: "Browse and manage installed Pi packages; press s for settings, or run setup plan/apply or config directly",
		handler: async (args, ctx) => {
			if (await handleSetupCommand(args, ctx, natives)) return;
			if (await handleResourceConfigCommand(args, ctx, natives)) return;
			await showPackedPanel(ctx, natives);
		},
	});

	// Update check against the local mirror, on Pi's own lifecycle event.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			const updates = await natives.updates();
			if (updates.length) {
				ctx.ui.notify(`${formatUpdateNotice(updates)} — /packed to review`, "info");
			}
		} catch {
			// mirror missing or unreadable — stay silent, never block startup.
		}
	});
}
