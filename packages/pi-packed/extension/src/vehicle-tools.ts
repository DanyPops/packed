/**
 * Projects the daemon's already-registered 29-operation Vehicle surface (see
 * service/src/daemon/vehicle-registration.ts) onto real Pi tools, under Vehicle Shell curation --
 * the same registerVehicleTools({ shell }) pattern @danypops/pi-papyrus's registerNotesVehicle uses
 * (see its extension/src/tools/vehicle-notes-client.ts).
 *
 * Read-only permissions ONLY, deliberately: every mutating package operation
 * (package.install/install_service/restart_service/reconcile_services/update/remove,
 * setup.apply, package.security.set, resources.toggle) is gated server-side purely by an
 * `approved` boolean threaded through its own request shape -- see security.ts's
 * assertPackagePermission(). Vehicle's own operation schema here is passthroughVehicleSchema
 * (see vehicle-registration.ts), which would hand that same `approved` field to the model as an
 * ordinary, undocumented-but-guessable parameter it could set itself, bypassing the interactive
 * ctx.ui.confirm() gate tools.ts's pkg_install/pkg_update/pkg_remove already enforce. Granting
 * only "packed:read" here (never "packed:write") makes every non-read operation permanently
 * permission-unsatisfied -- classifyVehicleOperationSafety() resolves that to "blocked" -- so
 * those tools are registered (visible in tools_list, inspectable via tools_man) but can never
 * actually activate through this path. Exposing them safely needs a real Vehicle approval gate
 * (VehicleRegistry.configureApprovals()) wired server-side first, not merely a client-side option
 * here; until then, package.install/update/remove/etc. keep their own dedicated, human-confirmed
 * tools in tools.ts, unrelated to this file.
 *
 * package.search/package.info are excluded from the projected manifest for the same
 * one-capability-one-tool reason pkg-tools.md documents for pkg_search/pkg_info themselves --
 * they already have dedicated, carefully-worded tools; a second "package_search"/"package_info"
 * doing the identical thing under a different name would only be confusing, not additive.
 *
 * Must be called from session_start, not the top-level extension factory: registerVehicleTools()
 * needs pi.getAllTools()/getActiveTools()/setActiveTools(), which Pi's extension runtime only
 * exposes once every extension's own factory has resolved (confirmed live in the identical
 * pi-papyrus/pi-tickets bug -- see index.ts's own session_start wiring).
 */
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerVehicleTools } from "@danypops/vehicle-client-pi";
import type { VehicleClient, VehicleManifest } from "@danypops/vehicle-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentVehicleClientTarget } from "./vehicle-target.js";

/** Already covered by their own dedicated, approval-aware tools in tools.ts -- see this file's own doc comment. */
const EXCLUDED_OPERATIONS = new Set(["package.search", "package.info"]);

function withoutExcludedOperations(client: VehicleClient): VehicleClient {
	return {
		...client,
		async manifest(): Promise<VehicleManifest> {
			const manifest = await client.manifest();
			return { ...manifest, operations: manifest.operations.filter((operation) => !EXCLUDED_OPERATIONS.has(operation.name)) };
		},
	};
}

/**
 * Illustrative starting core set, not fixed -- tune from real usage the same way pi-papyrus's own
 * CORE_OPERATIONS comment invites. installed/updates/pi.status are the read-only questions a
 * session asks most often without first needing tools_man ("what's installed", "what's stale",
 * "is Pi itself up to date"); everything else (catalog, index, check, pack, score, setup.plan,
 * package.security.get, resources.list, advisories.scan, doctor.run, package.updates.project)
 * boots inactive, reachable via tools_list/tools_man.
 */
const CORE_OPERATIONS = ["package.installed", "package.updates", "pi.status"];

export async function registerPackedVehicle(pi: ExtensionAPI): Promise<void> {
	const target = currentVehicleClientTarget();
	if (!target) return;
	try {
		const client = withoutExcludedOperations(
			createReconnectingVehicleClient(async () => {
				const resolved = currentVehicleClientTarget();
				if (!resolved) throw new Error("Packed daemon is not running");
				return new RemoteVehicleClient({ baseUrl: resolved.baseUrl, token: resolved.token });
			}),
		);
		await registerVehicleTools(pi, client, {
			permissions: ["packed:read"],
			principal: { id: "pi-packed" },
			// ownVehicleName must match daemon.ts's own PACKED_VEHICLE_NAME (the shared Vehicle Handle
			// Directory entry Packed's own daemon registers under via daemonOptions()'s vehicleName --
			// see service/src/daemon/daemon.ts). activateForeignOperation is auto-supplied by
			// registerVehicleTools. See enable-vehicle-shell-broker-mode-in-pi-packed.
			shell: { coreOperations: CORE_OPERATIONS, broker: { ownVehicleName: "pi-packed" } },
		});
	} catch {
		// Daemon state is stale/unreachable -- degrade silently, matching
		// pi-papyrus's registerNotesVehicle and pi-packed's own natives.updates()
		// tolerance in index.ts's session_start handler.
	}
}
