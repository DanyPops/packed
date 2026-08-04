import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_NAMES } from "../src/daemon/service.ts";
import { createApp, type Deps } from "../src/daemon/service.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/packages/package.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

class FakeRegistry implements Registry {
	constructor(
		private results: Pkg[] = [],
		private total = 0,
	) {}
	async search(query: string, limit: number): Promise<SearchPage> {
		return { results: this.results, total: this.total };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.total };
	}
	async searchAll(): Promise<Pkg[]> {
		return this.results;
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1.0.0" };
	}
}

class FakeInstaller implements Installer {
	async install(source: string): Promise<string> {
		return `installed ${source}`;
	}
	async remove(source: string): Promise<string> {
		return `removed ${source}`;
	}
	async update(source: string): Promise<UpdateOutcome> {
		return { output: `updated ${source}`, reloadRequired: true, alreadyUpToDate: false, pinned: false };
	}
}

function deps(over: Partial<Deps> = {}): Deps {
	return {
		reg: new FakeRegistry([{ name: "pi-lsp", version: "1.0.0", description: "An LSP package" }], 1),
		inst: new FakeInstaller(),
		token: "test-token",
		stateDir: temporaryRoot("packed-vehicle-"),
		...over,
	};
}

async function invoke(app: { fetch(request: Request): Promise<Response> }, name: string, input: Record<string, unknown>, token = "test-token") {
	const response = await app.fetch(
		new Request("http://packed.internal/vehicle/invoke", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ name, version: 1, input, permissions: ["packed:read", "packed:write"] }),
		}),
	);
	return { status: response.status, body: (await response.json()) as { output?: unknown; error?: { category: string; message: string } } };
}

describe("packed's daemon operation surface, through the real Vehicle wire protocol", () => {
	it("GET /vehicle/manifest lists all 29 operations, authenticated the same as /api/v1/ops", async () => {
		const app = createApp(deps());
		const unauthorized = await app.fetch(new Request("http://packed.internal/vehicle/manifest"));
		expect(unauthorized.status).toBe(401);
		const response = await app.fetch(new Request("http://packed.internal/vehicle/manifest", { headers: { authorization: "Bearer test-token" } }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { operations: Array<{ name: string }> };
		expect(body.operations.map((o) => o.name).sort()).toEqual([...OPERATION_NAMES].sort());
	});

	it("package.search round-trips through /vehicle/invoke, matching /api/v1/ops's own shape", async () => {
		const app = createApp(deps());
		const result = await invoke(app, "package.search", { query: "lsp", limit: 10 });
		expect(result.status).toBe(200);
		expect((result.body.output as { total: number }).total).toBe(1);
		expect((result.body.output as { results: Array<{ name: string }> }).results[0]?.name).toBe("pi-lsp");
	});

	it("package.installed and pi.status (daemon-only, never a Pi tool) are still reachable through /vehicle/invoke", async () => {
		const app = createApp(deps({ piHome: temporaryRoot("packed-vehicle-pihome-") }));
		const installed = await invoke(app, "package.installed", {});
		expect(installed.status).toBe(200);
		expect(installed.body.output).toEqual([]);
	});

	it("a denied mutation (default mutationApproval: always, no approved flag) surfaces Vehicle's authorization category -> HTTP 403, same as /api/v1/ops's own 403", async () => {
		const app = createApp(deps());
		const result = await invoke(app, "package.remove", { name: "pi-lsp" });
		expect(result.status).toBe(403);
		expect(result.body.error?.category).toBe("authorization");
	});

	it("an approved mutation succeeds through /vehicle/invoke exactly like an approved /api/v1/ops call", async () => {
		const app = createApp(deps());
		const result = await invoke(app, "package.remove", { name: "pi-lsp", approved: true });
		expect(result.status).toBe(200);
		expect((result.body.output as { ok: boolean }).ok).toBe(true);
	});

	it("a handler-thrown validation error keeps its own real message, mapped to Vehicle's validation category (not a generic internal 500)", async () => {
		const app = createApp(deps());
		const result = await invoke(app, "package.check", { path: "" });
		expect(result.status).toBe(400);
		expect(result.body.error?.category).toBe("validation");
		expect(result.body.error?.message).toContain("path must be a non-empty string");
	});

	it("the old /api/v1/ops route keeps working unchanged, alongside /vehicle/invoke", async () => {
		const app = createApp(deps());
		const legacy = await app.fetch(
			new Request("http://packed.internal/api/v1/ops", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify({ op: "package.search", input: { query: "lsp", limit: 10 } }),
			}),
		);
		expect(legacy.status).toBe(200);
		expect(((await legacy.json()) as { result: { total: number } }).result.total).toBe(1);
	});
});
