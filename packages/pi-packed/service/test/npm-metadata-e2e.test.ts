import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { Installer, UpdateOutcome } from "../src/packages/package.ts";
import { PackedClient } from "../src/public/client.ts";
import { HttpRegistry } from "../src/registry/registry.ts";
import { createApp } from "../src/daemon/service.ts";

const TOKEN = "e".repeat(64);
const PUBLISHED_MODIFIED = "2024-03-01T00:00:00.000Z";
const WEEKLY_DOWNLOADS = 12_345;
const MONTHLY_DOWNLOADS = 54_321;
const PUBLISHED_README = `# @danypops/enigma

Encrypted credential vault and supervisor daemon. Holds delegated OAuth/API
credentials for other daemons and injects them as environment variables into
spawned child processes.

## Why this exists

Consumers receive only their scoped credentials.`;

class NoopInstaller implements Installer {
	async install(): Promise<string> {
		throw new Error("not exercised");
	}
	async remove(): Promise<string> {
		throw new Error("not exercised");
	}
	async update(): Promise<UpdateOutcome> {
		throw new Error("not exercised");
	}
}

describe("published npm metadata E2E", () => {
	let npmServer: Server<undefined>;
	let daemonServer: Server<undefined>;
	let stateDir: string;
	const npmRequests: Array<{ path: string; accept: string | null }> = [];

	beforeAll(() => {
		stateDir = mkdtempSync(join(tmpdir(), "packed-npm-metadata-"));
		npmServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				npmRequests.push({ path: url.pathname, accept: request.headers.get("accept") });
				if (url.pathname.endsWith("/latest")) {
					return Response.json({
						name: "@danypops/enigma",
						version: "0.22.1",
						description: "Encrypted credential vault daemon",
						license: "MIT",
						repository: { type: "git", url: "git+https://github.com/DanyPops/enigma.git" },
						dist: { integrity: "sha512-published-fixture" },
					});
				}
				if (url.pathname === "/%40danypops/enigma") {
					// One response body serves both callers that hit this exact path: HttpRegistry's own
					// publishedReadme() (Accept: application/json, reads .readme) and modifiedAt() (Accept:
					// application/vnd.npm.install-v1+json, reads .modified) -- real npm content-negotiates
					// two different document shapes for the same URL; this fixture keeps it simple by
					// returning both fields unconditionally, since each caller only ever reads its own.
					return Response.json({
						name: "@danypops/enigma",
						"dist-tags": { latest: "0.22.1" },
						readme: PUBLISHED_README,
						modified: PUBLISHED_MODIFIED,
					});
				}
				if (url.pathname === "/downloads/point/last-week/%40danypops/enigma") return Response.json({ downloads: WEEKLY_DOWNLOADS });
				if (url.pathname === "/downloads/point/last-month/%40danypops/enigma") return Response.json({ downloads: MONTHLY_DOWNLOADS });
				return new Response("not found", { status: 404 });
			},
		});
		const app = createApp({
			// downloadsBase points at the SAME fake server as the registry itself -- real npm splits
			// these across two different hosts (registry.npmjs.org vs api.npmjs.org), but nothing here
			// cares which host a request lands on, only that it's never the real internet.
			reg: new HttpRegistry(`http://127.0.0.1:${npmServer.port}`, 20, 0, 1, `http://127.0.0.1:${npmServer.port}`),
			inst: new NoopInstaller(),
			token: TOKEN,
			stateDir,
		});
		daemonServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	});

	afterAll(() => {
		daemonServer.stop(true);
		npmServer.stop(true);
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("preserves an npm-published README through HttpRegistry, daemon RPC, and PackedClient, plus the daemon's own package.info release-date/downloads enrichment", async () => {
		const client = new PackedClient(`http://127.0.0.1:${daemonServer.port}`, TOKEN);
		const info = await client.info("@danypops/enigma");

		// 2 from HttpRegistry.info() itself (latest + readme) + 1 from the daemon's own
		// package.info enrichment calling modifiedAt() (same path as readme, different Accept) + 2
		// from downloads() (last-week, last-month) -- see service.ts's "/info" handler.
		expect(npmRequests).toHaveLength(5);
		expect(npmRequests).toEqual(
			expect.arrayContaining([
				{ path: "/%40danypops/enigma/latest", accept: "application/json" },
				{ path: "/%40danypops/enigma", accept: "application/json" },
				{ path: "/%40danypops/enigma", accept: "application/vnd.npm.install-v1+json" },
				{ path: "/downloads/point/last-week/%40danypops/enigma", accept: "*/*" },
				{ path: "/downloads/point/last-month/%40danypops/enigma", accept: "*/*" },
			]),
		);
		expect(info).toMatchObject({
			name: "@danypops/enigma",
			version: "0.22.1",
			license: "MIT",
			readmeAvailable: true,
			readme: PUBLISHED_README,
			modified: PUBLISHED_MODIFIED,
			downloads: { weekly: WEEKLY_DOWNLOADS, monthly: MONTHLY_DOWNLOADS },
		});
	});
});
