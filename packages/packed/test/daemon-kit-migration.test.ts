import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { readDaemonHandle } from "@danypops/daemon-kit/paths";
import { connectPackageDaemon } from "../src/client.ts";
import { createApp, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { startPackedDaemon } from "../src/daemon.ts";
import { migrateLegacyPackedState, resolvePackedPaths } from "../src/paths.ts";
import type { Installer, Registry } from "../src/ports.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(name: string): string {
	const root = join(tmpdir(), `${name}-${crypto.randomUUID()}`);
	mkdirSync(root, { recursive: true });
	roots.push(root);
	return root;
}

function testPaths(root: string) {
	return resolvePackedPaths({
		env: {
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "runtime"),
			XDG_CONFIG_HOME: join(root, "config"),
		},
		home: root,
		uid: 1000,
	});
}

const registry: Registry = {
	async search(_query, _limit) { return { total: 1, results: [{ name: "pi-test", version: "1.0.0" }] }; },
	async searchPage(_query, _from, _size) { return { total: 1, results: [{ name: "pi-test", version: "1.0.0" }] }; },
	async searchAll() { return [{ name: "pi-test", version: "1.0.0" }]; },
	async info(name) { return { name, version: "1.0.0" }; },
};

const installer: Installer = {
	async install(source) { return `installed ${source}`; },
	async remove(source) { return `removed ${source}`; },
	async update(source) { return { output: `updated ${source}`, reloadRequired: true, alreadyUpToDate: false, pinned: false }; },
};

describe("daemon-kit migration", () => {
	it("resolves XDG-split paths and keeps PI_PACKED_HOME as an explicit compatibility override", () => {
		const root = tempRoot("packed-paths");
		const paths = testPaths(root);
		expect(paths.database).toBe(join(root, "data", "pi-packed", "packed.db"));
		expect(paths.token).toBe(join(root, "state", "pi-packed", "token"));
		expect(paths.handle).toBe(join(root, "runtime", "pi-packed", "handle.json"));
		expect(paths.stateDirectory).toBe(join(root, "state", "pi-packed"));

		const override = join(root, "override");
		const compatible = resolvePackedPaths({ env: { PI_PACKED_HOME: override }, home: root, uid: 1000 });
		expect(compatible.database).toBe(join(override, "packed.db"));
		expect(compatible.token).toBe(join(override, "token"));
		expect(compatible.handle).toBe(join(override, "handle.json"));
		expect(compatible.stateDirectory).toBe(override);
	});

	it("copies legacy state into missing XDG destinations without overwriting migrated files", () => {
		const root = tempRoot("packed-legacy");
		const legacy = join(root, "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "packed.db"), "legacy-db", { mode: 0o600 });
		writeFileSync(join(legacy, "packed.db-wal"), "legacy-wal", { mode: 0o600 });
		writeFileSync(join(legacy, "packed.db-shm"), "legacy-shm", { mode: 0o600 });
		writeFileSync(join(legacy, "token"), `${"a".repeat(64)}\n`, { mode: 0o600 });
		writeFileSync(join(legacy, "security.json"), '{"mutationApproval":"never"}\n', { mode: 0o600 });
		const paths = testPaths(root);

		migrateLegacyPackedState(paths, legacy);
		expect(readFileSync(paths.database, "utf8")).toBe("legacy-db");
		expect(readFileSync(`${paths.database}-wal`, "utf8")).toBe("legacy-wal");
		expect(readFileSync(`${paths.database}-shm`, "utf8")).toBe("legacy-shm");
		expect(readFileSync(paths.token, "utf8").trim()).toBe("a".repeat(64));
		expect(readFileSync(join(paths.stateDirectory, "security.json"), "utf8")).toContain("never");
		expect(statSync(paths.token).mode & 0o777).toBe(0o600);

		writeFileSync(paths.database, "new-db");
		migrateLegacyPackedState(paths, legacy);
		expect(readFileSync(paths.database, "utf8")).toBe("new-db");
	});

	it("does not carry the legacy 128-bit bearer token into daemon-kit state", () => {
		const root = tempRoot("packed-token-rotation");
		const legacy = join(root, "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "token"), `${"b".repeat(32)}\n`, { mode: 0o600 });
		const paths = testPaths(root);
		migrateLegacyPackedState(paths, legacy);
		expect(existsSync(paths.token)).toBe(false);
	});

	it("serves the typed operation registry while preserving authenticated REST routes", async () => {
		const root = tempRoot("packed-rpc");
		const app = createApp({ reg: registry, inst: installer, token: "test-token", stateDir: root, dataDir: root, piHome: root });
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>("http://packed.test", "test-token", {
			label: "Packed",
			transport: (request) => app.fetch(request),
		});

		expect(await client.operations()).toEqual([
			"package.search", "package.info", "package.installed", "package.catalog", "package.catalog.sync", "package.updates", "package.check", "package.pack", "package.score",
			"setup.export", "setup.update", "setup.plan", "setup.apply",
			"package.security.get", "package.security.set", "package.install", "package.remove", "package.update",
		]);
		expect(await client.call("package.search", { query: "test", limit: 10, offline: false })).toMatchObject({ total: 1 });
		expect(await client.call("package.info", { name: "pi-test" })).toEqual({ name: "pi-test", version: "1.0.0" });
		expect(await client.call("package.catalog.sync", {})).toEqual({ synced: 1 });
		expect((await client.call("package.catalog", {})).packages.map(({ name, version }) => ({ name, version }))).toEqual([{ name: "pi-test", version: "1.0.0" }]);

		const rest = await app.fetch(new Request("http://packed.test/info?name=pi-test", { headers: { authorization: "Bearer test-token" } }));
		expect(rest.status).toBe(200);
		expect(await rest.json()).toEqual({ name: "pi-test", version: "1.0.0" });
	});

	it("starts and stops through daemon-kit with an atomic authenticated handle", async () => {
		const root = tempRoot("packed-daemon");
		const paths = testPaths(root);
		const running = await startPackedDaemon({ paths, reg: registry, inst: installer, piHome: root, maintenanceTasks: [] });
		try {
			const handle = readDaemonHandle(paths.handle);
			expect(handle).toMatchObject({ host: "127.0.0.1", port: running.port, pid: process.pid });
			expect(existsSync(paths.token)).toBe(true);
			expect(readFileSync(paths.token, "utf8").trim()).toMatch(/^[a-f0-9]{64}$/);
			expect(await (await connectPackageDaemon(paths)).info("pi-test")).toEqual({ name: "pi-test", version: "1.0.0" });
		} finally {
			await running.stop();
		}
		expect(readDaemonHandle(paths.handle)).toBeNull();
	});
});
