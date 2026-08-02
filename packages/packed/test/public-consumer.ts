import { type WriteJsonAtomicOptions, writeJsonAtomic } from "@danypops/packed/atomic-json";

const options: WriteJsonAtomicOptions = { mode: 0o600 };
void writeJsonAtomic("state.json", { ok: true }, options);
