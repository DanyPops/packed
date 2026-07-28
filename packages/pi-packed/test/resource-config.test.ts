import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { applyResourceToggle, filterItems, flatten, handleResourceConfigCommand, type FlatItem } from "../extension/src/resource-config.ts";
import type { Natives, PackageResources } from "../extension/src/packed.ts";

function group(overrides: Partial<PackageResources> = {}): PackageResources {
	return { source: "npm:pi-demo", name: "pi-demo", scope: "global", extensions: [], skills: [], prompts: [], themes: [], ...overrides };
}

describe("flatten (grouping installed packages into one sorted picker list)", () => {
	it("flattens every resource field, sorted by package, then field, then path", () => {
		const groups = [group({ extensions: [{ path: "extensions/b.ts", enabled: true }, { path: "extensions/a.ts", enabled: false }], skills: [{ path: "skills/x/SKILL.md", enabled: true }] })];
		const items = flatten(groups, "global");
		expect(items.map((item) => `${item.field}:${item.path}`)).toEqual(["extensions:extensions/a.ts", "extensions:extensions/b.ts", "skills:skills/x/SKILL.md"]);
		expect(items[0]?.scope).toBe("global");
		expect(items[0]?.packageName).toBe("pi-demo");
	});
});

describe("filterItems (type-to-filter across package, field, and path)", () => {
	const items: FlatItem[] = [
		{ scope: "global", source: "npm:pi-demo", packageName: "pi-demo", field: "extensions", path: "extensions/a.ts", enabled: true },
		{ scope: "global", source: "npm:pi-lsp", packageName: "pi-lsp", field: "skills", path: "skills/review/SKILL.md", enabled: false },
	];

	it("matches by package name, resource type, or path substring, case-insensitively", () => {
		expect(filterItems(items, "pi-demo")).toHaveLength(1);
		expect(filterItems(items, "SKILLS")).toHaveLength(1);
		expect(filterItems(items, "review")).toEqual([items[1]!]);
		expect(filterItems(items, "")).toEqual(items);
		expect(filterItems(items, "nonexistent")).toEqual([]);
	});
});

function fakeCtx(confirm: boolean, notices: string[]): ExtensionCommandContext {
	return {
		hasUI: true,
		cwd: "/project",
		ui: {
			async confirm(_title: string, message: string) { notices.push(`confirm:${message}`); return confirm; },
			notify(message: string) { notices.push(message); },
		},
	} as unknown as ExtensionCommandContext;
}

const extensionItem: FlatItem = { scope: "global", source: "npm:pi-demo", packageName: "pi-demo", field: "extensions", path: "extensions/a.ts", enabled: true };
const skillItem: FlatItem = { scope: "project", source: "npm:pi-demo", packageName: "pi-demo", field: "skills", path: "skills/x/SKILL.md", enabled: false };

describe("applyResourceToggle (warn inline, approve, then mutate -- never silently)", () => {
	it("warns inline in the pre-toggle confirm specifically for extensions, mentioning the reload requirement", async () => {
		const notices: string[] = [];
		let toggled: unknown;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource(source: string, field: string, path: string, enabled: boolean, projectRoot?: string) { toggled = { source, field, path, enabled, projectRoot }; return "ok"; },
		} as unknown as Natives;

		const outcome = await applyResourceToggle(extensionItem, natives, fakeCtx(true, notices));

		expect(outcome).toBe("toggled");
		expect(notices.some((n) => n.startsWith("confirm:") && n.includes("will require a Pi reload"))).toBe(true);
		expect(toggled).toEqual({ source: "npm:pi-demo", field: "extensions", path: "extensions/a.ts", enabled: false, projectRoot: undefined });
	});

	it("does not mention reload for a non-extension resource, and passes the project root only for project-scoped items", async () => {
		const notices: string[] = [];
		let toggled: unknown;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource(source: string, field: string, path: string, enabled: boolean, projectRoot?: string) { toggled = { source, field, path, enabled, projectRoot }; return "ok"; },
		} as unknown as Natives;

		await applyResourceToggle(skillItem, natives, fakeCtx(true, notices));

		expect(notices.some((n) => n.startsWith("confirm:") && n.includes("reload"))).toBe(false);
		expect(toggled).toMatchObject({ projectRoot: "/project" });
	});

	it("never mutates when the pre-toggle confirmation is declined", async () => {
		const notices: string[] = [];
		let called = 0;
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource() { called += 1; return "ok"; },
		} as unknown as Natives;

		const outcome = await applyResourceToggle(extensionItem, natives, fakeCtx(false, notices));

		expect(outcome).toBe("cancelled");
		expect(called).toBe(0);
	});

	it("skips the confirm entirely under the explicit never-approve opt-out, matching every other guarded operation", async () => {
		const notices: string[] = [];
		let called = 0;
		const natives = {
			async security() { return { mutationApproval: "never" as const }; },
			async toggleResource() { called += 1; return "ok"; },
		} as unknown as Natives;

		const outcome = await applyResourceToggle(extensionItem, natives, fakeCtx(false, notices));

		expect(outcome).toBe("toggled");
		expect(called).toBe(1);
		expect(notices.some((n) => n.startsWith("confirm:"))).toBe(false);
	});

	it("reports failure, not a throw, when the daemon rejects the toggle", async () => {
		const notices: string[] = [];
		const natives = {
			async security() { return { mutationApproval: "always" as const }; },
			async toggleResource() { throw new Error("package not found in settings"); },
		} as unknown as Natives;

		const outcome = await applyResourceToggle(extensionItem, natives, fakeCtx(true, notices));

		expect(outcome).toBe("failed");
		expect(notices.join("\n")).toContain("toggle failed: package not found in settings");
	});
});

describe("handleResourceConfigCommand (/packed config dispatch)", () => {
	it("only claims the exact 'config' subcommand, leaving other /packed args to the caller", async () => {
		const natives = {} as Natives;
		const ctx = { hasUI: false, ui: { notify() {} } } as unknown as ExtensionCommandContext;
		expect(await handleResourceConfigCommand("setup plan", ctx, natives)).toBe(false);
		expect(await handleResourceConfigCommand("", ctx, natives)).toBe(false);
	});

	it("claims 'config' and requires interactive mode", async () => {
		const notices: string[] = [];
		const natives = {} as Natives;
		const ctx = { hasUI: false, ui: { notify: (m: string) => notices.push(m) } } as unknown as ExtensionCommandContext;
		expect(await handleResourceConfigCommand("config", ctx, natives)).toBe(true);
		expect(notices.join("\n")).toContain("requires interactive mode");
	});
});
