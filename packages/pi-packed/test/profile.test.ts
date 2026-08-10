import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeProfiles, loadProfiles, registerProfiles } from "../extension/src/profile.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(dir: string): string {
	roots.push(dir);
	return dir;
}

describe("Packed profiles", () => {
	it("strictly bounds profile files and preserves the existing schema", () => {
		expect(
			decodeProfiles(
				JSON.stringify({
					work: {
						provider: "openai",
						model: "gpt",
						thinkingLevel: "high",
						tools: ["read"],
						instructions: "Stay scoped.",
						theme: "dark",
						allowedModels: ["openai/*"],
					},
				}),
			),
		).toEqual({
			work: {
				provider: "openai",
				model: "gpt",
				thinkingLevel: "high",
				tools: ["read"],
				instructions: "Stay scoped.",
				theme: "dark",
				allowedModels: ["openai/*"],
			},
		});
		expect(() => decodeProfiles(JSON.stringify({ work: { token: "secret" } }))).toThrow("unknown field");
		expect(() => decodeProfiles(JSON.stringify({ work: { tools: [1] } }))).toThrow("bounded strings");
		expect(() => decodeProfiles(JSON.stringify({ work: { instructions: "api_key=abcdefghijklmnop" } }))).toThrow("secret-like material");
	});

	it("merges project profiles only for trusted projects", () => {
		const agent = track(mkdtempSync(join(tmpdir(), "packed-profile-agent-")));
		const cwd = track(mkdtempSync(join(tmpdir(), "packed-profile-project-")));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(agent, "profiles.json"), JSON.stringify({ shared: { model: "global" }, global: { theme: "dark" } }));
		writeFileSync(join(cwd, ".pi/profiles.json"), JSON.stringify({ shared: { model: "project" }, project: { theme: "light" } }));
		expect(loadProfiles(agent, cwd, false)).toEqual({ shared: { model: "global" }, global: { theme: "dark" } });
		expect(loadProfiles(agent, cwd, true)).toEqual({
			shared: { model: "project" },
			global: { theme: "dark" },
			project: { theme: "light" },
		});
	});

	it("applies, warns, injects instructions, persists, and restores through the Pi API", async () => {
		const agent = track(mkdtempSync(join(tmpdir(), "packed-profile-agent-")));
		writeFileSync(
			join(agent, "profiles.json"),
			JSON.stringify({
				work: {
					provider: "openai",
					model: "gpt",
					thinkingLevel: "high",
					tools: ["read", "missing"],
					instructions: "Stay scoped.",
					theme: "dark",
					allowedModels: ["openai/*"],
				},
			}),
		);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
			const shortcuts: Array<{ handler(ctx: ExtensionContext): Promise<void> }> = [];
			const events = new Map<string, (event: any, ctx: ExtensionContext) => any>();
			const entries: Array<{ type: string; customType: string; data: unknown }> = [];
			const notifications: string[] = [];
			let activeTools = ["read", "bash"];
			let thinking = "medium";
			let theme = "light";
			let model: any = { provider: "openai", id: "mini" };
			let startupFlag: string | undefined = "work";
			const pi = {
				registerFlag() {},
				registerShortcut(_key: unknown, shortcut: any) {
					shortcuts.push(shortcut);
				},
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				on(name: string, handler: any) {
					events.set(name, handler);
				},
				getFlag() {
					return startupFlag;
				},
				getThinkingLevel() {
					return thinking;
				},
				setThinkingLevel(value: string) {
					thinking = value;
				},
				getActiveTools() {
					return activeTools;
				},
				setActiveTools(value: string[]) {
					activeTools = value;
				},
				getAllTools() {
					return [{ name: "read" }, { name: "bash" }];
				},
				async setModel(value: any) {
					model = value;
					return true;
				},
				appendEntry(customType: string, data: unknown) {
					entries.push({ type: "custom", customType, data });
				},
			} as unknown as ExtensionAPI;
			let selection = "(none)";
			const ctx = {
				cwd: track(mkdtempSync(join(tmpdir(), "packed-profile-cwd-"))),
				model,
				modelRegistry: { find: () => ({ provider: "openai", id: "gpt" }) },
				isProjectTrusted: () => true,
				sessionManager: { getEntries: () => entries },
				ui: {
					theme: { name: theme, fg: (_name: string, text: string) => text },
					setTheme(value: string) {
						theme = value;
						this.theme.name = value;
						return { success: true };
					},
					setStatus() {},
					notify(message: string) {
						notifications.push(message);
					},
					async select() {
						return selection;
					},
				},
			} as unknown as ExtensionContext;
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "startup" }, ctx);
			expect(model.id).toBe("gpt");
			expect(JSON.parse(readFileSync(join(agent, "profiles-last.json"), "utf8"))).toEqual({ name: "work" });
			startupFlag = undefined;
			expect(model.id).toBe("gpt");
			expect(thinking).toBe("high");
			expect(activeTools).toEqual(["read"]);
			expect(theme).toBe("dark");
			expect(entries.at(-1)).toMatchObject({ customType: "profile-state", data: { name: "work" } });
			expect(notifications.join(" ")).toContain("unknown tools: missing");
			expect(events.get("before_agent_start")!({ systemPrompt: "base" }, ctx)).toEqual({ systemPrompt: "base\n\nStay scoped." });
			events.get("model_select")!({ source: "set", model: { provider: "anthropic", id: "claude" } }, ctx);
			expect(notifications.at(-1)).toContain("outside profile");
			selection = "(none)";
			await commands.get("profile")!.handler("", ctx);
			expect(activeTools).toEqual(["read", "bash"]);
			expect(thinking).toBe("medium");
			expect(theme).toBe("light");
			expect(model.id).toBe("mini");
			expect(existsSync(join(agent, "profiles-last.json"))).toBe(false);
			await commands.get("profile")!.handler("work", ctx);
			expect(model.id).toBe("gpt");
			await commands.get("profile")!.handler("", ctx);
			await shortcuts[0]!.handler(ctx);
			expect(model.id).toBe("gpt");

			rmSync(join(agent, "profiles-last.json"));
			entries.splice(0, entries.length, { type: "custom", customType: "profile-state", data: { name: "work" } });
			events.clear();
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "restore" }, ctx);
			expect(events.get("before_agent_start")!({ systemPrompt: "base" }, ctx)).toEqual({ systemPrompt: "base\n\nStay scoped." });

			entries.length = 0;
			writeFileSync(join(agent, "profiles-last.json"), JSON.stringify({ name: "work" }));
			model = { provider: "openai", id: "mini" };
			startupFlag = "missing";
			events.clear();
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "startup" }, ctx);
			expect(model.id).toBe("mini");
			expect(notifications.at(-1)).toContain("Unknown profile");

			startupFlag = undefined;
			entries.push({ type: "custom", customType: "profile-state", data: { name: null } });
			events.clear();
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "restore" }, ctx);
			expect(model.id).toBe("mini");

			entries.length = 0;
			events.clear();
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "startup" }, ctx);
			expect(model.id).toBe("gpt");
			expect(notifications.at(-1)).toContain("restored");

			// pi-setup.json's defaultProfile is no longer auto-applied on session start -- its presence must be a no-op.
			model = { provider: "openai", id: "mini" };
			entries.splice(0, entries.length, { type: "custom", customType: "profile-state", data: { name: null } });
			writeFileSync(join(ctx.cwd, "pi-setup.json"), JSON.stringify({ schemaVersion: 1, defaultProfile: "work" }));
			events.clear();
			registerProfiles(pi);
			await events.get("session_start")!({ reason: "reload" }, ctx);
			expect(model.id).toBe("mini");

			rmSync(join(ctx.cwd, "pi-setup.json"));
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});
