import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_OPERATIONS, packagePermissionDecision, readSecuritySettings, writeSecuritySettings } from "../src/security/security.ts";

describe("package permission policy", () => {
	it("defaults every arbitrary-code and settings/install-root mutation to approval", () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-security-"));
		const settings = readSecuritySettings(dir);
		expect(settings).toEqual({ mutationApproval: "always" });
		expect(PACKAGE_OPERATIONS).toEqual([
			"search",
			"info",
			"installed",
			"catalog",
			"index.status",
			"index.build",
			"updates",
			"check",
			"setup.plan",
			"security.read",
			"mirror",
			"setup.export",
			"setup.update",
			"install",
			"install_service",
			"restart_service",
			"reconcile_services",
			"setup.apply",
			"update",
			"update.self",
			"remove",
			"resources.list",
			"resources.toggle",
			"security.write",
			"pi.status",
			"advisories.scan",
			"doctor",
		]);
		const decisions = Object.fromEntries(
			PACKAGE_OPERATIONS.map((operation) => [operation, packagePermissionDecision(settings, operation)]),
		);
		expect(decisions).toMatchObject({
			search: { classification: "read", approvalRequired: false },
			info: { classification: "read", approvalRequired: false },
			installed: { classification: "read", approvalRequired: false },
			catalog: { classification: "read", approvalRequired: false },
			"index.status": { classification: "read", approvalRequired: false },
			"index.build": { classification: "maintenance", approvalRequired: false },
			updates: { classification: "read", approvalRequired: false },
			check: { classification: "read", approvalRequired: false },
			"setup.plan": { classification: "read", approvalRequired: false },
			"security.read": { classification: "read", approvalRequired: false },
			mirror: { classification: "maintenance", approvalRequired: false },
			"setup.export": { classification: "maintenance", approvalRequired: false },
			"setup.update": { classification: "maintenance", approvalRequired: false },
			install: { classification: "code-execution", approvalRequired: true },
			install_service: { classification: "code-execution", approvalRequired: true },
			restart_service: { classification: "code-execution", approvalRequired: true },
			"setup.apply": { classification: "code-execution", approvalRequired: true },
			update: { classification: "code-execution", approvalRequired: true },
			"update.self": { classification: "code-execution", approvalRequired: true },
			remove: { classification: "settings-mutation", approvalRequired: true },
			"resources.list": { classification: "read", approvalRequired: false },
			"resources.toggle": { classification: "settings-mutation", approvalRequired: true },
			"security.write": { classification: "security-mutation", approvalRequired: true },
			"pi.status": { classification: "read", approvalRequired: false },
			"advisories.scan": { classification: "read", approvalRequired: false },
			doctor: { classification: "read", approvalRequired: false },
		});
	});

	it("persists an explicit unsafe opt-out and migrates the prior storage key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "packed-security-"));
		expect(await writeSecuritySettings(dir, { mutationApproval: "never" })).toEqual({ mutationApproval: "never" });
		expect(readSecuritySettings(dir)).toEqual({ mutationApproval: "never" });

		const legacyDir = mkdtempSync(join(tmpdir(), "packed-security-legacy-"));
		writeFileSync(join(legacyDir, "security.json"), '{"installApproval":"never"}\n');
		expect(readSecuritySettings(legacyDir)).toEqual({ mutationApproval: "never" });
	});

	it("makes the explicit opt-out govern every guarded operation", () => {
		const settings = { mutationApproval: "never" as const };
		for (const operation of PACKAGE_OPERATIONS) {
			expect(packagePermissionDecision(settings, operation).approvalRequired).toBe(false);
		}
	});
});
