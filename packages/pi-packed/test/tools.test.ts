import { describe, expect, it } from "bun:test";
import { installPackageWithPolicy, registerTools, removePackageWithPolicy, updatePackageWithPolicy } from "../extension/src/tools.ts";
import type { Natives } from "../extension/src/packed.ts";

describe("native package mutation permission policy", () => {
	it("requires confirmation for install under the secure default", async () => {
		let installs = 0;
		let confirms = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "always" }; },
			async install(_source, approved) { expect(approved).toBe(true); installs += 1; return "installed"; },
		}, {
			hasUI: true,
			ui: { async confirm() { confirms += 1; return false; } },
		});
		expect(confirms).toBe(1);
		expect(installs).toBe(0);
		expect(result.content[0]?.text).toContain("cancelled");
		if (result.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(result.details.status).toBe("cancelled");
	});

	it("requires the same confirmation for update and returns reload guidance", async () => {
		let updates = 0;
		const result = await updatePackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "always" }; },
			async update(_source, approved) {
				expect(approved).toBe(true);
				updates += 1;
				return { output: "updated", reloadRequired: true, alreadyUpToDate: false, pinned: false };
			},
		}, {
			hasUI: true,
			ui: { async confirm(_title, message) { expect(message).toContain("pi update --extension npm:pkg"); return true; } },
		});
		expect(updates).toBe(1);
		expect(result.content[0]?.text).toContain("/reload");
	});

	it("requires the same confirmation for remove", async () => {
		let removes = 0;
		const result = await removePackageWithPolicy("pkg", {
			async security() { return { mutationApproval: "always" }; },
			async remove(_name, approved) { expect(approved).toBe(true); removes += 1; return "removed"; },
		}, {
			hasUI: true,
			ui: { async confirm(_title, message) { expect(message).toContain("pi remove npm:pkg"); return true; } },
		});
		expect(removes).toBe(1);
		expect(result.content[0]?.text).toBe("removed");
	});

	it("reports non-interactive approval refusal as denied rather than cancelled", async () => {
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "always" }; },
			async install() { throw new Error("must not install"); },
		}, {
			hasUI: false,
			ui: { async confirm() { return false; } },
		});
		if (result.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(result.details.status).toBe("denied");
	});

	it("propagates daemon failures through Pi's native error channel", async () => {
		await expect(installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "never" }; },
			async install() { throw new Error("daemon unavailable"); },
		}, {
			hasUI: false,
			ui: { async confirm() { return false; } },
		})).rejects.toThrow("daemon unavailable");
	});

	it("allows the explicit never policy without UI for every guarded operation", async () => {
		let installs = 0;
		const result = await installPackageWithPolicy("npm:pkg", {
			async security() { return { mutationApproval: "never" }; },
			async install(_source, approved) { expect(approved).toBe(false); installs += 1; return "installed"; },
		}, {
			hasUI: false,
			ui: { async confirm() { throw new Error("must not prompt"); } },
		});
		expect(installs).toBe(1);
		expect(result.content[0]?.text).toBe("installed");
	});

	it("registers all five tools with independent renderers and bounded details", async () => {
		const tools: any[] = [];
		const natives = {
			async search() { return { query: "theme", total: 1, results: [{ name: "pkg", version: "1.0.0", description: "result" }] }; },
			async info() { return { name: "pkg", version: "1.0.0", pi: { extensions: ["private.ts"] } }; },
			async security() { return { mutationApproval: "never" as const }; },
			async install() { return "installed"; },
			async update() { return "updated"; },
			async remove() { return "removed"; },
		} as unknown as Natives;
		registerTools({ registerTool(tool: unknown) { tools.push(tool); } } as any, natives);
		expect(tools).toHaveLength(5);
		expect(tools.every((tool) => typeof tool.renderCall === "function" && typeof tool.renderResult === "function")).toBe(true);
		const search = tools.find((tool) => tool.name === "pkg_search");
		const result = await search.execute("id", { query: "theme", limit: 10 });
		expect(result.details.kind).toBe("search");
		expect(result.content[0].text.length).toBeLessThanOrEqual(2_000);
	});
});
