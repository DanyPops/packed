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
 * Approval/authorization is NOT reimplemented here: executeOperation()
 * (and the route()-based operations it delegates to internally) already
 * calls authorize()/assertPackagePermission() and throws
 * PackageOperationError(status: 403) on a denied mutation -- reusing
 * executeOperation() verbatim means this Vehicle surface automatically
 * inherits the exact same approval gate, with zero duplicated policy logic
 * to drift out of sync.
 */

import type { VehicleEffect, VehicleIdempotency } from "@danypops/vehicle-core";
import { bindVehicleOperation, defineVehicleOperation, passthroughVehicleSchema, VehicleError } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { OPERATION_NAMES, type OperationInputs, type OperationName, type OperationOutputs } from "./service.ts";

/** Thrown by executeOperation() with an HTTP-shaped .status; preserves /api/v1/ops's own status->meaning exactly instead of letting VehicleRegistry.invoke()'s catch-all flatten every failure into a generic internal/500 with the message discarded. */
interface StatusCarryingError extends Error {
	readonly status: number;
}

function hasStatus(error: unknown): error is StatusCarryingError {
	return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}

async function withPackedErrorParity<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof VehicleError) throw error;
		if (hasStatus(error)) {
			const category =
				error.status === 403
					? "authorization"
					: error.status === 404
						? "not_found"
						: error.status === 400
							? "validation"
							: error.status >= 500
								? "unavailable"
								: "validation";
			throw new VehicleError("operation-rejected", error.message, { category, cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new VehicleError("operation-rejected", message, { category: "validation", cause: error });
	}
}

const OWNER = "packed";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 65_536, maxResponseBytes: 4_194_304 };

const READ: VehicleIdempotency = { mode: "safe" };
const WRITE: VehicleIdempotency = { mode: "unsafe" };

interface OperationMeta {
	readonly description: string;
	readonly effect: VehicleEffect;
}

/**
 * One entry per OPERATION_NAMES member. See this file's own doc comment for
 * the general translation rule (security.ts's PACKAGE_OPERATIONS
 * classification) and its two deliberate refinements.
 */
const OPERATION_META: Record<OperationName, OperationMeta> = {
	"package.search": { description: "Searches Pi packages on npm.", effect: "read" },
	"package.info": { description: "Reads bounded metadata for one package.", effect: "read" },
	"package.installed": { description: "Lists locally installed Pi packages.", effect: "read" },
	"package.catalog": { description: "Reads the local SQLite catalog mirror.", effect: "read" },
	"package.catalog.sync": {
		description: "Refreshes the local catalog mirror from the Pi-package-tagged npm registry subset.",
		effect: "external-write",
	},
	"package.index": { description: "Reads the locally built adoption-score index, if one exists.", effect: "read" },
	"package.index.build": {
		description: "Builds the adoption-score index by scoring catalog entries against the npm registry.",
		effect: "external-write",
	},
	"package.updates": { description: "Reads the last background update-check snapshot.", effect: "read" },
	"package.check": { description: "Runs static (and optionally smoke-test) quality checks against a local package path.", effect: "read" },
	"package.pack": { description: "Verifies a local package path via npm pack.", effect: "read" },
	"package.score": { description: "Computes an adoption-readiness score for a local path or registry package.", effect: "read" },
	"setup.export": { description: "Exports the current Pi setup as a portable manifest.", effect: "local-write" },
	"setup.update": { description: "Updates an existing setup manifest in place.", effect: "local-write" },
	"setup.plan": { description: "Computes a setup manifest's install/update/remove plan without applying it.", effect: "read" },
	"setup.apply": {
		description: "Applies a setup manifest's plan -- can install, update, or remove packages.",
		effect: "open-world",
	},
	"package.security.get": { description: "Reads this daemon's mutation-approval security settings.", effect: "read" },
	"package.security.set": { description: "Writes this daemon's mutation-approval security settings.", effect: "local-write" },
	"package.install": { description: "Installs a Pi package from an npm, git, or https source.", effect: "open-world" },
	"package.install_service": {
		description: "Installs a persistent supervised service for an already-installed daemon package.",
		effect: "open-world",
	},
	"package.restart_service": {
		description: "Restarts an already-installed package's persistent service -- no new code introduced.",
		effect: "external-write",
	},
	"package.reconcile_services": {
		description: "Reconciles every installed daemon package's persistent service against desired state.",
		effect: "external-write",
	},
	"package.remove": { description: "Removes an installed Pi package. Irreversible.", effect: "destructive" },
	"package.update": { description: "Updates a configured Pi package to its latest available version.", effect: "open-world" },
	"resources.list": { description: "Lists global and project-scoped Pi resources (extensions, skills, prompts, themes).", effect: "read" },
	"resources.toggle": { description: "Enables or disables one Pi resource in a settings file.", effect: "local-write" },
	"pi.status": { description: "Reports the locally running Pi version against the latest published release.", effect: "read" },
	"advisories.scan": { description: "Scans installed package versions against known advisories.", effect: "read" },
	"doctor.run": { description: "Runs diagnostic health checks (service install drift, resource config, ...).", effect: "read" },
	"package.updates.project": { description: "Checks for updates across every scope visible to one project.", effect: "read" },
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
			idempotency: meta.effect === "read" ? READ : WRITE,
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(
				operation,
				() => async (context) =>
					withPackedErrorParity(() => executeOperation(name, context.input as OperationInputs[typeof name])),
			),
		);
	}
}
