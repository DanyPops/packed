export interface RepositoryPolicy {
	readonly allowedArtifacts?: readonly string[];
	readonly allowedDuplicateResolutions?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface RepositoryPolicyLimits {
	readonly maxTrackedPaths?: number;
	readonly maxManifests?: number;
	readonly maxLockBytes?: number;
}

export interface RepositoryManifest {
	readonly path: string;
	readonly value: Readonly<Record<string, unknown>>;
}

export interface RepositoryPolicyInput {
	readonly trackedPaths: readonly string[];
	readonly manifests: readonly RepositoryManifest[];
	readonly lockText: string;
	readonly policy: RepositoryPolicy;
	readonly limits?: RepositoryPolicyLimits;
}

export type RepositoryPolicyViolation =
	| { readonly code: "POLICY_INPUT_LIMIT"; readonly message: string }
	| { readonly code: "UNMANAGED_DEPENDENCY_ARTIFACT"; readonly path: string; readonly message: string }
	| { readonly code: "BUNDLED_DEPENDENCIES"; readonly path: string; readonly message: string }
	| {
			readonly code: "LOCAL_PATH_DEPENDENCY";
			readonly path: string;
			readonly packageName: string;
			readonly specifier: string;
			readonly message: string;
	  }
	| {
			readonly code: "DUPLICATE_INTERNAL_RESOLUTION";
			readonly packageName: string;
			readonly resolutions: Readonly<Record<string, readonly string[]>>;
			readonly message: string;
	  };

export interface RepositoryPolicyReport {
	readonly ok: boolean;
	readonly violations: readonly RepositoryPolicyViolation[];
}

const DEFAULT_MAX_TRACKED_PATHS = 100_000;
const DEFAULT_MAX_MANIFESTS = 1_000;
const DEFAULT_MAX_LOCK_BYTES = 20 * 1024 * 1024;
const ARCHIVE_PATTERN = /\.(?:7z|gem|jar|rar|tar|tar\.bz2|tar\.gz|tgz|war|whl|zip)$/i;
const MINIFIED_PATTERN = /\.min\.(?:css|js)$/i;
const LOCK_TUPLE_PATTERN = /"([^"]*)":\s*\["((?:@[^/"]+\/)?[^"@]+)@([^"]+)"/g;

function unmanagedArtifact(path: string): boolean {
	const segments = path.split("/");
	return (
		segments.includes("vendor") ||
		segments.includes("third_party") ||
		segments.includes("node_modules") ||
		ARCHIVE_PATTERN.test(path) ||
		MINIFIED_PATTERN.test(path)
	);
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/**
 * `workspace:*` (npm/pnpm/bun) is the correct, reproducible way to address a
 * sibling package inside this same repository -- never flagged. `file:`,
 * `link:`, and a bare absolute path (no protocol at all, which npm also
 * accepts) all point at a location that only exists on the machine that
 * wrote it: not installable from a clean clone or CI runner, invisible to
 * the lockfile's own version pinning, and -- per a real incident -- capable
 * of silently going stale or missing entirely with no install-time error.
 */
function isLocalPathSpecifier(specifier: string): boolean {
	if (specifier.startsWith("workspace:")) return false;
	if (specifier.startsWith("file:") || specifier.startsWith("link:")) return true;
	return /^(?:\/|[A-Za-z]:[\\/])/.test(specifier);
}

function normalizedResolutions(resolutions: Readonly<Record<string, readonly string[]>>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(resolutions)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([version, keys]) => [version, [...keys].sort()]),
		),
	);
}

function internalResolutions(lockText: string): Map<string, Map<string, Set<string>>> {
	const packages = new Map<string, Map<string, Set<string>>>();
	for (const match of lockText.matchAll(LOCK_TUPLE_PATTERN)) {
		const [, key, packageName, version] = match;
		if (!packageName?.startsWith("@danypops/") || version === undefined) continue;
		let versions = packages.get(packageName);
		if (!versions) {
			versions = new Map();
			packages.set(packageName, versions);
		}
		let keys = versions.get(version);
		if (!keys) {
			keys = new Set();
			versions.set(version, keys);
		}
		keys.add(key || "(root)");
	}
	return packages;
}

export function evaluateRepositoryPolicy(input: RepositoryPolicyInput): RepositoryPolicyReport {
	const maxTrackedPaths = input.limits?.maxTrackedPaths ?? DEFAULT_MAX_TRACKED_PATHS;
	const maxManifests = input.limits?.maxManifests ?? DEFAULT_MAX_MANIFESTS;
	const maxLockBytes = input.limits?.maxLockBytes ?? DEFAULT_MAX_LOCK_BYTES;
	const lockBytes = Buffer.byteLength(input.lockText);
	if (input.trackedPaths.length > maxTrackedPaths || input.manifests.length > maxManifests || lockBytes > maxLockBytes) {
		return {
			ok: false,
			violations: [
				{
					code: "POLICY_INPUT_LIMIT",
					message: `Policy input exceeds a bound: paths ${input.trackedPaths.length}/${maxTrackedPaths}, manifests ${input.manifests.length}/${maxManifests}, lock bytes ${lockBytes}/${maxLockBytes}`,
				},
			],
		};
	}

	const violations: RepositoryPolicyViolation[] = [];
	const allowedArtifacts = new Set(input.policy.allowedArtifacts ?? []);
	for (const path of input.trackedPaths) {
		if (unmanagedArtifact(path) && !allowedArtifacts.has(path)) {
			violations.push({
				code: "UNMANAGED_DEPENDENCY_ARTIFACT",
				path,
				message: `${path} looks like unmanaged vendored dependency content`,
			});
		}
	}

	for (const manifest of input.manifests) {
		const bundled = manifest.value.bundledDependencies ?? manifest.value.bundleDependencies;
		if (Array.isArray(bundled) && bundled.length > 0) {
			violations.push({
				code: "BUNDLED_DEPENDENCIES",
				path: manifest.path,
				message: `${manifest.path} bundles dependencies instead of declaring them for normal resolution`,
			});
		}

		for (const field of DEPENDENCY_FIELDS) {
			const dependencies = manifest.value[field];
			if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
			for (const [packageName, specifier] of Object.entries(dependencies as Record<string, unknown>)) {
				if (typeof specifier !== "string" || !isLocalPathSpecifier(specifier)) continue;
				violations.push({
					code: "LOCAL_PATH_DEPENDENCY",
					path: manifest.path,
					packageName,
					specifier,
					message: `${manifest.path}: ${field}.${packageName} is "${specifier}", a local filesystem path instead of a registry version`,
				});
			}
		}
	}

	for (const [packageName, versions] of internalResolutions(input.lockText)) {
		if (versions.size < 2) continue;
		const resolutions = Object.fromEntries(
			[...versions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([version, keys]) => [version, [...keys].sort()]),
		);
		const allowed = input.policy.allowedDuplicateResolutions?.[packageName];
		if (allowed && normalizedResolutions(allowed) === normalizedResolutions(resolutions)) continue;
		violations.push({
			code: "DUPLICATE_INTERNAL_RESOLUTION",
			packageName,
			resolutions,
			message: `${packageName} resolves to ${versions.size} versions`,
		});
	}

	return { ok: violations.length === 0, violations };
}
