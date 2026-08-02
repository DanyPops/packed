/**
 * A Pi extension package (pi-packed) can't safely import ../shared/*.ts
 * raw at extension runtime -- pi's jiti-based extension loader has a real,
 * demonstrated failure class transpiling a dependency's raw, unbuilt
 * TypeScript. Duplicated (not re-exported) from ../shared/atomic-json.ts
 * for that reason, same rationale as client.ts/protocol.ts living under
 * src/public/ as their own self-contained compiled entry points rather
 * than thin re-exports of internal daemon-side modules.
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAtomicJsonWriter } from "@danypops/vehicle-core";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";

const writer = createAtomicJsonWriter({ fs: createNodeAtomicJsonFsAdapter() });

export interface WriteJsonAtomicOptions {
	/** POSIX mode for the written file. Omitted means the OS/adapter's own default. */
	mode?: number;
	/** Pretty-prints with 2-space indentation. Defaults to false (compact). */
	pretty?: boolean;
	/** Appends a trailing newline. Defaults to true. */
	trailingNewline?: boolean;
	/** Parent directory mode, created if missing. Defaults to 0o700 (private). */
	dirMode?: number;
}

export async function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: options.dirMode ?? 0o700 });
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`ATOMIC_JSON_PATH_UNSAFE: refusing to replace symlink ${path}`);
	await writer.write(path, value, { mode: options.mode, pretty: options.pretty, trailingNewline: options.trailingNewline ?? true });
}
