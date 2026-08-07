/**
 * Test-injectable resolver for the packed daemon's Vehicle-projected surface (/vehicle/*), mirroring
 * @danypops/pi-papyrus's service-client.ts currentVehicleClientTarget() pattern one-to-one: a hermetic
 * test exercising the full extension entrypoint must override this the same way it already overrides
 * the daemon connector, or it would silently start depending on whatever real pi-packed daemon handle
 * happens to exist on the machine running it.
 */
import { type PackedVehicleClientTarget, resolveVehicleClientTarget } from "@danypops/pi-packed/client";

export type { PackedVehicleClientTarget };

let resolver: () => PackedVehicleClientTarget | undefined = () => resolveVehicleClientTarget();

export function currentVehicleClientTarget(): PackedVehicleClientTarget | undefined {
	return resolver();
}

export function setVehicleClientTargetResolverForTests(value: () => PackedVehicleClientTarget | undefined): void {
	resolver = value;
}

export function resetVehicleClientTargetResolverForTests(): void {
	resolver = () => resolveVehicleClientTarget();
}
