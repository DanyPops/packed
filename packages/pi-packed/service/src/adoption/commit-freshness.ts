/**
 * commit-freshness.ts — real commit-date lookups backing the `freshness`
 * adoption dimension (score.ts). Two independent, best-effort sources:
 * a local git checkout (free, no network) and GitHub's Commits API for a
 * pre-install registry candidate (bounded, single attempt, GitHub-only).
 * Both resolve to undefined on any failure -- never throw, never guess.
 */
import { runBounded } from "../publish/publish.ts";
import {
	GITHUB_MAX_TOTAL_BACKOFF_MS,
	GITHUB_RETRY_MAX_ATTEMPTS,
	GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS,
	GITHUB_TRANSIENT_BASE_DELAY_MS,
} from "../shared/constants.ts";
import { createLogger } from "../shared/log.ts";

const log = createLogger("commit-freshness");

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_COMMITS_TIMEOUT_MS = 8_000;
/** Matches github.com in every form Pi packages actually declare it in:
 * https://, git+https://, git://, git@host:path (SSH shorthand), with or
 * without a trailing .git. Any other host (GitLab, Bitbucket, sourcehut --
 * all confirmed present in the real pi-extension ecosystem) never matches,
 * so it never reaches the network call below. */
const GITHUB_REPO_PATTERN = /^(?:git\+)?(?:https?:\/\/|git:\/\/|git@)(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i;

function parseGithubRepo(repository: string | undefined): { owner: string; repo: string } | undefined {
	if (!repository) return undefined;
	const match = GITHUB_REPO_PATTERN.exec(repository.trim());
	return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}

/** Seconds to wait before the next attempt, or undefined when the response
 * isn't a rate-limit signal at all (a plain success or an unrelated error).
 * Reads GitHub's two real signals -- confirmed against GitHub's own docs --
 * never guesses a wait time neither header supports. */
function githubRetryAfterSeconds(res: Response): number | undefined {
	const retryAfter = res.headers.get("retry-after");
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		return Number.isFinite(seconds) && seconds > 0 ? seconds : GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS / 1000;
	}
	if (res.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(res.headers.get("x-ratelimit-reset"));
		if (Number.isFinite(reset)) return Math.max(0, reset - Date.now() / 1000);
	}
	return undefined;
}

/**
 * Self-throttling wrapper for the single-candidate GitHub Commits API call:
 * a rate-limit or transient failure backs off and retries rather than
 * giving up on the first hiccup, but the total added wait across every
 * retry is capped at GITHUB_MAX_TOTAL_BACKOFF_MS -- a real primary-limit
 * exhaustion (X-RateLimit-Reset up to an hour away) is treated as
 * immediately exhausted rather than blocking an interactive `packed score`
 * call for anywhere near that long. "Exhaustion" means either the retry
 * count or the total-wait budget runs out, whichever comes first; the
 * caller then gets undefined, the same fail-open contract as before this
 * task, never a thrown error.
 */
async function fetchGithubWithBackoff(url: string, init: RequestInit, timeoutMs: number): Promise<Response | undefined> {
	let totalWaitMs = 0;
	for (let attempt = 1; attempt <= GITHUB_RETRY_MAX_ATTEMPTS; attempt++) {
		// Fresh per-attempt timeout, same as registry.ts's fetchWithRetry --
		// reusing one AbortSignal.timeout() across retries would have it fire
		// mid-backoff-sleep instead of timing each attempt independently.
		const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
		let res: Response;
		try {
			res = await fetch(url, { ...init, signal });
		} catch (e) {
			if (attempt === GITHUB_RETRY_MAX_ATTEMPTS) return undefined;
			const delayMs = GITHUB_TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1);
			if (totalWaitMs + delayMs > GITHUB_MAX_TOTAL_BACKOFF_MS) return undefined;
			totalWaitMs += delayMs;
			log.warn("network error, retrying", { attempt, delayMs, error: e instanceof Error ? e.message : String(e) });
			await Bun.sleep(delayMs);
			continue;
		}
		if (res.ok) return res;
		const rateLimitWaitSeconds = githubRetryAfterSeconds(res);
		const isRetryable = rateLimitWaitSeconds !== undefined || res.status >= 500;
		if (!isRetryable || attempt === GITHUB_RETRY_MAX_ATTEMPTS) return res;
		const delayMs = rateLimitWaitSeconds !== undefined ? rateLimitWaitSeconds * 1000 : GITHUB_TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1);
		if (totalWaitMs + delayMs > GITHUB_MAX_TOTAL_BACKOFF_MS) {
			log.warn("rate-limit wait exceeds total backoff budget, giving up", { attempt, delayMs, status: res.status });
			return res;
		}
		totalWaitMs += delayMs;
		log.warn("rate-limited, backing off", { attempt, delayMs, status: res.status });
		await Bun.sleep(delayMs);
	}
	return undefined;
}

function packedUserAgent(): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `packed (${process.platform}; ${runtime}; ${process.arch})`;
}

/**
 * Reads a checkout's real last-commit timestamp via `git log`, scoped to
 * `directory` when the package lives in a monorepo subdirectory. Bounded
 * single call (runBounded's own timeout), no network at all. Undefined
 * for a missing git binary, a non-git directory, or any parse failure --
 * never a guess.
 */
export async function lastLocalCommitAt(root: string, directory?: string): Promise<string | undefined> {
	const args = ["git", "-C", root, "log", "-1", "--format=%cI"];
	if (directory) args.push("--", directory);
	const result = await runBounded(args).catch((): { code: number; stdout: string; stderr: string } => ({
		code: 1,
		stdout: "",
		stderr: "",
	}));
	if (result.code !== 0) return undefined;
	const date = result.stdout.trim();
	return date && Number.isFinite(Date.parse(date)) ? date : undefined;
}

export type FetchGithubLastCommitAt = (
	repository: string | undefined,
	directory?: string,
	timeoutMs?: number,
) => Promise<string | undefined>;

/**
 * Bounded, self-throttling, GitHub-only commit-date lookup for a candidate
 * that hasn't been cloned yet (pre-install registry scoring). Any
 * non-GitHub host, or a missing repository field, short-circuits to
 * undefined with zero network calls. A transient failure or a short
 * rate-limit wait is retried (see fetchGithubWithBackoff); a real
 * primary-limit exhaustion or total-backoff-budget exhaustion still
 * resolves to undefined rather than blocking. Never intended for a bulk
 * sweep across every installed package -- see index/build-index.ts's own
 * doc comment for why bulk generation never calls this function at all,
 * regardless of how resilient a single call now is. `baseUrl` is
 * test-only, matching this codebase's Bun.serve() HTTP fixture convention
 * (see pi-version.ts's createFetchLatestPiRelease).
 */
export function createGithubLastCommitAt(baseUrl: string = GITHUB_API_BASE): FetchGithubLastCommitAt {
	return async (repository, directory, timeoutMs = GITHUB_COMMITS_TIMEOUT_MS) => {
		const parsed = parseGithubRepo(repository);
		if (!parsed) return undefined;
		const params = new URLSearchParams({ per_page: "1" });
		if (directory) params.set("path", directory);
		try {
			const res = await fetchGithubWithBackoff(
				`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/commits?${params}`,
				{
					headers: { accept: "application/vnd.github+json", "user-agent": packedUserAgent() },
				},
				timeoutMs,
			);
			if (!res?.ok) return undefined;
			const commits = (await res.json()) as Array<{ commit?: { committer?: { date?: unknown }; author?: { date?: unknown } } }>;
			const date = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
			return typeof date === "string" && Number.isFinite(Date.parse(date)) ? date : undefined;
		} catch {
			return undefined;
		}
	};
}

export const githubLastCommitAt: FetchGithubLastCommitAt = createGithubLastCommitAt();
