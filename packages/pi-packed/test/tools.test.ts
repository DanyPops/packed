import { describe, expect, it } from "bun:test";
import { InstallServiceError, type Natives, PI_COMMAND_NAME } from "../extension/src/packed.ts";
import { installPackageWithPolicy, registerTools, removePackageWithPolicy, updatePackageWithPolicy } from "../extension/src/tools.ts";

/** The overwhelmingly common case: an ordinary test package that isn't a daemon at all. */
async function notADaemonInstallService(): Promise<never> {
	throw new InstallServiceError(
		"pkg does not declare a packed.daemonService manifest and no Vehicle-shaped daemon dependency was detected",
		true,
	);
}

describe("native package mutation permission policy", () => {
	it("requires confirmation for install under the secure default", async () => {
		let installs = 0;
		let confirms = 0;
		const result = await installPackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "always" };
				},
				async install(_source, approved) {
					expect(approved).toBe(true);
					installs += 1;
					return "installed";
				},
				async installService() {
					throw new Error("must not be called -- confirm is declined before install ever runs");
				},
			},
			{
				hasUI: true,
				ui: {
					async confirm() {
						confirms += 1;
						return false;
					},
				},
			},
		);
		expect(confirms).toBe(1);
		expect(installs).toBe(0);
		expect(result.content[0]?.text).toContain("cancelled");
		if (result.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(result.details.status).toBe("cancelled");
	});

	it("requires the same confirmation for update and returns reload guidance", async () => {
		let updates = 0;
		const result = await updatePackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "always" };
				},
				async update(_source, approved) {
					expect(approved).toBe(true);
					updates += 1;
					return { output: "updated", reloadRequired: true, alreadyUpToDate: false, pinned: false };
				},
			},
			{
				hasUI: true,
				ui: {
					async confirm(_title, message) {
						expect(message).toContain("pi update --extension npm:pkg");
						return true;
					},
				},
			},
		);
		expect(updates).toBe(1);
		expect(result.content[0]?.text).toContain("/reload");
	});

	it("escalates install/update/remove of Packed's own package to restart wording, both in the approval dialog and the final message -- /reload cannot fix this (confirmed live)", async () => {
		const security = async () => ({ mutationApproval: "always" as const });
		const confirmMessages: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				async confirm(_title: string, message: string) {
					confirmMessages.push(message);
					return true;
				},
			},
		};

		const installResult = await installPackageWithPolicy(
			"npm:@danypops/pi-packed",
			{
				security,
				async install() {
					return "";
				},
				async installService() {
					throw new InstallServiceError("n/a", true);
				},
			},
			ctx,
		);
		if (installResult.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(installResult.details.restartRequired).toBe(true);
		expect(installResult.content[0]?.text).toContain("Restart Pi");
		expect(installResult.content[0]?.text).not.toContain("/reload");

		const updateResult = await updatePackageWithPolicy(
			"npm:@danypops/pi-packed",
			{
				security,
				async update() {
					return {
						output: "updated",
						reloadRequired: true,
						alreadyUpToDate: false,
						pinned: false,
						previousVersion: "0.21.13",
						currentVersion: "0.21.14",
					};
				},
			},
			ctx,
		);
		if (updateResult.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(updateResult.details.restartRequired).toBe(true);
		expect(updateResult.content[0]?.text).toContain("Restart Pi");
		expect(updateResult.content[0]?.text).not.toContain("Reload with /reload");

		const removeResult = await removePackageWithPolicy(
			"@danypops/pi-packed",
			{
				security,
				async remove() {
					return "";
				},
			},
			ctx,
		);
		if (removeResult.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(removeResult.details.restartRequired).toBe(true);
		expect(removeResult.content[0]?.text).toContain("Restart Pi");
		expect(removeResult.content[0]?.text).not.toContain("/reload");

		// Every one of the three pre-confirmation dialogs said restart, not reload.
		expect(confirmMessages).toHaveLength(3);
		for (const message of confirmMessages) {
			expect(message).toContain("restart");
			expect(message).toContain("exit and relaunch");
		}

		// An ordinary package's mutations are completely unaffected.
		const ordinary = await installPackageWithPolicy(
			"npm:pkg",
			{
				security,
				async install() {
					return "";
				},
				async installService() {
					throw new InstallServiceError("n/a", true);
				},
			},
			ctx,
		);
		if (ordinary.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(ordinary.details.restartRequired).toBeUndefined();
		expect(ordinary.content[0]?.text).toContain("/reload");
	});

	it("requires the same confirmation for remove", async () => {
		let removes = 0;
		const result = await removePackageWithPolicy(
			"pkg",
			{
				async security() {
					return { mutationApproval: "always" };
				},
				async remove(_name, approved) {
					expect(approved).toBe(true);
					removes += 1;
					return "removed";
				},
			},
			{
				hasUI: true,
				ui: {
					async confirm(_title, message) {
						expect(message).toContain("pi remove npm:pkg");
						return true;
					},
				},
			},
		);
		expect(removes).toBe(1);
		expect(result.content[0]?.text).toBe("removed");
	});

	it("reports non-interactive approval refusal as denied rather than cancelled", async () => {
		const result = await installPackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "always" };
				},
				async install() {
					throw new Error("must not install");
				},
				async installService() {
					throw new Error("must not be called -- approval is refused before install ever runs");
				},
			},
			{
				hasUI: false,
				ui: {
					async confirm() {
						return false;
					},
				},
			},
		);
		if (result.details.kind !== "mutation") throw new Error("expected mutation details");
		expect(result.details.status).toBe("denied");
	});

	it("propagates daemon failures through Pi's native error channel", async () => {
		await expect(
			installPackageWithPolicy(
				"npm:pkg",
				{
					async security() {
						return { mutationApproval: "never" };
					},
					async install() {
						throw new Error("daemon unavailable");
					},
					async installService() {
						throw new Error("must not be called -- install itself already failed");
					},
				},
				{
					hasUI: false,
					ui: {
						async confirm() {
							return false;
						},
					},
				},
			),
		).rejects.toThrow("daemon unavailable");
	});

	it("allows the explicit never policy without UI for every guarded operation", async () => {
		let installs = 0;
		const result = await installPackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "never" };
				},
				async install(_source, approved) {
					expect(approved).toBe(false);
					installs += 1;
					return "installed";
				},
				installService: notADaemonInstallService,
			},
			{
				hasUI: false,
				ui: {
					async confirm() {
						throw new Error("must not prompt");
					},
				},
			},
		);
		expect(installs).toBe(1);
		expect(result.content[0]?.text).toBe("installed");
	});

	it("install auto-registers a detected daemon service under the same approval, appended to the model-facing output", async () => {
		let serviceApproved: boolean | undefined;
		const result = await installPackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "never" };
				},
				async install() {
					return "installed";
				},
				async installService(_source, approved) {
					serviceApproved = approved;
					return { output: "installed a persistent service for npm:pkg" };
				},
			},
			{
				hasUI: false,
				ui: {
					async confirm() {
						throw new Error("must not prompt");
					},
				},
			},
		);
		expect(serviceApproved).toBe(false);
		expect(result.content[0]?.text).toBe("installed\ninstalled a persistent service for npm:pkg");
	});

	it("reports a genuine installService failure (a daemon was detected but registration failed) without failing the install", async () => {
		const result = await installPackageWithPolicy(
			"npm:pkg",
			{
				async security() {
					return { mutationApproval: "never" };
				},
				async install() {
					return "installed";
				},
				async installService() {
					throw new InstallServiceError("systemctl not found");
				},
			},
			{
				hasUI: false,
				ui: {
					async confirm() {
						throw new Error("must not prompt");
					},
				},
			},
		);
		expect(result.content[0]?.text).toBe(
			"installed\nnote: detected a persistent-service daemon but could not register it: systemctl not found",
		);
	});

	it("never attempts service detection for a non-npm source", async () => {
		const result = await installPackageWithPolicy(
			"git:github.com/u/r@v1",
			{
				async security() {
					return { mutationApproval: "never" };
				},
				async install() {
					return "installed";
				},
				async installService() {
					throw new Error("must not be called for a non-npm source");
				},
			},
			{
				hasUI: false,
				ui: {
					async confirm() {
						throw new Error("must not prompt");
					},
				},
			},
		);
		expect(result.content[0]?.text).toBe("installed");
	});

	it("registers all five tools with independent renderers and bounded details", async () => {
		const tools: any[] = [];
		const natives = {
			async search() {
				return { query: "theme", total: 1, results: [{ name: "pkg", version: "1.0.0", description: "result" }] };
			},
			async info() {
				return { name: "pkg", version: "1.0.0", pi: { extensions: ["private.ts"] } };
			},
			async security() {
				return { mutationApproval: "never" as const };
			},
			async install() {
				return "installed";
			},
			async update() {
				return "updated";
			},
			async remove() {
				return "removed";
			},
		} as unknown as Natives;
		registerTools(
			{
				registerTool(tool: unknown) {
					tools.push(tool);
				},
			} as any,
			natives,
		);
		expect(tools).toHaveLength(5);
		expect(tools.every((tool) => typeof tool.renderCall === "function" && typeof tool.renderResult === "function")).toBe(true);
		const search = tools.find((tool) => tool.name === "pkg_search");
		const result = await search.execute("id", { query: "theme", limit: 10 });
		expect(result.details.kind).toBe("search");
		expect(result.content[0].text.length).toBeLessThanOrEqual(2_000);
	});

	it("pkg_info reports Pi's own local-vs-latest version when queried by its exact package name, in addition to the normal registry metadata", async () => {
		const tools: any[] = [];
		const natives = {
			async info(name: string) {
				return { name, version: "0.83.0", description: "Coding agent" };
			},
			async piStatus() {
				return { current: "0.82.1", latest: "0.83.0", upToDate: false };
			},
		} as unknown as Natives;
		registerTools(
			{
				registerTool(tool: unknown) {
					tools.push(tool);
				},
			} as any,
			natives,
		);
		const info = tools.find((tool) => tool.name === "pkg_info");
		const result = await info.execute("id", { name: PI_COMMAND_NAME });
		expect(result.content[0].text).toContain(`${PI_COMMAND_NAME}@0.83.0`); // normal registry line still present
		expect(result.content[0].text).toContain("Pi runtime (not npm registry data)");
		expect(result.content[0].text).toContain("currently running: 0.82.1");
		expect(result.content[0].text).toContain("behind -- latest is 0.83.0, run pi update --self");
	});

	it("pkg_info leaves an ordinary package's output completely unaffected -- the special case is scoped to Pi's exact package name, never a general behavior change", async () => {
		const tools: any[] = [];
		const natives = {
			async info(name: string) {
				return { name, version: "1.0.0", description: "an ordinary Pi extension" };
			},
			async piStatus() {
				throw new Error("must never be called for an ordinary package");
			},
		} as unknown as Natives;
		registerTools(
			{
				registerTool(tool: unknown) {
					tools.push(tool);
				},
			} as any,
			natives,
		);
		const info = tools.find((tool) => tool.name === "pkg_info");
		const result = await info.execute("id", { name: "pi-lsp" });
		expect(result.content[0].text).toBe("pi-lsp@1.0.0\nan ordinary Pi extension");
		expect(result.content[0].text).not.toContain("Pi runtime");
	});
});
