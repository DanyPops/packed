import { connectPackedClient, type PackedExtensionClient, resolvePackedClientPaths } from "@danypops/pi-packed/client";
import type { ExtensionOperationName, SetupPlan } from "@danypops/pi-packed/protocol";

const paths = resolvePackedClientPaths({ env: {} });
const operation: ExtensionOperationName = "setup.plan";
const plan: SetupPlan | undefined = undefined;
const connect: () => Promise<PackedExtensionClient> = () => connectPackedClient(paths);
void [operation, plan, connect];
