import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WriteJsonAtomicOptions {
	mode?: number;
	pretty?: boolean;
	trailingNewline?: boolean;
	dirMode?: number;
}

export async function writeJsonAtomic(path: string, value: unknown, options: WriteJsonAtomicOptions = {}): Promise<void> {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: options.dirMode ?? 0o700 });
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`ATOMIC_JSON_PATH_UNSAFE: refusing to replace symlink ${path}`);
	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	const indentation = options.pretty ? 2 : undefined;
	const newline = options.trailingNewline ?? true;
	const content = `${JSON.stringify(value, null, indentation)}${newline ? "\n" : ""}`;
	try {
		const file = await open(temporaryPath, "wx", options.mode ?? 0o600);
		try {
			await file.writeFile(content, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}
