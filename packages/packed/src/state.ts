import { ENV } from "./constants.ts";
import { resolvePackedPaths } from "./paths.ts";

/** Compatibility accessor for code that stores non-database daemon state. */
export function stateDir(): string {
	return resolvePackedPaths().stateDirectory;
}

/** Converts a non-negative seconds environment setting to milliseconds. */
export function envMs(key: string, defaultMs: number): number {
	const raw = process.env[key];
	if (raw === undefined) return defaultMs;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return defaultMs;
	return value * 1000;
}
