import { describe, expect, it } from "bun:test";
import { compileAgentToolsLock, toSpdx } from "../src/public/agent-tools.ts";

const blueprint = {
	schemaVersion: 1 as const,
	packages: [
		{ id: "vehicle.web", kind: "vehicle" as const, source: "npm:@danypops/web-vehicle@1.2.3" },
		{ id: "extension.fs", kind: "extension" as const, source: "npm:@danypops/fs-extension@2.0.0" },
	],
	enabledTools: ["web.fetch", "fs.read"],
};

const resolved = [
	{
		id: "extension.fs",
		kind: "extension" as const,
		source: "npm:@danypops/fs-extension@2.0.0",
		version: "2.0.0",
		integrity: "sha512-fs",
		resources: [{ kind: "extension" as const, path: "extension/index.js" }],
		permissions: ["filesystem.read"],
		compatibility: [{ host: "pi", range: ">=0.80.0" }],
		tools: [
			{
				name: "fs.read",
				description: "Read a file",
				inputSchema: { type: "object", properties: { path: { type: "string" } } },
				permissions: ["filesystem.read"],
				limits: { maxBytes: 50_000 },
				effects: ["filesystem.read"],
			},
		],
	},
	{
		id: "vehicle.web",
		kind: "vehicle" as const,
		source: "npm:@danypops/web-vehicle@1.2.3",
		version: "1.2.3",
		integrity: "sha512-web",
		resources: [{ kind: "vehicle-manifest" as const, path: "vehicle.json" }],
		permissions: ["network"],
		compatibility: [],
		tools: [
			{
				name: "web.fetch",
				description: "Fetch a URL",
				inputSchema: { type: "object", properties: { url: { type: "string" } } },
				permissions: ["network"],
				limits: { timeoutMs: 30_000 },
				effects: ["network.read"],
			},
		],
	},
];

describe("Agent Tools Lock", () => {
	it("compiles static package and tool descriptors into a deterministic lock", () => {
		const first = compileAgentToolsLock(blueprint, resolved);
		const second = compileAgentToolsLock(
			{ ...blueprint, packages: [...blueprint.packages].reverse(), enabledTools: [...blueprint.enabledTools].reverse() },
			[...resolved].reverse(),
		);

		expect(first).toEqual(second);
		expect(first.packages.map((entry) => entry.id)).toEqual(["extension.fs", "vehicle.web"]);
		expect(first.tools.map((tool) => [tool.name, tool.owner])).toEqual([
			["fs.read", "extension.fs"],
			["web.fetch", "vehicle.web"],
		]);
		expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(first)).toBe(true);
	});

	it("rejects undeclared, missing, duplicate, and unknown enabled tools", () => {
		expect(() => compileAgentToolsLock({ ...blueprint, packages: blueprint.packages.slice(0, 1) }, resolved)).toThrow(
			"undeclared resolved package",
		);
		expect(() => compileAgentToolsLock(blueprint, resolved.slice(0, 1))).toThrow("missing resolved package");
		expect(() => compileAgentToolsLock(blueprint, [...resolved, resolved[0]!])).toThrow("duplicate resolved package");
		expect(() => compileAgentToolsLock({ ...blueprint, enabledTools: ["missing.tool"] }, resolved)).toThrow("unknown enabled tool");
	});

	it("projects locked package identity and integrity to deterministic SPDX", () => {
		const lock = compileAgentToolsLock(blueprint, resolved);
		const spdx = toSpdx(lock);
		expect(spdx.documentNamespace).toBe(`https://danypops.dev/packed/agent-tools/${lock.contentHash}`);
		expect(spdx.packages.map((entry) => entry.name)).toEqual(["extension.fs", "vehicle.web"]);
		expect(spdx.packages[0]?.checksums).toEqual([{ algorithm: "SHA512", checksumValue: "fs" }]);
	});
});
