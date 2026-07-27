import { createJiti } from "jiti";

interface Registrations {
	tools: string[];
	commands: string[];
	shortcuts: string[];
	flags: string[];
	providers: string[];
	events: string[];
	renderers: string[];
}

const MAX_REGISTRATIONS_TOTAL = 100;
const MAX_NAME_LENGTH = 128;
const originalWrite = process.stdout.write.bind(process.stdout);
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};
globalThis.fetch = Object.assign(async () => {
	const error = new Error("network disabled by Packed smoke sandbox") as Error & { code: string };
	error.code = "ENETUNREACH";
	throw error;
}, { preconnect() {} }) as typeof fetch;
const denyProcess = () => {
	const error = new Error("subprocesses disabled by Packed smoke sandbox") as Error & { code: string };
	error.code = "EPERM";
	throw error;
};
const bunRuntime = Bun as unknown as Record<string, unknown>;
bunRuntime.spawn = denyProcess;
bunRuntime.spawnSync = denyProcess;
bunRuntime.$ = denyProcess;

const registrations: Registrations = {
	tools: [], commands: [], shortcuts: [], flags: [], providers: [], events: [], renderers: [],
};

function capture(kind: keyof Registrations, value: unknown): void {
	if (Object.values(registrations).reduce((total, values) => total + values.length, 0) >= MAX_REGISTRATIONS_TOTAL) return;
	const name = typeof value === "string" ? value : "";
	registrations[kind].push(name.slice(0, MAX_NAME_LENGTH));
}

const api = new Proxy<Record<string, unknown>>({}, {
	get(_target, property) {
		switch (property) {
			case "registerTool": return (definition: { name?: unknown }) => capture("tools", definition?.name);
			case "registerCommand": return (name: unknown) => capture("commands", name);
			case "registerShortcut": return (name: unknown) => capture("shortcuts", name);
			case "registerFlag": return (name: unknown) => capture("flags", name);
			case "registerProvider": return (name: unknown) => capture("providers", name);
			case "registerMessageRenderer": return (name: unknown) => capture("renderers", name);
			case "on": return (name: unknown) => capture("events", name);
			case "getAllTools": return () => [];
			case "getActiveTools": return () => [];
			case "getCommands": return () => [];
			default: return () => undefined;
		}
	},
});

function classify(error: unknown): "capability-denied" | "crash" {
	const value = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
	const code = String(value?.code ?? value?.cause?.code ?? "");
	const message = String(value?.message ?? error ?? "");
	return /^(?:EACCES|EPERM|EROFS|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|EAGAIN)$/.test(code)
		|| /permission denied|operation not permitted|read-only file system|network is unreachable|failed to connect|unable to connect|resource temporarily unavailable/i.test(message)
		? "capability-denied"
		: "crash";
}

async function main(): Promise<void> {
	const extensionPath = process.argv[2];
	if (!extensionPath) throw new Error("extension path is required");
	try {
		const jiti = createJiti(import.meta.url, { interopDefault: true, tryNative: false });
		const factory = await jiti.import(extensionPath, { default: true }) as unknown;
		if (typeof factory !== "function") throw new Error("extension has no default factory export");
		await factory(api);
		originalWrite(`${JSON.stringify({ status: "ok", registrations })}\n`);
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
		originalWrite(`${JSON.stringify({ status: classify(error), message, registrations })}\n`);
	}
}

await main();
