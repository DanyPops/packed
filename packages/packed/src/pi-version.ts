/**
 * Tracks the running Pi coding agent version against the same first-party
 * source Pi's own update-check uses -- never the npm registry, which could
 * disagree with pi.dev/api/latest-version during a package-rename
 * migration (the API's own packageName field exists for exactly that).
 */
import { runBounded, versionAtLeast, type VersionCommand, type VersionCommandResult } from "./publish.ts";
import { defaultPiBin } from "./install.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_NOTE_BYTES = 2_000;
/** The API response includes this field on every response, not only during
 * an actual rename (confirmed live) -- a genuine migration signal is
 * `packageName !== CURRENT_PI_PACKAGE_NAME`, matching Pi's own
 * getSelfUpdatePlan comparison, never mere field presence. */
export const CURRENT_PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Resolves the real pi binary the same way install.ts's ExecInstaller
 * does (PI_PACKED_PI_BIN / PI_BIN / bare "pi" fallback) -- a bare "pi"
 * argv fails under systemd's minimal PATH, which doesn't include wherever
 * a user's own pi install actually lives. */
export const readPiVersion: VersionCommand = () => runBounded([defaultPiBin(), "--version"]);

export interface PiReleaseInfo {
	version: string;
	/** Exists for a future package-rename migration -- absent under normal operation. */
	packageName?: string;
	note?: string;
}

function packedUserAgent(): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `packed (${process.platform}; ${runtime}; ${process.arch})`;
}

function parseVersionOutput(result: VersionCommandResult): string | undefined {
	if (result.code !== 0) return undefined;
	const trimmed = result.stdout.trim();
	return /^\d+\.\d+\.\d+/.test(trimmed) ? trimmed : undefined;
}

export type FetchLatestPiRelease = (options?: { timeoutMs?: number }) => Promise<PiReleaseInfo | undefined>;

/**
 * Fetches the exact endpoint Pi's own self-update check uses. Respects the
 * same opt-outs Pi's own checker does (PI_SKIP_VERSION_CHECK, PI_OFFLINE)
 * so Packed never makes a network call the user already disabled. Never
 * throws -- an unreachable endpoint, timeout, or malformed response all
 * resolve to undefined ("unknown"), never a crash. `baseUrl` is test-only
 * (points at a real local Bun.serve() fixture instead of the live endpoint,
 * matching this codebase's existing HttpRegistry test convention).
 */
export function createFetchLatestPiRelease(baseUrl: string = LATEST_VERSION_URL): FetchLatestPiRelease {
	return async (options = {}) => {
		if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;
		try {
			const response = await fetch(baseUrl, {
				headers: { "User-Agent": packedUserAgent(), accept: "application/json" },
				signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			});
			if (!response.ok) return undefined;
			const data = (await response.json()) as { packageName?: unknown; version?: unknown; note?: unknown };
			if (typeof data.version !== "string" || !data.version.trim()) return undefined;
			const packageName = typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
			const note = typeof data.note === "string" && data.note.trim() ? data.note.trim().slice(0, MAX_NOTE_BYTES) : undefined;
			return { version: data.version.trim(), ...(packageName ? { packageName } : {}), ...(note ? { note } : {}) };
		} catch {
			return undefined;
		}
	};
}

export const fetchLatestPiRelease: FetchLatestPiRelease = createFetchLatestPiRelease();

export interface PiVersionReport {
	/** undefined when `pi` isn't on PATH or its output couldn't be parsed. */
	current?: string;
	/** undefined when the latest-version check failed, timed out, or was opted out of. */
	latest?: string;
	/** undefined whenever either current or latest is unknown -- never a guess. */
	upToDate?: boolean;
	packageName?: string;
	note?: string;
}

export interface PiVersionCheckOptions {
	versionCommand?: VersionCommand;
	fetchLatest?: FetchLatestPiRelease;
	timeoutMs?: number;
}

export async function checkPiVersion(options: PiVersionCheckOptions = {}): Promise<PiVersionReport> {
	const versionCommand = options.versionCommand ?? readPiVersion;
	const fetchLatest = options.fetchLatest ?? fetchLatestPiRelease;
	const current = parseVersionOutput(await versionCommand().catch((): VersionCommandResult => ({ code: 1, stdout: "", stderr: "" })));
	const release = await fetchLatest({ timeoutMs: options.timeoutMs });
	if (!release) return current ? { current } : {};
	const upToDate = current ? versionAtLeast(current, release.version) : undefined;
	const renamed = release.packageName && release.packageName !== CURRENT_PI_PACKAGE_NAME ? release.packageName : undefined;
	return {
		...(current ? { current } : {}),
		latest: release.version,
		...(upToDate !== undefined ? { upToDate } : {}),
		...(renamed ? { packageName: renamed } : {}),
		...(release.note ? { note: release.note } : {}),
	};
}
