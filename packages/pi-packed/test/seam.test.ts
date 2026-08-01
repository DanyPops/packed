import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { SetupApplyResult, SetupPlan } from "@danypops/packed/protocol";
import { verifyLoadableUnderPi } from "@danypops/vehicle-client-pi/pi-load-harness";
import { filterRows, formatUpdateNotice, mergeRows, nextMode, visibleRows } from "../extension/src/model.ts";
import { createNatives, type PackageDaemonPort, type PackageInfo } from "../extension/src/packed.ts";

const installed = [
	{ name: "pi-extension-manager", pinned: "0.8.2" },
	{ name: "pi-lsp", installed: "0.3.0" },
	{ name: "@scope/pkg", pinned: "1.0.0" },
];

describe("model (seam)", () => {
	it("mergeRows joins update info, prefers pinned version", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(rows).toHaveLength(3);
		const lsp = rows.find((row) => row.name === "pi-lsp")!;
		expect(lsp.hasUpdate).toBe(true);
		expect(lsp.latest).toBe("0.4.0");
		expect(lsp.version).toBe("0.3.0");
		const manager = rows.find((row) => row.name === "pi-extension-manager")!;
		expect(manager.hasUpdate).toBe(false);
		expect(manager.version).toBe("0.8.2");
	});

	it("mergeRows sorts by name", () => {
		const rows = mergeRows(installed, []);
		expect(rows.map((row) => row.name)).toEqual(["@scope/pkg", "pi-extension-manager", "pi-lsp"]);
	});

	it("filterRows is case-insensitive substring", () => {
		const rows = mergeRows(installed, []);
		expect(filterRows(rows, "LSP").map((row) => row.name)).toEqual(["pi-lsp"]);
		expect(filterRows(rows, "")).toHaveLength(3);
	});

	it("visibleRows modes", () => {
		const rows = mergeRows(installed, [{ name: "pi-lsp", installed: "0.3.0", latest: "0.4.0" }]);
		expect(visibleRows(rows, "all")).toHaveLength(3);
		expect(visibleRows(rows, "updates").map((row) => row.name)).toEqual(["pi-lsp"]);
		expect(nextMode("all")).toBe("updates");
		expect(nextMode("updates")).toBe("all");
	});

	it("formatUpdateNotice truncates long lists", () => {
		const updates = [
			{ name: "a", installed: "1", latest: "2" },
			{ name: "b", installed: "1", latest: "2" },
			{ name: "c", installed: "1", latest: "2" },
			{ name: "d", installed: "1", latest: "2" },
		];
		expect(formatUpdateNotice(updates)).toBe("4 package update(s): a 1→2, b 1→2, c 1→2 +1 more");
	});
});

class FakePackageDaemon implements PackageDaemonPort {
	calls: Array<{ operation: string; input?: unknown }> = [];

	async search(query: string, limit: number, offline = false) {
		this.calls.push({ operation: "search", input: { query, limit, offline } });
		return { query, total: 1, results: [{ name: "pi-lsp", version: "1.0.0" }] };
	}

	async info(name: string) {
		this.calls.push({ operation: "info", input: { name } });
		return { name, version: "1.0.0" };
	}

	async installed() {
		this.calls.push({ operation: "installed" });
		return [{ name: "pi-lsp", pinned: "1.0.0" }];
	}

	async updates() {
		this.calls.push({ operation: "updates" });
		return [{ name: "pi-lsp", installed: "1.0.0", latest: "1.1.0" }];
	}

	async setupPlan(manifestPath: string, prune = false): Promise<SetupPlan> {
		this.calls.push({ operation: "setupPlan", input: { manifestPath, prune } });
		return { ok: true, manifestPath, operations: [], diagnostics: [] };
	}
	async setupApply(manifestPath: string, approved = false, prune = false): Promise<SetupApplyResult> {
		this.calls.push({ operation: "setupApply", input: { manifestPath, approved, prune } });
		return { ok: true, manifestPath, operations: [], reloadRequired: false, diagnostics: [] };
	}
	async listResources(projectRoot?: string) {
		this.calls.push({ operation: "listResources", input: { projectRoot } });
		return { global: [], project: [] };
	}
	async toggleResource(
		source: string,
		field: "extensions" | "skills" | "prompts" | "themes",
		path: string,
		enabled: boolean,
		projectRoot?: string,
		approved = false,
	) {
		this.calls.push({ operation: "toggleResource", input: { source, field, path, enabled, projectRoot, approved } });
		return "ok";
	}

	async security() {
		this.calls.push({ operation: "security" });
		return { mutationApproval: "always" as const };
	}

	async setMutationApproval(mutationApproval: "always" | "never", approved = false) {
		this.calls.push({ operation: "setMutationApproval", input: { mutationApproval, approved } });
		return { mutationApproval };
	}

	async install(source: string, approved = false) {
		this.calls.push({ operation: "install", input: { source, approved } });
		return `Installed ${source}`;
	}

	async remove(name: string, approved = false) {
		this.calls.push({ operation: "remove", input: { name, approved } });
		return `Removed ${name}`;
	}

	async update(source: string, approved = false) {
		this.calls.push({ operation: "update", input: { source, approved } });
		return { output: `Updated ${source}`, reloadRequired: true, alreadyUpToDate: false, pinned: false };
	}

	async installService(source: string, approved = false) {
		this.calls.push({ operation: "installService", input: { source, approved } });
		return { output: `Registered service for ${source}` };
	}

	async piStatus() {
		this.calls.push({ operation: "piStatus" });
		return { current: "1.0.0", latest: "1.0.0", upToDate: true };
	}
}

describe("packed extension seam", () => {
	it("routes every operation through the authenticated daemon port", async () => {
		const daemon = new FakePackageDaemon();
		const natives = await createNatives(async () => daemon);

		expect((await natives.search("lsp", 10)).results[0]?.name).toBe("pi-lsp");
		expect((await natives.searchOffline("lsp", 5)).results[0]?.name).toBe("pi-lsp");
		expect((await natives.info("pi-lsp")).version).toBe("1.0.0");
		expect(await natives.installed()).toHaveLength(1);
		expect(await natives.updates()).toHaveLength(1);
		expect((await natives.security()).mutationApproval).toBe("always");
		expect((await natives.setMutationApproval("never", true)).mutationApproval).toBe("never");
		expect(await natives.install("npm:pi-lsp@1.0.0", true)).toContain("Installed");
		expect(await natives.remove("pi-lsp", true)).toContain("Removed");
		expect((await natives.update("npm:pi-lsp", true)).output).toContain("Updated");
		expect((await natives.setupPlan("/tmp/pi-setup.json", true)).ok).toBe(true);
		expect((await natives.setupApply("/tmp/pi-setup.json", true, true)).ok).toBe(true);
		expect(daemon.calls.map((call) => call.operation)).toEqual([
			"search",
			"search",
			"info",
			"installed",
			"updates",
			"security",
			"setMutationApproval",
			"install",
			"remove",
			"update",
			"setupPlan",
			"setupApply",
		]);
		expect(daemon.calls[1]?.input).toEqual({ query: "lsp", limit: 5, offline: true });
	});

	it("retries once and succeeds when the cached client's connection is stale, matching the connection-loss shape every other daemon consumer already retries", async () => {
		const daemon = new FakePackageDaemon();
		class DeadDaemon extends FakePackageDaemon {
			override async info(_name: string): Promise<PackageInfo> {
				throw new TypeError("fetch failed");
			}
		}
		const deadDaemon: PackageDaemonPort = new DeadDaemon();
		let connectCalls = 0;
		const natives = await createNatives(async () => {
			connectCalls++;
			return connectCalls === 1 ? deadDaemon : daemon;
		});

		const result = await natives.info("pi-lsp");

		expect(result.version).toBe("1.0.0");
		expect(connectCalls).toBe(2);
	});

	it("does not retry a genuine domain-level rejection from the daemon itself -- the actual behavior fix this migration makes", async () => {
		let operationCalls = 0;
		class FailingDaemon extends FakePackageDaemon {
			override async info(_name: string): Promise<PackageInfo> {
				operationCalls++;
				throw new Error("ValidationError: package name is required");
			}
		}
		const failingDaemon: PackageDaemonPort = new FailingDaemon();
		let connectCalls = 0;
		const natives = await createNatives(async () => {
			connectCalls++;
			return failingDaemon;
		});

		await expect(natives.info("")).rejects.toThrow(/ValidationError/);
		expect(operationCalls).toBe(1);
		expect(connectCalls).toBe(1);
	});

	it("never transparently retries a mutating operation after a stale connection -- callOnce()'s whole point", async () => {
		const daemon = new FakePackageDaemon();
		class DeadOnceDaemon extends FakePackageDaemon {
			override async install(_source: string, _approved = false): Promise<string> {
				throw new TypeError("fetch failed");
			}
		}
		const deadDaemon: PackageDaemonPort = new DeadOnceDaemon();
		let connectCalls = 0;
		const natives = await createNatives(async () => {
			connectCalls++;
			return connectCalls === 1 ? deadDaemon : daemon;
		});

		// The first call's own request really did fail against the dead connection --
		// never silently retried into a second, possibly duplicate, install attempt.
		await expect(natives.install("npm:pi-lsp@1.0.0", true)).rejects.toThrow("fetch failed");
		expect(connectCalls).toBe(1);
		expect(daemon.calls).toHaveLength(0);

		// The stale connection was still dropped, so the *next* call reconnects and succeeds.
		const result = await natives.install("npm:pi-lsp@1.0.0", true);
		expect(result).toContain("Installed");
		expect(connectCalls).toBe(2);
	});

	it("contains no Bun-only installer or direct SQLite access", () => {
		const source = readFileSync(new URL("../extension/src/packed.ts", import.meta.url), "utf8");
		expect(source).not.toContain("Bun.");
		expect(source).not.toContain("ExecInstaller");
		expect(source).not.toContain("openDb");
		expect(source).not.toContain("db.ts");
		expect(source).toContain("ensurePackedClient");
		expect(source).toContain('from "@danypops/packed/client"');
	});

	it("loads the daemon client through every Pi extension loader path", async () => {
		const results = await verifyLoadableUnderPi(new URL("../extension/src/index.ts", import.meta.url).pathname);
		expect(results).toEqual([
			{ path: "native-esm", ok: true },
			{ path: "jiti-try-native-false", ok: true },
			{ path: "jiti-try-native-true", ok: true },
		]);
	});
});
