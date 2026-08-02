import { type AgentToolsBlueprint, compileAgentToolsLock } from "@danypops/packed/agent-tools";
import { type WriteJsonAtomicOptions, writeJsonAtomic } from "@danypops/packed/atomic-json";

const options: WriteJsonAtomicOptions = { mode: 0o600 };
void writeJsonAtomic("state.json", { ok: true }, options);

const blueprint: AgentToolsBlueprint = { schemaVersion: 1, packages: [] };
void compileAgentToolsLock(blueprint, []);
