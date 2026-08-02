import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGithubLastCommitAt, type FetchGithubLastCommitAt } from "../src/adoption/commit-freshness.ts";
import { formatPackReport, NpmPackVerifier, type PackCommand } from "../src/adoption/pack.ts";
import { assessLocalAdoption, assessRegistryAdoption, scoreTarget } from "../src/adoption/score.ts";
import { runBounded } from "../src/publish/publish.ts";
import type { PkgInfo, Registry, SearchPage } from "../src/shared/ports.ts";

class FakeRegistry implements Registry {
	constructor(
		private info_: PkgInfo,
		private modifiedByName: Record<string, string | undefined> = {},
	) {}
	async search(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: [], total: 0 };
	}
	async searchAll() {
		return [];
	}
	async info(): Promise<PkgInfo> {
		return this.info_;
	}
	async modifiedAt(name: string): Promise<string | undefined> {
		return this.modifiedByName[name];
	}
}

function fixture(manifest: Record<string, unknown>, readme = ""): string {
	const root = mkdtempSync(join(tmpdir(), "packed-pack-"));
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	if (readme) writeFileSync(join(root, "README.md"), readme);
	return root;
}

const successfulPack: PackCommand = async (_cwd, args) => {
	expect(args).toEqual(["pack", "--dry-run", "--json", "--ignore-scripts"]);
	return {
		code: 0,
		stdout: JSON.stringify([
			{
				id: "pi-demo@1.0.0",
				name: "pi-demo",
				version: "1.0.0",
				size: 500,
				unpackedSize: 1000,
				shasum: "abc",
				integrity: "sha512-test",
				filename: "pi-demo-1.0.0.tgz",
				files: [
					{ path: "package.json", size: 200, mode: 420 },
					{ path: "extensions/demo.ts", size: 800, mode: 420 },
				],
			},
		]),
		stderr: "",
	};
};

describe("npm tarball verification", () => {
	it("uses npm pack dry-run JSON without lifecycle scripts and verifies Pi shape", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0", keywords: ["pi-package"], pi: { extensions: ["extensions/demo.ts"] } });
		mkdirSync(join(root, "extensions"));
		writeFileSync(join(root, "extensions/demo.ts"), "export default () => {};");
		const report = await new NpmPackVerifier(successfulPack).verify(root);
		expect(report.ok).toBe(true);
		expect(report.command).toEqual(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"]);
		expect(report.shape).toEqual({ kind: "manifest", verified: true, evidence: ["pi.extensions"] });
		expect(report.integrity).toBe("sha512-test");
	});

	it("suppresses npm lifecycle scripts in the real dry-run", async () => {
		const root = fixture({
			name: "pi-no-scripts",
			version: "1.0.0",
			scripts: { prepack: "touch lifecycle-ran" },
			pi: { extensions: ["extension.ts"] },
		});
		writeFileSync(join(root, "extension.ts"), "export default () => {};");
		const report = await new NpmPackVerifier().verify(root);
		expect(report.ok).toBe(true);
		expect(existsSync(join(root, "lifecycle-ran"))).toBe(false);
	});

	it("reports excluded resources and sensitive tarball paths with stable codes", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0", pi: { extensions: ["extensions/missing.ts"] } });
		const command: PackCommand = async () => ({
			code: 0,
			stderr: "",
			stdout: JSON.stringify([{ name: "pi-demo", version: "1.0.0", files: [{ path: ".env", size: 20 }], size: 20, unpackedSize: 20 }]),
		});
		const report = await new NpmPackVerifier(command).verify(root);
		expect(report.ok).toBe(false);
		expect(report.diagnostics.map((item) => item.code)).toContain("PACK_DECLARED_RESOURCE_MISSING");
		expect(report.diagnostics.map((item) => item.code)).toContain("PACK_SENSITIVE_FILE");
	});

	it("keeps bounded JSON output valid", () => {
		const output = formatPackReport(
			{
				root: "/tmp/pkg",
				ok: true,
				command: ["npm", "pack"],
				files: Array.from({ length: 2_000 }, (_, index) => ({ path: `${"x".repeat(500)}/${index}`, size: 1 })),
				shape: { kind: "conventional", verified: true, evidence: ["extensions"] },
				diagnostics: [],
				truncated: false,
			},
			true,
		);
		expect(output.length).toBeLessThanOrEqual(64 * 1024);
		expect(JSON.parse(output).outputTruncated).toBe(true);
	});

	it("bounds malformed and failed npm output", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0" });
		const failed = await new NpmPackVerifier(async () => ({ code: 1, stdout: "x".repeat(100_000), stderr: "npm failed" })).verify(root);
		expect(failed.ok).toBe(false);
		expect(failed.diagnostics[0]?.code).toBe("PACK_COMMAND_FAILED");
		expect(JSON.stringify(failed).length).toBeLessThan(20_000);
	});
});

describe("adoption readiness evidence", () => {
	it("reports transparent local dimensions without turning traction into quality", async () => {
		const root = fixture(
			{
				name: "pi-demo",
				version: "1.0.0",
				description: "Focused Pi demo extension",
				keywords: ["pi-package", "pi-extension"],
				license: "MIT",
				repository: "https://github.com/example/pi-demo",
				bugs: "https://github.com/example/pi-demo/issues",
				peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
				pi: { extensions: ["extensions/demo.ts"] },
			},
			"# pi-demo\n\nInstall: `pi install npm:pi-demo`\n\n## Usage\nRun `/demo`.\n\n![demo](demo.png)\n",
		);
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = await assessLocalAdoption(root, pack);
		expect(report.dimensions.discoverability.met).toBeGreaterThan(0);
		expect(report.dimensions.firstRun.status).toBe("ready");
		expect(report.dimensions.traction.status).toBe("unknown");
		expect(report.dimensions.traction.evidence.join(" ")).toContain("not a quality signal");
		// this fixture declares the "*" wildcard Pi's own docs recommend -- carries no real signal
		expect(report.dimensions.compatibility.status).toBe("unknown");
		expect(report.dimensions.compatibility.evidence.join(" ")).toContain("Pi's own recommended convention");
	});

	it("shows provenance and bounded download observations while leaving trusted publisher unknown", () => {
		const report = assessRegistryAdoption({
			name: "pi-demo",
			version: "1.0.0",
			description: "demo",
			keywords: ["pi-package"],
			license: "MIT",
			repository: "https://github.com/example/pi-demo",
			pi: { extensions: ["extension.ts"] },
			publication: { integrity: "sha512-test", provenanceUrl: "https://registry.example/attestation", trustedPublisher: "unknown" },
			downloads: { weekly: 12, monthly: 34, observedAt: "2026-07-27T00:00:00.000Z" },
		});
		expect(report.dimensions.trust.evidence.join(" ")).toContain("provenance");
		expect(report.dimensions.trust.actions.join(" ")).toContain("trusted publisher");
		expect(report.dimensions.traction.evidence.join(" ")).toContain("12 weekly");
	});
});

describe("trust: lifecycle-install-script detection", () => {
	it("flags declared lifecycle scripts as evidence, without failing the dimension", () => {
		const report = assessRegistryAdoption({
			name: "pi-demo",
			version: "1.0.0",
			license: "MIT",
			repository: "https://github.com/example/pi-demo",
			scripts: { postinstall: "node ./setup.js", test: "bun test" },
		});
		expect(report.dimensions.trust.evidence.join(" ")).toContain("postinstall");
		expect(report.dimensions.trust.evidence.join(" ")).not.toContain("test:");
	});

	it("reports no lifecycle-script finding when none are declared", () => {
		const report = assessRegistryAdoption({
			name: "pi-demo",
			version: "1.0.0",
			license: "MIT",
			repository: "https://github.com/example/pi-demo",
			scripts: { test: "bun test", build: "bun build" },
		});
		expect(report.dimensions.trust.evidence.join(" ")).not.toContain("lifecycle script");
	});

	it("assessLocalAdoption reads scripts from the checkout's own package.json", async () => {
		const root = fixture({
			name: "pi-demo",
			version: "1.0.0",
			scripts: { preinstall: "echo hi" },
		});
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = await assessLocalAdoption(root, pack);
		expect(report.dimensions.trust.evidence.join(" ")).toContain("preinstall");
	});
});

describe("freshness (npm publish-date proxy for commit recency)", () => {
	it("is unknown when neither a real commit date nor a publish date is available for the candidate", () => {
		const report = assessRegistryAdoption({ name: "pi-demo", version: "1.0.0" }, undefined, "2026-07-25T12:47:12.883Z");
		expect(report.dimensions.freshness).toEqual({
			status: "unknown",
			met: 0,
			total: 0,
			evidence: ["candidate's commit history and npm publish date are both unavailable"],
			actions: [],
		});
	});

	it("is unknown when pi-coding-agent's own publish date is unavailable", () => {
		const report = assessRegistryAdoption(
			{ name: "pi-demo", version: "1.0.0", modified: "2026-06-01T00:00:00.000Z" },
			undefined,
			undefined,
		);
		expect(report.dimensions.freshness).toEqual({
			status: "unknown",
			met: 0,
			total: 0,
			evidence: ["pi-coding-agent's own latest npm publish date is unavailable"],
			actions: [],
		});
	});

	it("reports a signed day-delta as observational evidence, never a pass/fail gate", () => {
		const report = assessRegistryAdoption(
			{ name: "pi-demo", version: "1.0.0", modified: "2026-06-01T00:00:00.000Z" },
			undefined,
			"2026-07-25T00:00:00.000Z",
		);
		expect(report.dimensions.freshness.status).toBe("observed");
		expect(report.dimensions.freshness.met).toBe(0);
		expect(report.dimensions.freshness.total).toBe(0);
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("54d before pi-coding-agent's latest publish");
	});

	it("reports the candidate publishing after pi-coding-agent's latest, not just before", () => {
		const report = assessRegistryAdoption(
			{ name: "pi-demo", version: "1.0.0", modified: "2026-08-01T00:00:00.000Z" },
			undefined,
			"2026-07-25T00:00:00.000Z",
		);
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("7d after pi-coding-agent's latest publish");
	});

	it("is unknown for local-checkout scoring when the checkout is not a git repository and pi's publish date is unavailable", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0" });
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = await assessLocalAdoption(root, pack);
		expect(report.dimensions.freshness.status).toBe("unknown");
	});

	it("scoreTarget resolves both the candidate's and pi-coding-agent's publish dates through the optional modifiedAt port method", async () => {
		const registry = new FakeRegistry(
			{ name: "pi-demo", version: "1.0.0" },
			{ "pi-demo": "2026-06-01T00:00:00.000Z", "@earendil-works/pi-coding-agent": "2026-07-25T00:00:00.000Z" },
		);
		const report = await scoreTarget(
			"pi-demo",
			registry,
			new NpmPackVerifier(successfulPack),
			async () => undefined,
			async () => undefined,
		);
		expect(report.dimensions.freshness.status).toBe("observed");
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("54d before");
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("npm publish date (commit history unavailable");
	});

	it("scoreTarget leaves freshness unknown when the registry has no modifiedAt method at all", async () => {
		class NoModifiedAtRegistry implements Registry {
			async search(): Promise<SearchPage> {
				return { results: [], total: 0 };
			}
			async searchPage(): Promise<SearchPage> {
				return { results: [], total: 0 };
			}
			async searchAll() {
				return [];
			}
			async info(): Promise<PkgInfo> {
				return { name: "pi-demo", version: "1.0.0" };
			}
		}
		const report = await scoreTarget(
			"pi-demo",
			new NoModifiedAtRegistry(),
			new NpmPackVerifier(successfulPack),
			async () => undefined,
			async () => undefined,
		);
		expect(report.dimensions.freshness.status).toBe("unknown");
	});
});

describe("freshness: real commit-date source (preferred over the npm publish-date proxy)", () => {
	it("prefers a real commit date over the publish-date proxy when both are available", () => {
		const report = assessRegistryAdoption(
			{ name: "pi-demo", version: "1.0.0", modified: "2026-05-01T00:00:00.000Z" },
			undefined,
			"2026-07-25T00:00:00.000Z",
			"2026-07-20T00:00:00.000Z",
		);
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("last real commit: 2026-07-20");
		expect(report.dimensions.freshness.evidence.join(" ")).not.toContain("2026-05-01");
	});

	it("assessLocalAdoption reads the checkout's real last-commit date via git log, scoped to no network at all", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0" });
		await runBounded(["git", "-C", root, "init", "--quiet"]);
		await runBounded(["git", "-C", root, "config", "user.email", "test@example.com"]);
		await runBounded(["git", "-C", root, "config", "user.name", "Test"]);
		await runBounded(["git", "-C", root, "add", "."]);
		await runBounded(["git", "-C", root, "commit", "--quiet", "-m", "init", "--date", "2026-07-20T00:00:00+00:00"]);
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = await assessLocalAdoption(root, pack, undefined, "2026-07-25T00:00:00.000Z");
		expect(report.dimensions.freshness.status).toBe("observed");
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("last real commit");
	});

	it("assessLocalAdoption falls back to unknown, never a guess, for a checkout that is not a git repository", async () => {
		const root = fixture({ name: "pi-demo", version: "1.0.0" });
		const pack = await new NpmPackVerifier(successfulPack).verify(root);
		const report = await assessLocalAdoption(root, pack, undefined, "2026-07-25T00:00:00.000Z");
		expect(report.dimensions.freshness.status).toBe("unknown");
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("both unavailable");
	});

	it("scoreTarget resolves the candidate's real commit date from GitHub's Commits API, preferring it over the publish-date proxy", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: (req) => {
				expect(new URL(req.url).pathname).toBe("/repos/example/pi-demo/commits");
				return Response.json([{ commit: { committer: { date: "2026-07-20T00:00:00.000Z" } } }]);
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		const registry = new FakeRegistry(
			{ name: "pi-demo", version: "1.0.0", repository: "https://github.com/example/pi-demo", modified: "2026-05-01T00:00:00.000Z" },
			{ "@earendil-works/pi-coding-agent": "2026-07-25T00:00:00.000Z" },
		);
		const report = await scoreTarget("pi-demo", registry, new NpmPackVerifier(successfulPack), async () => undefined, fetchGithubCommit);
		expect(report.dimensions.freshness.evidence.join(" ")).toContain("last real commit: 2026-07-20");
	});

	it("scopes the GitHub Commits API lookup to the package's monorepo subdirectory", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: (req) => {
				expect(new URL(req.url).searchParams.get("path")).toBe("adapters/pi");
				return Response.json([{ commit: { committer: { date: "2026-07-20T00:00:00.000Z" } } }]);
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		const date = await fetchGithubCommit("https://github.com/example/mono", "adapters/pi");
		expect(date).toBe("2026-07-20T00:00:00.000Z");
	});

	it("never makes a network call for a non-GitHub repository host (GitLab, Bitbucket, sourcehut)", async () => {
		const neverCalled: FetchGithubLastCommitAt = createGithubLastCommitAt("http://127.0.0.1:1");
		expect(await neverCalled("https://gitlab.com/example/pi-demo")).toBeUndefined();
		expect(await neverCalled(undefined)).toBeUndefined();
	});

	it("falls back to unknown, never throws, when GitHub responds with a rate-limit-style failure", async () => {
		await using server = Bun.serve({ port: 0, fetch: () => new Response("rate limited", { status: 403 }) });
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		expect(await fetchGithubCommit("https://github.com/example/pi-demo")).toBeUndefined();
	});

	it("self-throttles: retries a secondary rate limit's short Retry-After and succeeds", async () => {
		let calls = 0;
		await using server = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				if (calls === 1) return new Response("secondary rate limited", { status: 403, headers: { "retry-after": "0.05" } });
				return Response.json([{ commit: { committer: { date: "2026-07-20T00:00:00.000Z" } } }]);
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		expect(await fetchGithubCommit("https://github.com/example/pi-demo")).toBe("2026-07-20T00:00:00.000Z");
		expect(calls).toBe(2);
	});

	it("self-throttles: retries a transient 5xx and succeeds, same shape as a rate limit", async () => {
		let calls = 0;
		await using server = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				if (calls === 1) return new Response("server error", { status: 500 });
				return Response.json([{ commit: { committer: { date: "2026-07-20T00:00:00.000Z" } } }]);
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		expect(await fetchGithubCommit("https://github.com/example/pi-demo")).toBe("2026-07-20T00:00:00.000Z");
		expect(calls).toBe(2);
	});

	it("self-throttles: a primary-limit reset far in the future is treated as immediately exhausted, never blocking anywhere near that long", async () => {
		let calls = 0;
		const farFutureReset = Math.floor(Date.now() / 1000) + 3_600; // an hour away
		await using server = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return new Response("primary rate limit exhausted", {
					status: 403,
					headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(farFutureReset) },
				});
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		const start = Date.now();
		expect(await fetchGithubCommit("https://github.com/example/pi-demo")).toBeUndefined();
		expect(Date.now() - start).toBeLessThan(2_000); // real proof it never waited toward the hour-away reset
		expect(calls).toBe(1); // gave up on the first attempt, never retried into the budget
	});

	it("self-throttles: gives up after the bounded attempt count, never retries forever", async () => {
		let calls = 0;
		await using server = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return new Response("server error", { status: 500 });
			},
		});
		const fetchGithubCommit = createGithubLastCommitAt(`http://127.0.0.1:${server.port}`);
		expect(await fetchGithubCommit("https://github.com/example/pi-demo")).toBeUndefined();
		expect(calls).toBe(4); // GITHUB_RETRY_MAX_ATTEMPTS
	}, 15_000); // real exponential backoff across 4 attempts (1+2+4s) exceeds bun's default 5s test timeout
});

describe("compatibility (informal Pi peer-range signal)", () => {
	function withPeerRange(range: string | undefined) {
		return { name: "pi-demo", version: "1.0.0", ...(range ? { peerDependencies: { "@earendil-works/pi-coding-agent": range } } : {}) };
	}

	it('is unknown (not missing) when undeclared -- matches Pi\'s own recommended "*" convention', () => {
		const report = assessRegistryAdoption(withPeerRange(undefined), "0.82.1");
		expect(report.dimensions.compatibility).toEqual({
			status: "unknown",
			met: 0,
			total: 0,
			evidence: ['no declared Pi peer range (matches Pi\'s own recommended "*" convention)'],
			actions: [],
		});
	});

	it('treats an explicit "*" identically to undeclared -- a wildcard carries no real signal', () => {
		const report = assessRegistryAdoption(withPeerRange("*"), "0.82.1");
		expect(report.dimensions.compatibility.status).toBe("unknown");
		expect(report.dimensions.compatibility.evidence.join(" ")).toContain("carries no real signal");
	});

	it("is unknown when a real range is declared but the running Pi version could not be determined", () => {
		const report = assessRegistryAdoption(withPeerRange("^0.75.0"), undefined);
		expect(report.dimensions.compatibility.status).toBe("unknown");
		expect(report.dimensions.compatibility.evidence.join(" ")).toContain("could not be determined");
		expect(report.dimensions.compatibility.actions.join(" ")).toContain("packed pi status");
	});

	it("is unknown, never a guess, for a range shape satisfiesRange cannot evaluate", () => {
		const report = assessRegistryAdoption(withPeerRange(">=0.75.0"), "0.82.1");
		expect(report.dimensions.compatibility.status).toBe("unknown");
		expect(report.dimensions.compatibility.evidence.join(" ")).toContain("could not be evaluated");
	});

	it("is ready when the declared range is satisfied by the running Pi version", () => {
		// 0.x caret is patch-only per real npm semver (^0.82.0 excludes 0.83.x) --
		// this fixture stays within that same 0.82.x window on purpose.
		const report = assessRegistryAdoption(withPeerRange("^0.82.0"), "0.82.1");
		expect(report.dimensions.compatibility).toEqual({
			status: "ready",
			met: 1,
			total: 1,
			evidence: ["declared Pi peer range ^0.82.0 is satisfied by the running pi 0.82.1"],
			actions: [],
		});
	});

	it("is missing (unsatisfied), with a disclaimer that this never blocks install, when the declared range excludes the running Pi version", () => {
		// the real earendil-works/pi#4907 incident: pi-tool-display@0.4.0 declared ^0.75.4
		const report = assessRegistryAdoption(withPeerRange("^0.75.4"), "0.74.2");
		expect(report.dimensions.compatibility.status).toBe("missing");
		expect(report.dimensions.compatibility.met).toBe(0);
		expect(report.dimensions.compatibility.evidence.join(" ")).toContain("NOT satisfied");
		expect(report.dimensions.compatibility.actions.join(" ")).toContain("never blocks install");
	});

	it("scoreTarget threads an injected current-Pi-version resolver through to the compatibility dimension, never invoking a real subprocess in tests", async () => {
		const registry = new FakeRegistry({
			name: "pi-demo",
			version: "1.0.0",
			peerDependencies: { "@earendil-works/pi-coding-agent": "^0.82.0" },
		});
		const report = await scoreTarget("pi-demo", registry, new NpmPackVerifier(successfulPack), async () => "0.82.1");
		expect(report.dimensions.compatibility.status).toBe("ready");
	});
});
