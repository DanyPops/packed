import { connectPackedClient, resolvePackedClientPaths, type PackedExtensionClient } from "@danypops/packed/client";
import type { ExtensionOperationName, SetupPlan } from "@danypops/packed/protocol";

const paths = resolvePackedClientPaths({ env: {} });
const operation: ExtensionOperationName = "setup.plan";
const plan: SetupPlan | undefined = undefined;
const connect: () => Promise<PackedExtensionClient> = () => connectPackedClient(paths);
void [operation, plan, connect];
