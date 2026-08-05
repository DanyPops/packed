#!/usr/bin/env node

/**
 * verify-load-paths-child.mjs — spawned in isolation by install-validation.ts
 * to check a staged candidate's extension entry against every Pi extension
 * load path @danypops/vehicle-client-pi's pi-load-harness knows about
 * (native ESM, jiti tryNative:false, jiti tryNative:true) -- not just the
 * single tryNative:true path mock-pi-cli's own headless check exercises.
 *
 * Runs as its own subprocess, same trust boundary as mock-pi-cli: the
 * candidate's real code executes here, never inside the trusted daemon
 * process. Uses jiti itself (the same technique mock-pi-cli.mjs already
 * relies on) to import pi-load-harness's raw TypeScript source -- that
 * package deliberately ships this subpath uncompiled, since its intended
 * consumers already run through a TS-transforming toolchain.
 *
 * Accepts:
 *   --extension <path>   candidate extension entry point to check
 *
 * Emits exactly one JSON line on stdout, then exits 0 (a probe failure is
 * data, not a process failure -- the caller decides what a failing path
 * means):
 *   { "results": [{ "path": "native-esm", "ok": true }, ...] }
 * or, if the harness itself couldn't even be loaded/invoked:
 *   { "error": "..." }
 */

import { createJiti } from "jiti";

const args = process.argv.slice(2);
const get = (flag) => {
	const i = args.indexOf(flag);
	return i !== -1 ? args[i + 1] : null;
};

const extensionPath = get("--extension");
if (!extensionPath) {
	process.stderr.write("--extension required\n");
	process.exit(1);
}

function emit(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

try {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const { verifyLoadableUnderPi } = await jiti.import("@danypops/vehicle-client-pi/pi-load-harness");
	const results = await verifyLoadableUnderPi(extensionPath);
	emit({ results });
	process.exit(0);
} catch (err) {
	emit({ error: err?.message ?? String(err) });
	process.exit(1);
}
