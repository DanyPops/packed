/**
 * Confirms registerPackedVehicle (extension/src/vehicle-tools.ts) actually wires the daemon's
 * already-registered Vehicle surface (service/src/daemon/vehicle-registration.ts) into Pi under
 * Vehicle Shell curation, mirroring @danypops/pi-papyrus's own
 * test/vehicle-shell-activation.test.ts one-to-one:
 *  - only the core operations plus tools_list/tools_man are active from turn one;
 *  - package.search/package.info are excluded entirely (already covered by pkg_search/pkg_info);
 *  - every mutating operation stays registered (reachable via tools_man) but permanently
 *    "blocked" -- the read-only permission grant never satisfies it -- so it can never actually
 *    activate through this path, matching this file's own doc comment about not letting the
 *    model set `approved` itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetInProcessVehicleRegistryForTests, __resetVehicleShellHandleForTests } from "@danypops/vehicle-client-pi/test-utils";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resetVehicleClientTargetResolverForTests, setVehicleClientTargetResolverForTests } from "../extension/src/vehicle-target.ts";
import { registerPackedVehicle } from "../extension/src/vehicle-tools.ts";

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function operation(name: string, effect: string) {
	return {
		name,
		version: 1,
		description: `Run ${name}.`,
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: effect === "read" ? ["packed:read"] : ["packed:read", "packed:write"],
		effect,
		idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
		available: true,
	};
}

/** A representative slice of the real 29-operation surface (see vehicle-registration.ts's OPERATION_META) -- large enough, and mixed enough between read and mutating effects, to assert both Vehicle Shell curation and permission-based blocking meaningfully. */
function realisticOperations() {
	return [
		operation("package.search", "read"),
		operation("package.info", "read"),
		operation("package.installed", "read"),
		operation("package.catalog", "read"),
		operation("package.updates", "read"),
		operation("package.check", "read"),
		operation("setup.plan", "read"),
		operation("package.security.get", "read"),
		operation("resources.list", "read"),
		operation("pi.status", "read"),
		operation("advisories.scan", "read"),
		operation("doctor.run", "read"),
		operation("package.install", "open-world"),
		operation("package.update", "open-world"),
		operation("package.remove", "destructive"),
		operation("setup.apply", "open-world"),
		operation("resources.toggle", "local-write"),
		operation("package.security.set", "local-write"),
	];
}

function manifestServer(): { baseUrl: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/vehicle/manifest") {
				return Response.json({ name: "packed", version: "1.0.0", description: "Packed.", operations: realisticOperations() });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function fakePi() {
	const registeredTools: ToolDefinition[] = [];
	let activeTools: string[] = [];
	const api = {
		registerTool(tool: ToolDefinition) {
			registeredTools.push(tool);
		},
		registerCommand() {},
		on() {},
		getAllTools: () => registeredTools.map((tool) => ({ name: tool.name })),
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	return { api, registeredTools, getActiveTools: () => activeTools };
}

describe("registerPackedVehicle opts into Vehicle Shell activation", () => {
	// registerVehicleTools()'s shared Vehicle Shell handle and in-process vehicle registry are both
	// process-wide globalThis singletons -- bun test runs this whole package's test files in one
	// process, so an earlier test's own registration would otherwise silently "win" the shared
	// handle forever, leaving a later test's own fresh fake api with tools_list/tools_man never
	// registered on it at all. See @danypops/vehicle-client-pi/test-utils's own doc comment.
	beforeEach(() => {
		__resetVehicleShellHandleForTests();
		__resetInProcessVehicleRegistryForTests();
	});

	afterEach(() => {
		resetVehicleClientTargetResolverForTests();
	});

	it("does nothing when the daemon has never started", async () => {
		setVehicleClientTargetResolverForTests(() => undefined);
		const { api, registeredTools } = fakePi();
		await registerPackedVehicle(api);
		expect(registeredTools).toHaveLength(0);
	});

	it("activates only the core read operations plus tools_list/tools_man, excludes package.search/info, and permanently blocks every mutation", async () => {
		const { baseUrl, stop } = manifestServer();
		try {
			setVehicleClientTargetResolverForTests(() => ({ baseUrl, token: "test-token" }));
			const { api, registeredTools, getActiveTools } = fakePi();

			await registerPackedVehicle(api);

			// package.search/package.info are filtered out of the projected manifest entirely --
			// already covered by pkg_search/pkg_info's own dedicated tools.
			expect(registeredTools.some((tool) => tool.name === "package_search")).toBe(false);
			expect(registeredTools.some((tool) => tool.name === "package_info")).toBe(false);

			// Every other operation is still registered (reachable via tools_man)...
			expect(registeredTools.some((tool) => tool.name === "package_installed")).toBe(true);
			expect(registeredTools.some((tool) => tool.name === "package_install")).toBe(true);
			expect(registeredTools.some((tool) => tool.name === "package_remove")).toBe(true);

			// ...but only the curated core set plus the two meta-tools is active from turn one.
			const active = getActiveTools();
			expect(active).toContain("tools_list");
			expect(active).toContain("tools_man");
			expect(active).toContain("package_installed");
			expect(active).toContain("package_updates");
			expect(active).toContain("pi_status");
			expect(active).not.toContain("package_check");
			expect(active).not.toContain("resources_list");

			// tools_man really does describe an inactive read operation, proving it's reachable --
			// but every mutation is permanently blocked by the read-only permission grant, so even
			// an explicit tools_man call can never make it callable (never lets the model reach
			// the `approved` field pkg_install/pkg_update/pkg_remove gate behind a real confirm).
			const man = registeredTools.find((tool) => tool.name === "tools_man");
			expect(man).toBeDefined();
			const readResult = (await man!.execute(
				"call-1",
				{ names: ["packed:package.check"] } as never,
				undefined as never,
				undefined as never,
				undefined as never,
			)) as { content: Array<{ text: string }> };
			expect(readResult.content[0]?.text).toContain("now callable as package_check");
			expect(getActiveTools()).toContain("package_check");

			const writeResult = (await man!.execute(
				"call-2",
				{ names: ["packed:package.install"] } as never,
				undefined as never,
				undefined as never,
				undefined as never,
			)) as { content: Array<{ text: string }> };
			expect(writeResult.content[0]?.text).toContain("blocked by the current safety policy");
			expect(getActiveTools()).not.toContain("package_install");
		} finally {
			stop();
		}
	});

	it("tools_list's own description advertises namespaced cross-vehicle discovery, the neutral shared-owner shape", async () => {
		const { baseUrl, stop } = manifestServer();
		try {
			setVehicleClientTargetResolverForTests(() => ({ baseUrl, token: "test-token" }));
			const { api, registeredTools } = fakePi();

			await registerPackedVehicle(api);

			const list = registeredTools.find((tool) => tool.name === "tools_list");
			expect(list).toBeDefined();
			expect(list!.description).toContain('namespaced "<vehicle>:<operation>"');
		} finally {
			stop();
		}
	});
});
