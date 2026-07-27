import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATION_NAMES } from "../src/service.ts";
import type { SetupApplyResult as CoreSetupApplyResult, SetupPlan as CoreSetupPlan } from "../src/setup.ts";
import type { ExtensionOperationName, SetupApplyResult as PublicSetupApplyResult, SetupPlan as PublicSetupPlan } from "../src/public/protocol.ts";

const publicPlan: PublicSetupPlan = {} as CoreSetupPlan;
const publicApply: PublicSetupApplyResult = {} as CoreSetupApplyResult;
void [publicPlan, publicApply];

const root = new URL("..", import.meta.url).pathname;
const extensionOperations: ExtensionOperationName[] = [
	"package.search", "package.info", "package.installed", "package.updates",
	"package.security.get", "package.security.set", "package.install", "package.remove", "package.update",
	"setup.plan", "setup.apply",
];

describe("compiled public boundary", () => {
	it("keeps the extension protocol aligned with daemon operations", () => {
		expect(extensionOperations.every((operation) => OPERATION_NAMES.includes(operation))).toBe(true);
	});

	it("loads under Node and contains no Bun-native implementation edge", async () => {
		const entry = join(root, "dist/client.js");
		const process = Bun.spawn(["node", "--input-type=module", "--eval", `import(${JSON.stringify(entry)}).then(m => console.log(typeof m.connectPackedClient))`], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout.trim()).toBe("function");
		const publicFiles = ["client.js", "client.d.ts", "protocol.d.ts"].map((name) => readFileSync(join(root, "dist", name), "utf8")).join("\n");
		expect(publicFiles).not.toMatch(/\bBun\b|bun:sqlite|\.\.\/(?:service|daemon|db|check)/);
	});
});
