import { describe, expect, it } from "bun:test";
import { evaluateRepositoryPolicy, type RepositoryPolicyInput } from "../src/public/repository-policy.js";

function input(overrides: Partial<RepositoryPolicyInput> = {}): RepositoryPolicyInput {
	return {
		trackedPaths: ["package.json", "packages/example/package.json", "src/index.ts"],
		manifests: [
			{ path: "package.json", value: { private: true } },
			{ path: "packages/example/package.json", value: { name: "@example/package" } },
		],
		lockText: '[packages]\n"@danypops/example": ["@danypops/example@1.0.0", ""]',
		policy: {},
		...overrides,
	};
}

describe("repository policy", () => {
	it.each([
		"vendor/library/index.js",
		"third_party/library/index.js",
		"packages/example/node_modules/library/index.js",
		"fixtures/archive.tgz",
		"public/library.min.js",
	])("rejects unmanaged dependency artifact %s", (path) => {
		const result = evaluateRepositoryPolicy(input({ trackedPaths: ["package.json", path] }));
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({ code: "UNMANAGED_DEPENDENCY_ARTIFACT", path });
	});

	it("permits only exact artifact exceptions", () => {
		const path = "fixtures/archive.tgz";
		const result = evaluateRepositoryPolicy(input({ trackedPaths: ["package.json", path], policy: { allowedArtifacts: [path] } }));
		expect(result).toEqual({ ok: true, violations: [] });
	});

	it.each(["bundledDependencies", "bundleDependencies"] as const)("rejects %s", (field) => {
		const result = evaluateRepositoryPolicy(input({ manifests: [{ path: "package.json", value: { [field]: ["dependency"] } }] }));
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({ code: "BUNDLED_DEPENDENCIES", path: "package.json" });
	});

	it.each([
		"file:../sibling-repo/packages/example",
		"file:/home/user/Projects/example",
		"link:../example",
		"/home/user/Projects/example",
		"C:\\Projects\\example",
	])("rejects local path dependency specifier %s", (specifier) => {
		const result = evaluateRepositoryPolicy(
			input({ manifests: [{ path: "package.json", value: { dependencies: { "@example/lib": specifier } } }] }),
		);
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			code: "LOCAL_PATH_DEPENDENCY",
			path: "package.json",
			packageName: "@example/lib",
			specifier,
		});
	});

	it("checks every dependency field, not just dependencies", () => {
		const result = evaluateRepositoryPolicy(
			input({
				manifests: [
					{
						path: "package.json",
						value: {
							devDependencies: { "@example/dev": "file:../dev" },
							peerDependencies: { "@example/peer": "file:../peer" },
							optionalDependencies: { "@example/optional": "file:../optional" },
						},
					},
				],
			}),
		);
		expect(result.ok).toBe(false);
		expect(result.violations.map((violation) => ("packageName" in violation ? violation.packageName : undefined)).sort()).toEqual([
			"@example/dev",
			"@example/optional",
			"@example/peer",
		]);
	});

	it("never flags a workspace: specifier", () => {
		const result = evaluateRepositoryPolicy(
			input({ manifests: [{ path: "package.json", value: { dependencies: { "@example/sibling": "workspace:*" } } }] }),
		);
		expect(result).toEqual({ ok: true, violations: [] });
	});

	it("reports every locked version and introducer for duplicated internal packages", () => {
		const lockText = `
[packages]
"@danypops/example": ["@danypops/example@2.0.0", ""]
"consumer/@danypops/example": ["@danypops/example@1.0.0", ""]
`;
		const result = evaluateRepositoryPolicy(input({ lockText }));
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			code: "DUPLICATE_INTERNAL_RESOLUTION",
			packageName: "@danypops/example",
			resolutions: {
				"1.0.0": ["consumer/@danypops/example"],
				"2.0.0": ["@danypops/example"],
			},
		});
	});

	it("accepts an unavoidable duplicate only while its exact resolution set matches", () => {
		const resolutions = {
			"1.0.0": ["consumer/@danypops/example"],
			"2.0.0": ["@danypops/example"],
		};
		const lockText = `
[packages]
"@danypops/example": ["@danypops/example@2.0.0", ""]
"consumer/@danypops/example": ["@danypops/example@1.0.0", ""]
`;
		const accepted = evaluateRepositoryPolicy(
			input({ lockText, policy: { allowedDuplicateResolutions: { "@danypops/example": resolutions } } }),
		);
		expect(accepted).toEqual({ ok: true, violations: [] });

		const drifted = evaluateRepositoryPolicy(
			input({
				lockText: `${lockText}\n"other/@danypops/example": ["@danypops/example@1.0.0", ""]`,
				policy: { allowedDuplicateResolutions: { "@danypops/example": resolutions } },
			}),
		);
		expect(drifted.ok).toBe(false);
	});

	it("bounds tracked paths, manifests, and lockfile input", () => {
		expect(evaluateRepositoryPolicy(input({ trackedPaths: ["a", "b"], limits: { maxTrackedPaths: 1 } })).violations[0]?.code).toBe(
			"POLICY_INPUT_LIMIT",
		);
		expect(
			evaluateRepositoryPolicy(input({ manifests: [{ path: "package.json", value: {} }], limits: { maxManifests: 0 } })).violations[0]
				?.code,
		).toBe("POLICY_INPUT_LIMIT");
		expect(evaluateRepositoryPolicy(input({ lockText: "too large", limits: { maxLockBytes: 1 } })).violations[0]?.code).toBe(
			"POLICY_INPUT_LIMIT",
		);
	});
});
