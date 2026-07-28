/**
 * Tracks the running Pi coding agent version against the same first-party
 * source Pi's own update-check uses -- never the npm registry, which could
 * disagree with pi.dev/api/latest-version during a package-rename
 * migration (the API's own packageName field exists for exactly that).
 */
import { runBounded, runInherited, versionAtLeast, type InteractiveRunResult, type VersionCommand, type VersionCommandResult } from "./publish.ts";
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

/** Resolves only the locally running Pi version -- no network call, unlike
 * checkPiVersion, which also fetches the latest release. Compatibility
 * scoring needs the current version only, so it never pays pi.dev latency
 * or fails closed on a network blip that has nothing to do with it. */
export async function resolveCurrentPiVersion(versionCommand: VersionCommand = readPiVersion): Promise<string | undefined> {
	return parseVersionOutput(await versionCommand().catch((): VersionCommandResult => ({ code: 1, stdout: "", stderr: "" })));
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

/** Pure argv construction, kept separate from the actual spawn so tests
 * never risk invoking a real `pi update --self`. */
export function piUpdateSelfArgs(): string[] {
	return [defaultPiBin(), "update", "--self"];
}

/**
 * Runs Pi's own already-correct self-update command directly -- npm/pnpm/
 * yarn/bun install-method detection, Windows quirks, its own release note,
 * all already solved there. Packed orchestrates it, never reimplements it,
 * matching the exact boundary already established for npm login/trust.
 * Inherited stdio so any interactive prompt Pi itself shows still works.
 */
export function runPiUpdateSelf(): Promise<InteractiveRunResult> {
	return runInherited(piUpdateSelfArgs());
}

export interface PiVersionCheckOptions {
	versionCommand?: VersionCommand;
	fetchLatest?: FetchLatestPiRelease;
	timeoutMs?: number;
}

export async function checkPiVersion(options: PiVersionCheckOptions = {}): Promise<PiVersionReport> {
	const fetchLatest = options.fetchLatest ?? fetchLatestPiRelease;
	const current = await resolveCurrentPiVersion(options.versionCommand);
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

export interface PiStatusInteractiveDeps {
	/** Reads current status; called once up front, and again after a
	 * successful update to report the refreshed state. */
	check(): Promise<PiVersionReport>;
	/** Asks the human a yes/no question. Real callers gate this on a TTY
	 * themselves before ever invoking this function at all. */
	confirm(question: string): Promise<boolean>;
	/** Runs the real update subprocess. Only ever called after confirm()
	 * resolves true. */
	runUpdate(): Promise<{ ok: boolean }>;
}

/**
 * Pure orchestration decision logic for "packed pi status", fully
 * dependency-injected and unit-testable without a real terminal, a real
 * subprocess, or a real network call: confirm only when genuinely behind,
 * update only after a yes, re-check only after a successful update, never
 * silently swallow a failed update by reporting stale success. The real
 * CLI entrypoint supplies real confirm/runUpdate/check implementations and
 * is itself not unit tested, matching this codebase's established split
 * between tested decision logic and untested real-I/O glue.
 */
export async function runPiStatusInteractive(deps: PiStatusInteractiveDeps): Promise<PiVersionReport> {
	const report = await deps.check();
	if (report.upToDate !== false || !report.current || !report.latest) return report;
	if (!(await deps.confirm(`pi ${report.current} is behind the latest ${report.latest}. Run pi update --self now?`))) return report;
	const result = await deps.runUpdate();
	if (!result.ok) return report;
	return deps.check();
}
