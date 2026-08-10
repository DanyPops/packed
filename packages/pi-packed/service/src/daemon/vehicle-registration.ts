/**
 * packed's full 29-operation daemon surface projected onto the real Vehicle
 * protocol. Every operation delegates to the exact same executeOperation()
 * function /api/v1/ops already calls (one implementation, two projections --
 * the same shape every other Vehicle-migrated daemon in this ecosystem
 * uses) -- no behavior change, only a second real transport served
 * alongside (not replacing) the existing /api/v1/ops route.
 *
 * Every operation's input is already a well-typed OperationInputs[Name] that
 * executeOperation() validates and dispatches internally (throwing
 * PackageOperationError on a bad shape/denied approval) -- there is no
 * separate Vehicle-side schema to duplicate that logic, so both input and
 * output use passthroughVehicleSchema and let executeOperation's own
 * validation (already covered by service.test.ts) be the single source of
 * truth for what's accepted.
 *
 * Effect classification is grounded in security.ts's own PACKAGE_OPERATIONS
 * classification (read/maintenance/code-execution/settings-mutation/
 * security-mutation) -- the codebase's own, already-deployed risk model --
 * translated to Vehicle's effect vocabulary rather than independently
 * re-derived, with two deliberate refinements documented at each entry
 * where Vehicle's own taxonomy draws a finer distinction Packed's doesn't
 * (package.remove -> destructive, since Vehicle has a dedicated category
 * for irreversible deletion; restart_service/reconcile_services ->
 * external-write rather than open-world, since restarting/reconciling an
 * ALREADY-installed, already-vetted service introduces no new code, unlike
 * install/install_service/update/setup.apply which can fetch and run
 * arbitrary newly-published code).
 *
 * Approval is delegated to the registry's own Vehicle-native mechanism
 * (VehicleRegistry.configureApprovals/updateApprovalPolicy, wired up in
 * daemon.ts/service.ts against packed's own mutationApproval setting) --
 * NOT reimplemented here. Each operation below carries an explicit
 * requiresApproval, exactly matching security.ts's PACKAGE_OPERATIONS
 * classification's own guarded set (code-execution/settings-mutation/
 * security-mutation), set unconditionally rather than left to derive from
 * effect: two of Vehicle's five effect buckets already mix a guarded
 * operation with an unguarded one here (external-write covers both
 * restart_service/reconcile_services, which ARE guarded, and
 * catalog.sync/index.build, which never were; local-write covers both
 * resources.toggle/security.set, guarded, and setup.export/setup.update,
 * never guarded) -- no single effect-derived default could reproduce this
 * split, which is exactly the gap VehicleOperationDescriptor.requiresApproval
 * exists to close.
 *
 * Once the registry's own gate approves a call (because it wasn't gated,
 * or because a real capability was presented), the bound handler forces
 * approved: true onto the input before delegating to executeOperation() --
 * its own legacy authorize()/assertPackagePermission() check (still the
 * sole gate for the older /api/v1/ops transport, untouched here) would
 * otherwise reject a call whose caller never knew that REST-only field
 * existed. A Vehicle caller's only approval contract is Vehicle's own.
 */

import type { VehicleEffect, VehicleIdempotency } from "@danypops/vehicle-core";
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { OPERATION_NAMES, type OperationInputs, type OperationName, type OperationOutputs } from "./service.ts";

/** Thrown by executeOperation() with an HTTP-shaped .status; preserves /api/v1/ops's own status->meaning exactly instead of letting VehicleRegistry.invoke()'s catch-all flatten every failure into a generic internal/500 with the message discarded. */
interface StatusCarryingError extends Error {
	readonly status: number;
}

function hasStatus(error: unknown): error is StatusCarryingError {
	return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}

const withPackedErrorParity = defineErrorMapping([
	{ matches: (error) => hasStatus(error) && error.status === 403, category: "authorization" },
	{ matches: (error) => hasStatus(error) && error.status === 404, category: "not_found" },
	{ matches: (error) => hasStatus(error) && error.status === 400, category: "validation" },
	{ matches: (error) => hasStatus(error) && error.status >= 500, category: "unavailable" },
]);

const OWNER = "packed";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 65_536, maxResponseBytes: 4_194_304 };

const READ: VehicleIdempotency = { mode: "safe" };
const WRITE: VehicleIdempotency = { mode: "unsafe" };

interface OperationMeta {
	readonly description: string;
	readonly effect: VehicleEffect;
	/** See vehicle-core's VehicleOperationDescriptor.requiresApproval -- set explicitly for
	 * every operation here (never left to derive from effect), matching security.ts's own
	 * per-operation guarded/unguarded classification exactly. See this file's own doc
	 * comment for why effect alone can't reproduce that split. */
	readonly requiresApproval: boolean;
}

/**
 * One entry per OPERATION_NAMES member. See this file's own doc comment for
 * the general translation rule (security.ts's PACKAGE_OPERATIONS
 * classification) and its two deliberate refinements.
 */
const OPERATION_META: Record<OperationName, OperationMeta> = {
	"package.search": { description: "Searches Pi packages on npm.", effect: "read", requiresApproval: false },
	"package.info": { description: "Reads bounded metadata for one package.", effect: "read", requiresApproval: false },
	"package.installed": { description: "Lists locally installed Pi packages.", effect: "read", requiresApproval: false },
	"package.catalog": { description: "Reads the local SQLite catalog mirror.", effect: "read", requiresApproval: false },
	"package.catalog.sync": {
		description: "Refreshes the local catalog mirror from the Pi-package-tagged npm registry subset.",
		effect: "external-write",
		requiresApproval: false,
	},
	"package.index": { description: "Reads the locally built adoption-score index, if one exists.", effect: "read", requiresApproval: false },
	"package.index.build": {
		description: "Builds the adoption-score index by scoring catalog entries against the npm registry.",
		effect: "external-write",
		requiresApproval: false,
	},
	"package.updates": { description: "Reads the last background update-check snapshot.", effect: "read", requiresApproval: false },
	"package.check": {
		description: "Runs static (and optionally smoke-test) quality checks against a local package path.",
		effect: "read",
		requiresApproval: false,
	},
	"package.pack": { description: "Verifies a local package path via npm pack.", effect: "read", requiresApproval: false },
	"package.score": {
		description: "Computes an adoption-readiness score for a local path or registry package.",
		effect: "read",
		requiresApproval: false,
	},
	"setup.export": { description: "Exports the current Pi setup as a portable manifest.", effect: "local-write", requiresApproval: false },
	"setup.update": { description: "Updates an existing setup manifest in place.", effect: "local-write", requiresApproval: false },
	"setup.plan": {
		description: "Computes a setup manifest's install/update/remove plan without applying it.",
		effect: "read",
		requiresApproval: false,
	},
	"setup.apply": {
		description: "Applies a setup manifest's plan -- can install, update, or remove packages.",
		effect: "open-world",
		requiresApproval: true,
	},
	"package.security.get": {
		description: "Reads this daemon's mutation-approval security settings.",
		effect: "read",
		requiresApproval: false,
	},
	"package.security.set": {
		description: "Writes this daemon's mutation-approval security settings.",
		effect: "local-write",
		requiresApproval: true,
	},
	"package.install": {
		description: "Installs a Pi package from an npm, git, or https source.",
		effect: "open-world",
		requiresApproval: true,
	},
	"package.install_service": {
		description: "Installs a persistent supervised service for an already-installed daemon package.",
		effect: "open-world",
		requiresApproval: true,
	},
	"package.restart_service": {
		description: "Restarts an already-installed package's persistent service -- no new code introduced.",
		effect: "external-write",
		requiresApproval: true,
	},
	"package.reconcile_services": {
		description: "Reconciles every installed daemon package's persistent service against desired state.",
		effect: "external-write",
		requiresApproval: true,
	},
	"package.remove": { description: "Removes an installed Pi package. Irreversible.", effect: "destructive", requiresApproval: true },
	"package.update": {
		description: "Updates a configured Pi package to its latest available version.",
		effect: "open-world",
		requiresApproval: true,
	},
	"resources.list": {
		description: "Lists global and project-scoped Pi resources (extensions, skills, prompts, themes).",
		effect: "read",
		requiresApproval: false,
	},
	"resources.toggle": {
		description: "Enables or disables one Pi resource in a settings file.",
		effect: "local-write",
		requiresApproval: true,
	},
	"pi.status": {
		description: "Reports the locally running Pi version against the latest published release.",
		effect: "read",
		requiresApproval: false,
	},
	"advisories.scan": {
		description: "Scans installed package versions against known advisories.",
		effect: "read",
		requiresApproval: false,
	},
	"doctor.run": {
		description: "Runs diagnostic health checks (service install drift, resource config, ...).",
		effect: "read",
		requiresApproval: false,
	},
	"package.updates.project": {
		description: "Checks for updates across every scope visible to one project.",
		effect: "read",
		requiresApproval: false,
	},
};

/** Read effects need only packed:read; every other effect needs both (writes commonly also read first). */
function permissionsFor(effect: VehicleEffect): readonly string[] {
	return effect === "read" ? ["packed:read"] : ["packed:read", "packed:write"];
}

export function registerPackedVehicleOperations(
	registry: VehicleRegistry,
	executeOperation: <Name extends OperationName>(op: Name, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>,
): void {
	for (const name of OPERATION_NAMES) {
		const meta = OPERATION_META[name];
		const operation = defineVehicleOperation({
			name,
			version: 1,
			description: meta.description,
			input: passthroughVehicleSchema,
			output: passthroughVehicleSchema,
			permissions: permissionsFor(meta.effect),
			effect: meta.effect,
			requiresApproval: meta.requiresApproval,
			idempotency: meta.effect === "read" ? READ : WRITE,
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => {
				// The registry's own gate (see this file's doc comment) already decided this
				// call is approved by the time the handler runs -- forcing approved: true
				// here satisfies executeOperation()'s own legacy authorize() check without
				// asking a Vehicle caller to know that REST-only field even exists.
				const input = { ...(context.input as Record<string, unknown>), approved: true } as OperationInputs[typeof name];
				return withPackedErrorParity(() => executeOperation(name, input));
			}),
		);
	}
}
