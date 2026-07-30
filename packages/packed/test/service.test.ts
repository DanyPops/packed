import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Deps } from "../src/daemon/service.ts";
import type { DaemonServiceInstaller } from "../src/daemon/daemon-service.ts";
import type { ServiceSpec } from "@danypops/vehicle-server/service";
import { saveUpdates } from "../src/daemon/watcher.ts";
import { openDb, replaceAll, dbPath } from "../src/packages/db.ts";
import type { Installer, Pkg, PkgInfo, Registry, SearchPage, UpdateOutcome } from "../src/shared/ports.ts";

class FakeRegistry implements Registry {
	searchCalls = 0;
	lastQuery = "";
	lastLimit = 0;
	constructor(
		private results: Pkg[] = [],
		private total = 0,
		private failWith?: string,
	) {}
	async search(query: string, limit: number): Promise<SearchPage> {
		this.searchCalls++;
		this.lastQuery = query;
		this.lastLimit = limit;
		if (this.failWith) throw new Error(this.failWith);
		return { results: this.results, total: this.total };
	}
	async searchPage(): Promise<SearchPage> {
		return { results: this.results, total: this.total };
	}
	async searchAll(): Promise<import("../src/shared/ports.ts").Pkg[]> {
		return this.results;
	}
	async info(name: string): Promise<PkgInfo> {
		return { name, version: "1.0.0" };
	}
}

class FakeInstaller implements Installer {
	gotSource = "";
	removed = "";
	updated = "";
	output = "ok";
	fail = false;
	async install(source: string): Promise<string> {
		this.gotSource = source;
		if (this.fail) throw new Error("exit 1\nnpm ERR! 404");
		return this.output;
	}
	async remove(source: string): Promise<string> {
		this.removed = source;
		return this.output;
	}
	updateOutcome: Partial<UpdateOutcome> = {};
	async update(source: string): Promise<UpdateOutcome> {
		this.updated = source;
		return { output: this.output, reloadRequired: true, alreadyUpToDate: false, pinned: false, ...this.updateOutcome };
	}
}

class FakeDaemonServiceInstaller implements DaemonServiceInstaller {
	gotPiHome = "";
	gotSource = "";
	resolveFailure: string | undefined;
	installFailure: string | undefined;
	spec: ServiceSpec = { name: "probe", binPath: "/opt/probe/cli.js", descriptorPath: "/tmp/probe.service" };
	install(piHome: string, source: string): { ok: true; result: { installed: true } | { installed: false; reason: string }; spec: ServiceSpec } | { ok: false; reason: string } {
		this.gotPiHome = piHome;
		this.gotSource = source;
		if (this.resolveFailure) return { ok: false, reason: this.resolveFailure };
		if (this.installFailure) return { ok: true, result: { installed: false, reason: this.installFailure }, spec: this.spec };
		return { ok: true, result: { installed: true }, spec: this.spec };
	}
}

function deps(over: Partial<Deps> = {}): Deps {
	return {
		reg: new FakeRegistry(),
		inst: new FakeInstaller(),
		token: "test-token",
		stateDir: mkdtempSync(join(tmpdir(), "packed-")),
		...over,
	};
}

const auth = { authorization: "Bearer test-token" };

describe("service app", () => {
	it("GET /health", async () => {
		const app = createApp(deps());
		const res = await app.fetch(new Request("http://x/health", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).ok).toBe(true);
	});

	it("requires bearer token", async () => {
		const app = createApp(deps());
		for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
			const res = await app.fetch(new Request("http://x/health", { headers }));
			expect(res.status).toBe(401);
		}
	});

	it("reads and updates mutation approval with a secure default", async () => {
		const app = createApp(deps());
		const initial = await app.fetch(new Request("http://x/security", { headers: auth }));
		expect(await initial.json()).toEqual({ mutationApproval: "always" });
		const denied = await app.fetch(new Request("http://x/security", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ mutationApproval: "never" }),
		}));
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "approval_required", operation: "security.write" });
		const updated = await app.fetch(new Request("http://x/security", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ mutationApproval: "never", approved: true }),
		}));
		expect(await updated.json()).toEqual({ mutationApproval: "never" });
		const invalid = await app.fetch(new Request("http://x/security", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ mutationApproval: "sometimes", approved: true }),
		}));
		expect(invalid.status).toBe(400);
	});

	it("GET /search scopes query and clamps limit", async () => {
		const reg = new FakeRegistry([{ name: "pi-lsp", version: "0.3.0" }], 42);
		const app = createApp(deps({ reg }));
		const res = await app.fetch(new Request("http://x/search?q=lsp&limit=999", { headers: auth }));
		expect(res.status).toBe(200);
		expect(reg.lastQuery).toBe("keywords:pi-package lsp");
		expect(reg.lastLimit).toBe(50);
		const body = await res.json() as any;
		expect(body.total).toBe(42);
		expect(body.results[0].name).toBe("pi-lsp");
	});

	it("caches GET responses (second call skips upstream)", async () => {
		const reg = new FakeRegistry([{ name: "x", version: "1" }], 1);
		const app = createApp(deps({ reg }));
		for (let i = 0; i < 2; i++) {
			await app.fetch(new Request("http://x/search?q=cache", { headers: auth }));
		}
		expect(reg.searchCalls).toBe(1);
	});

	it("upstream error → 502 with message", async () => {
		const reg = new FakeRegistry([], 0, "registry down");
		const app = createApp(deps({ reg }));
		const res = await app.fetch(new Request("http://x/search?q=boom", { headers: auth }));
		expect(res.status).toBe(502);
		expect(await res.text()).toContain("registry down");
	});

	it("GET /info", async () => {
		const app = createApp(deps());
		const res = await app.fetch(new Request("http://x/info?name=pi-lsp", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).name).toBe("pi-lsp");
	});

	it("POST /install rejects invalid sources", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const source of ["foo; rm -rf ~", "npm:foo && curl x|sh", "$(whoami)", "", "npm:"]) {
			const res = await app.fetch(
				new Request("http://x/install", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ source }),
				}),
			);
			expect(res.status).toBe(400);
		}
		expect(inst.gotSource).toBe("");
	});

	it("guards install and remove at the authenticated daemon boundary", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const [path, body] of [["/install", { source: "npm:foo" }], ["/remove", { name: "foo" }]] as const) {
			const response = await app.fetch(new Request(`http://x${path}`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify(body),
			}));
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "approval_required" });
		}
		expect(inst.gotSource).toBe("");
		expect(inst.removed).toBe("");
	});

	it("POST /install accepts valid sources, reports failures in-band", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const source of ["npm:foo", "npm:@scope/pkg@1.2.3", "git:github.com/u/r@v1", "https://github.com/u/r"]) {
			const res = await app.fetch(
				new Request("http://x/install", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ source, approved: true }),
				}),
			);
			expect(res.status).toBe(200);
			expect((await res.json() as any).ok).toBe(true);
		}
		expect(inst.gotSource).toBe("https://github.com/u/r");

		inst.fail = true;
		const res = await app.fetch(
			new Request("http://x/install", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ source: "npm:missing", approved: true }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.ok).toBe(false);
		expect(body.output).toContain("npm ERR! 404");
	});

	it("POST /install-service rejects invalid sources and requires approval, matching /install's own guard", async () => {
		const svc = new FakeDaemonServiceInstaller();
		const app = createApp(deps({ daemonServiceInstaller: svc }));

		const invalid = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:foo && curl x|sh" }),
		}));
		expect(invalid.status).toBe(400);
		expect(svc.gotSource).toBe("");

		const unapproved = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:web-spider-daemon" }),
		}));
		expect(unapproved.status).toBe(403);
		expect(await unapproved.json()).toMatchObject({ code: "approval_required" });
		expect(svc.gotSource).toBe("");

		// A structurally valid but non-npm source is approval-gated the same as
		// any other source -- it fails closed only once the resolver itself runs
		// (a resolveDaemonServiceSpec responsibility, not this route's own regex).
		const gitApproved = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "git:github.com/u/r@v1", approved: true }),
		}));
		expect(gitApproved.status).toBe(200);
		expect((await gitApproved.json() as any).ok).toBe(true); // FakeDaemonServiceInstaller doesn't itself enforce the npm-only rule; resolveDaemonServiceSpec's own unit tests cover that.
	});

	it("POST /install-service installs a real service once approved, reporting the resolved spec", async () => {
		const svc = new FakeDaemonServiceInstaller();
		const piHome = mkdtempSync(join(tmpdir(), "packed-pi-"));
		const app = createApp(deps({ daemonServiceInstaller: svc, piHome }));

		const res = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:web-spider-daemon", approved: true }),
		}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.ok).toBe(true);
		expect(body.output).toContain("probe");
		expect(body.spec).toEqual({ name: "probe", binPath: "/opt/probe/cli.js", descriptorPath: "/tmp/probe.service" });
		expect(svc.gotPiHome).toBe(piHome);
		expect(svc.gotSource).toBe("npm:web-spider-daemon");
	});

	it("POST /install-service reports a resolution failure (no manifest) or an install failure (e.g. unsupported init system) in-band, not as an HTTP error", async () => {
		const svc = new FakeDaemonServiceInstaller();
		svc.resolveFailure = "web-spider-daemon does not declare a packed.daemonService manifest";
		const app = createApp(deps({ daemonServiceInstaller: svc }));

		const resolutionFailure = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:web-spider-daemon", approved: true }),
		}));
		expect(resolutionFailure.status).toBe(200);
		expect((await resolutionFailure.json() as any).ok).toBe(false);

		svc.resolveFailure = undefined;
		svc.installFailure = "no supported Linux init system was detected";
		const installFailure = await app.fetch(new Request("http://x/install-service", {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:web-spider-daemon", approved: true }),
		}));
		expect(installFailure.status).toBe(200);
		const body = (await installFailure.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.output).toContain("no supported Linux init system");
		expect(body.spec).toEqual({ name: "probe", binPath: "/opt/probe/cli.js", descriptorPath: "/tmp/probe.service" });
	});

	it("POST /update validates, authorizes, and delegates one Pi package source", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		const denied = await app.fetch(new Request("http://x/update", {
			method: "POST", headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:pi-lsp" }),
		}));
		expect(denied.status).toBe(403);
		const allowed = await app.fetch(new Request("http://x/update", {
			method: "POST", headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:pi-lsp", approved: true }),
		}));
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({
			ok: true,
			source: "npm:pi-lsp",
			output: "ok",
			reloadRequired: true,
			alreadyUpToDate: false,
			pinned: false,
		});
		expect(inst.updated).toBe("npm:pi-lsp");
	});

	it("POST /update reports an honest no-op instead of trusting pi's always-0-exit-code text", async () => {
		const inst = new FakeInstaller();
		inst.updateOutcome = { reloadRequired: false, alreadyUpToDate: true, pinned: true, previousVersion: "1.0.0", currentVersion: "1.0.0" };
		const app = createApp(deps({ inst }));
		const res = await app.fetch(new Request("http://x/update", {
			method: "POST", headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ source: "npm:pi-lsp@1.0.0", approved: true }),
		}));
		expect(await res.json()).toEqual({
			ok: true,
			source: "npm:pi-lsp@1.0.0",
			output: "ok",
			reloadRequired: false,
			alreadyUpToDate: true,
			pinned: true,
			previousVersion: "1.0.0",
			currentVersion: "1.0.0",
		});
	});

	it("GET /updates serves the watcher snapshot", async () => {
		const d = deps();
		await saveUpdates(d.stateDir, {
			checkedAt: new Date().toISOString(),
			updates: [{ name: "a", installed: "1", latest: "2", detectedAt: "" }],
		});
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/updates", { headers: auth }));
		expect(res.status).toBe(200);
		expect((await res.json() as any).updates[0].latest).toBe("2");
	});

	it("GET /installed lists packages from pi settings", async () => {
		const piHome = mkdtempSync(join(tmpdir(), "packed-pi-"));
		writeFileSync(
			join(piHome, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-extension-manager@0.8.2", { source: "npm:obj@2.0.0" }] }),
		);
		const d = deps({ piHome });
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/installed", { headers: auth }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.map((p: { name: string }) => p.name)).toEqual(["pi-extension-manager", "obj"]);
	});

	it("POST /remove validates bare names and reports in-band", async () => {
		const inst = new FakeInstaller();
		const app = createApp(deps({ inst }));
		for (const name of ["npm:foo", "foo; rm -rf ~", ""]) {
			const res = await app.fetch(
				new Request("http://x/remove", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ name, approved: true }),
				}),
			);
			expect(res.status).toBe(400);
		}
		expect(inst.removed).toBe("");

		const res = await app.fetch(
			new Request("http://x/remove", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ name: "pi-lsp", approved: true }),
			}),
		);
		expect(res.status).toBe(200);
		expect(inst.removed).toBe("npm:pi-lsp");
	});

	it("GET /catalog serves the SQLite mirror", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "a", version: "1" }], "test");
		db.close();
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/catalog", { headers: auth }));
		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.packages[0].name).toBe("a");
		expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("GET /search?offline=1 queries the mirror", async () => {
		const d = deps();
		const db = openDb(dbPath(d.stateDir));
		replaceAll(db, [{ name: "pi-lsp", version: "1", description: "LSP tools" }], "test");
		db.close();
		const app = createApp(d);
		const res = await app.fetch(new Request("http://x/search?q=lsp&offline=1", { headers: auth }));
		expect(res.status).toBe(200);
		const body = await res.json() as any;
		expect(body.offline).toBe(true);
		expect(body.results[0].name).toBe("pi-lsp");
	});
});
