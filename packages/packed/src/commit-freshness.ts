/**
 * commit-freshness.ts — real commit-date lookups backing the `freshness`
 * adoption dimension (score.ts). Two independent, best-effort sources:
 * a local git checkout (free, no network) and GitHub's Commits API for a
 * pre-install registry candidate (bounded, single attempt, GitHub-only).
 * Both resolve to undefined on any failure -- never throw, never guess.
 */
import { runBounded } from "./publish.ts";

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
	return match && match[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
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
	const result = await runBounded(args).catch((): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: "", stderr: "" }));
	if (result.code !== 0) return undefined;
	const date = result.stdout.trim();
	return date && Number.isFinite(Date.parse(date)) ? date : undefined;
}

export type FetchGithubLastCommitAt = (repository: string | undefined, directory?: string, timeoutMs?: number) => Promise<string | undefined>;

/**
 * Bounded, single-attempt, GitHub-only commit-date lookup for a candidate
 * that hasn't been cloned yet (pre-install registry scoring). Any
 * non-GitHub host, or a missing repository field, short-circuits to
 * undefined with zero network calls. Unauthenticated GitHub REST rate
 * limit (60/hr) is accepted for this occasional, single-package,
 * interactive use -- never retried against that scarce quota, and never
 * intended for a bulk sweep across every installed package. `baseUrl` is
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
			const res = await fetch(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/commits?${params}`, {
				headers: { accept: "application/vnd.github+json", "user-agent": packedUserAgent() },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) return undefined;
			const commits = (await res.json()) as Array<{ commit?: { committer?: { date?: unknown }; author?: { date?: unknown } } }>;
			const date = commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date;
			return typeof date === "string" && Number.isFinite(Date.parse(date)) ? date : undefined;
		} catch {
			return undefined;
		}
	};
}

export const githubLastCommitAt: FetchGithubLastCommitAt = createGithubLastCommitAt();
