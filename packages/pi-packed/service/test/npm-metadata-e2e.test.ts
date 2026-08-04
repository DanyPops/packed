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
						readme: PUBLISHED_README,
						dist: { integrity: "sha512-published-fixture" },
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		const app = createApp({
			reg: new HttpRegistry(`http://127.0.0.1:${npmServer.port}`, 20, 0, 1),
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

	it("preserves an npm-published README through HttpRegistry, daemon RPC, and PackedClient", async () => {
		const client = new PackedClient(`http://127.0.0.1:${daemonServer.port}`, TOKEN);
		const info = await client.info("@danypops/enigma");

		expect(npmRequests).toEqual([{ path: "/%40danypops/enigma/latest", accept: "application/json" }]);
		expect(info).toMatchObject({
			name: "@danypops/enigma",
			version: "0.22.1",
			license: "MIT",
			readmeAvailable: true,
			readme: PUBLISHED_README,
		});
	});
});
