/**
 * packed's own atomic JSON persistence convention, layered on
 * @danypops/vehicle-core's shared createAtomicJsonWriter: a private (0700)
 * parent directory, refusing to overwrite a symlinked destination (defense
 * against a symlink-swap attack on a predictable state-directory path),
 * then the shared temp-write+rename+cleanup mechanics for the real write.
 * Replaces 6 independent hand-rolled copies of the same
 * writeFileSync(tmp)+renameSync dance across resources.ts, security.ts,
 * build-index.ts, and setup.ts (twice).
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";

const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });

export interface WriteJsonAtomicOptions {
	/** POSIX mode for the written file. Omitted means the OS/adapter's own default. */
	mode?: number;
	/** Pretty-prints with 2-space indentation. Defaults to false (compact), matching this repo's own prior per-site defaults. */
	pretty?: boolean;
	/** Appends a trailing newline, the convention every existing packed persistence site but writeIndex already followed. Defaults to true. */
	trailingNewline?: boolean;
	/** Parent directory mode, created if missing. Defaults to 0o700 (private), matching every existing packed persistence site. */
	dirMode?: number;
}

export async function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 });
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`ATOMIC_JSON_PATH_UNSAFE: refusing to replace symlink ${path}`);
	await writer.write(path, value, { mode: options.mode, pretty: options.pretty, trailingNewline: options.trailingNewline ?? true });
}
