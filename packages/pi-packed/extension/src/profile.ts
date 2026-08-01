import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "@danypops/packed/atomic-json";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
export interface Profile {
	provider?: string;
	model?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: string[];
	instructions?: string;
	theme?: string;
	allowedModels?: string[];
}
export type ProfilesConfig = Record<string, Profile>;
type ThinkingLevel = NonNullable<Profile["thinkingLevel"]>;
const PROFILE_FILE = "profiles.json";
const LAST_PROFILE_FILE = "profiles-last.json";
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_PROFILES = 100;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function secretLike(value: string): boolean {
	return (
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
		/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i.test(value) ||
		/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9_\-./+=]{12,}/i.test(value)
	);
}

function stringArray(value: unknown, maximum: number): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > maximum ||
		!value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256)
	)
		throw new Error("array must contain bounded strings");
	return [...new Set(value)];
}

export function decodeProfiles(text: string): ProfilesConfig {
	if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new Error("profile file exceeds 256 KiB");
	const value = JSON.parse(text) as unknown;
	if (!isRecord(value) || Object.keys(value).length > MAX_PROFILES) throw new Error("profile file must contain at most 100 named profiles");
	const profiles: ProfilesConfig = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!PROFILE_NAME.test(name) || !isRecord(raw)) throw new Error(`invalid profile: ${name}`);
		const allowed = new Set(["provider", "model", "thinkingLevel", "tools", "instructions", "theme", "allowedModels"]);
		if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(`profile ${name} contains an unknown field`);
		const profile: Profile = {};
		for (const field of ["provider", "model", "theme"] as const) {
			if (raw[field] !== undefined && !boundedString(raw[field], field === "model" ? 256 : 128))
				throw new Error(`profile ${name}.${field} is invalid`);
			const fieldValue = boundedString(raw[field], field === "model" ? 256 : 128);
			if (fieldValue) profile[field] = fieldValue;
		}
		if (raw.instructions !== undefined && !boundedString(raw.instructions, 16_384))
			throw new Error(`profile ${name}.instructions is invalid`);
		if (typeof raw.instructions === "string") {
			if (secretLike(raw.instructions)) throw new Error(`profile ${name}.instructions contains secret-like material`);
			profile.instructions = raw.instructions;
		}
		if (raw.thinkingLevel !== undefined && (typeof raw.thinkingLevel !== "string" || !THINKING_LEVELS.has(raw.thinkingLevel)))
			throw new Error(`profile ${name}.thinkingLevel is invalid`);
		if (raw.thinkingLevel) profile.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
		profile.tools = stringArray(raw.tools, 100);
		profile.allowedModels = stringArray(raw.allowedModels, 100);
		if (!profile.tools) delete profile.tools;
		if (!profile.allowedModels) delete profile.allowedModels;
		profiles[name] = profile;
	}
	return profiles;
}

function readProfileFile(path: string): ProfilesConfig {
	if (!existsSync(path)) return {};
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_BYTES)
		throw new Error(`${path} is not a safe bounded profile file`);
	return decodeProfiles(readFileSync(path, "utf8"));
}

export function loadProfiles(agentDir: string, cwd: string, projectTrusted: boolean): ProfilesConfig {
	const globalProfiles = readProfileFile(join(agentDir, PROFILE_FILE));
	if (!projectTrusted) return globalProfiles;
	return { ...globalProfiles, ...readProfileFile(join(cwd, CONFIG_DIR_NAME, PROFILE_FILE)) };
}

function loadDefaultProfile(cwd: string, projectTrusted: boolean): string | undefined {
	if (!projectTrusted) return undefined;
	try {
		const path = join(cwd, "pi-setup.json");
		if (!existsSync(path)) return undefined;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; defaultProfile?: unknown };
		return value.schemaVersion === 1 && typeof value.defaultProfile === "string" && PROFILE_NAME.test(value.defaultProfile)
			? value.defaultProfile
			: undefined;
	} catch {
		return undefined;
	}
}

function loadLastProfile(agentDir: string): string | undefined {
	try {
		const path = join(agentDir, LAST_PROFILE_FILE);
		if (!existsSync(path)) return undefined;
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
		return typeof value.name === "string" && PROFILE_NAME.test(value.name) ? value.name : undefined;
	} catch {
		return undefined;
	}
}

async function saveLastProfile(agentDir: string, name: string | undefined): Promise<void> {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const path = join(agentDir, LAST_PROFILE_FILE);
	if (!name) {
		rmSync(path, { force: true });
		return;
	}
	await writeJsonAtomic(path, { name }, { mode: 0o600 });
}

function matchesPattern(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	try {
		return new RegExp(`^${escaped}$`).test(value);
	} catch {
		return false;
	}
}

interface OriginalState {
	model: ExtensionContext["model"];
	thinkingLevel: ThinkingLevel;
	tools: string[];
	themeName?: string;
}

export function registerProfiles(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let profiles: ProfilesConfig = {};
	let activeName: string | undefined;
	let activeProfile: Profile | undefined;
	let original: OriginalState | undefined;
	let applyingModel = false;

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("packed-profile", activeName ? ctx.ui.theme.fg("accent", `profile:${activeName}`) : undefined);
	}

	function persistState(name: string | undefined): void {
		pi.appendEntry("profile-state", name ? { name } : { name: null });
	}

	async function apply(name: string, profile: Profile, ctx: ExtensionContext, persist = true): Promise<void> {
		if (!original)
			original = { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), tools: pi.getActiveTools(), themeName: ctx.ui.theme.name };
		applyingModel = true;
		try {
			if (profile.provider && profile.model) {
				const model = ctx.modelRegistry.find(profile.provider, profile.model);
				if (!model) ctx.ui.notify(`Profile "${name}": model ${profile.provider}/${profile.model} not found`, "warning");
				else if (!(await pi.setModel(model)))
					ctx.ui.notify(`Profile "${name}": credentials unavailable for ${profile.provider}/${profile.model}`, "warning");
			}
		} finally {
			applyingModel = false;
		}
		if (profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);
		if (profile.tools?.length) {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const valid = profile.tools.filter((tool) => available.has(tool));
			const missing = profile.tools.filter((tool) => !available.has(tool));
			if (missing.length) ctx.ui.notify(`Profile "${name}": unknown tools: ${missing.join(", ")}`, "warning");
			if (valid.length) pi.setActiveTools(valid);
		}
		if (profile.theme) {
			const result = ctx.ui.setTheme(profile.theme);
			if (!result.success) ctx.ui.notify(`Profile "${name}": ${result.error}`, "warning");
		}
		activeName = name;
		activeProfile = profile;
		if (persist) {
			try {
				await saveLastProfile(agentDir, name);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			}
			persistState(name);
		}
		setStatus(ctx);
	}

	async function clear(ctx: ExtensionContext): Promise<void> {
		activeName = undefined;
		activeProfile = undefined;
		if (original?.model) await pi.setModel(original.model);
		if (original) {
			pi.setThinkingLevel(original.thinkingLevel);
			pi.setActiveTools(original.tools);
			if (original.themeName) {
				const result = ctx.ui.setTheme(original.themeName);
				if (!result.success) ctx.ui.notify(result.error ?? "theme restore failed", "warning");
			}
		}
		original = undefined;
		try {
			await saveLastProfile(agentDir, undefined);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
		persistState(undefined);
		setStatus(ctx);
	}

	async function choose(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(profiles).sort();
		if (names.length === 0) {
			ctx.ui.notify("No profiles defined", "warning");
			return;
		}
		const none = "(none)";
		const selected = await ctx.ui.select("Select profile", [none, ...names]);
		if (!selected) return;
		if (selected === none) {
			await clear(ctx);
			ctx.ui.notify("Profile cleared", "info");
			return;
		}
		await apply(selected, profiles[selected]!, ctx);
		ctx.ui.notify(`Profile "${selected}" activated`, "info");
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		if (Object.keys(profiles).length === 0) {
			ctx.ui.notify("No profiles defined", "warning");
			return;
		}
		const values = [undefined, ...Object.keys(profiles).sort()];
		const index = values.indexOf(activeName);
		const next = values[(index + 1) % values.length];
		if (!next) {
			await clear(ctx);
			ctx.ui.notify("Profile cleared", "info");
			return;
		}
		await apply(next, profiles[next]!, ctx);
		ctx.ui.notify(`Profile "${next}" activated`, "info");
	}

	pi.registerFlag("profile", { description: "Packed profile to activate", type: "string" });
	pi.registerCommand("profile", {
		description: "Switch Packed profile",
		getArgumentCompletions(prefix) {
			const matches = Object.keys(profiles)
				.sort()
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return matches.length ? matches : null;
		},
		async handler(args, ctx) {
			const name = args.trim();
			if (!name) {
				await choose(ctx);
				return;
			}
			const profile = profiles[name];
			if (!profile) {
				ctx.ui.notify(`Unknown profile "${name}"`, "error");
				return;
			}
			await apply(name, profile, ctx);
			ctx.ui.notify(`Profile "${name}" activated`, "info");
		},
	});
	pi.registerShortcut(Key.ctrlShift("u"), { description: "Cycle Packed profiles", handler: cycle });

	pi.on("model_select", (event, ctx) => {
		if (applyingModel || event.source === "restore" || !activeProfile?.allowedModels?.length) return;
		const selected = `${event.model.provider}/${event.model.id}`;
		if (!activeProfile.allowedModels.some((pattern) => matchesPattern(selected, pattern)))
			ctx.ui.notify(`${selected} is outside profile "${activeName}" allowedModels`, "warning");
	});
	pi.on("before_agent_start", (event) =>
		activeProfile?.instructions ? { systemPrompt: `${event.systemPrompt}\n\n${activeProfile.instructions}` } : undefined,
	);
	pi.on("session_start", async (event, ctx) => {
		try {
			profiles = loadProfiles(agentDir, ctx.cwd, ctx.isProjectTrusted());
		} catch (error) {
			profiles = {};
			ctx.ui.notify(`Profile configuration rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		const flag = pi.getFlag("profile");
		if (typeof flag === "string" && flag) {
			if (!profiles[flag]) {
				ctx.ui.notify(`Unknown profile "${flag}"`, "warning");
				setStatus(ctx);
				return;
			}
			await apply(flag, profiles[flag]!, ctx);
			ctx.ui.notify(`Profile "${flag}" activated`, "info");
			return;
		}
		const defaultProfile = loadDefaultProfile(ctx.cwd, ctx.isProjectTrusted());
		if ((event.reason === "reload" || event.reason === "new") && defaultProfile) {
			if (profiles[defaultProfile]) await apply(defaultProfile, profiles[defaultProfile]!, ctx, false);
			else {
				ctx.ui.notify(`Default profile "${defaultProfile}" is not defined`, "warning");
				setStatus(ctx);
			}
			return;
		}
		const state = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find(
				(entry: { type: string; customType?: string }) =>
					entry.type === "custom" && (entry.customType === "profile-state" || entry.customType === "packed-profile-state"),
			) as { data?: { name?: unknown } } | undefined;
		if (state) {
			if (typeof state.data?.name === "string" && profiles[state.data.name]) {
				activeName = state.data.name;
				activeProfile = profiles[state.data.name];
			}
			setStatus(ctx);
			return;
		}
		if (defaultProfile) {
			if (profiles[defaultProfile]) await apply(defaultProfile, profiles[defaultProfile]!, ctx, false);
			else {
				ctx.ui.notify(`Default profile "${defaultProfile}" is not defined`, "warning");
				setStatus(ctx);
			}
			return;
		}
		const last = loadLastProfile(agentDir);
		if (last && profiles[last]) {
			await apply(last, profiles[last]!, ctx, false);
			ctx.ui.notify(`Profile "${last}" restored`, "info");
		} else {
			if (last) ctx.ui.notify(`Last active profile "${last}" no longer exists`, "warning");
			setStatus(ctx);
		}
	});
}
