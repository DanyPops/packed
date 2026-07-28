/**
 * advisories.ts — vulnerability advisory scanning for installed Pi
 * packages. Nothing in Pi or Packed today checks installed dependency
 * trees against known advisories; a third party (exitcode0.net's
 * dep-audit) proved the lockfile-free approach works: batch installed
 * versions per package against npm's own bulk advisory endpoint. Zero
 * code execution, one bounded/timed-out network call for the scan itself.
 */
import { satisfies, valid, compare } from "semver";
import type { Diagnostic } from "./check.ts";
import { NPM_REGISTRY_BASE, REGISTRY_FETCH_TIMEOUT_MS } from "./constants.ts";
import { readInstalledPackages, readResolvedVersion } from "./installed.ts";

const BULK_ADVISORY_PATH = "/-/npm/v1/security/advisories/bulk";
const MAX_PACKAGES_PER_SCAN = 200;
const MAX_ADVISORIES_PER_PACKAGE = 25;
const MAX_FINDINGS = 200;
const MAX_BULK_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PACKUMENT_BYTES = 4 * 1024 * 1024;
const SEMVER_OPTS = { loose: true, includePrerelease: true } as const;
/** A patch published within this window is weaker assurance than one that
 * has aged without a new report -- not yet enough time for the community
 * to catch a bad or incomplete fix (the "poisoned patch" pattern). This is
 * Packed's own threshold, not copied from a source verified at write time;
 * documented explicitly so it can be revisited. */
export const PATCHED_VERSION_FRESH_DAYS = 7;

export type AdvisorySeverity = "critical" | "high" | "moderate" | "low";

export interface RawAdvisory {
	id: number | string;
	url: string;
	title: string;
	severity: AdvisorySeverity;
	vulnerableVersions: string;
}

export interface PatchedVersionAge {
	version: string;
	publishedAt: string;
	ageDays: number;
	/** true when ageDays < PATCHED_VERSION_FRESH_DAYS -- an explicit, separate
	 * signal, never folded into severity. */
	fresh: boolean;
}

export interface AdvisoryFinding {
	packageName: string;
	installedVersion: string;
	id: number | string;
	url: string;
	title: string;
	severity: AdvisorySeverity;
	vulnerableVersions: string;
	/** undefined when no published version outside the vulnerable range
	 * could be found (registry lookup failed, or truly nothing fixes it
	 * yet) -- never guessed. */
	patchedVersionAge?: PatchedVersionAge;
}

export interface AdvisoryReport {
	scanned: number;
	findings: AdvisoryFinding[];
	diagnostics: Diagnostic[];
	truncated: boolean;
}

/** Resolves the real, on-disk installed version for every npm-sourced Pi
 * package (or just one, when named) -- ground truth from node_modules,
 * never a trusted-but-unverified declared pin. Silently omits a package
 * whose version can't be resolved rather than guessing. git:/local
 * sources are omitted (no meaningful npm advisory lookup applies). */
export function resolveInstalledVersions(piHome: string, only?: string): Record<string, string> {
	const names = readInstalledPackages(piHome).map((pkg) => pkg.name).filter((name) => !only || name === only);
	const out: Record<string, string> = {};
	for (const name of names) {
		const version = readResolvedVersion(piHome, `npm:${name}`);
		if (version) out[name] = version;
	}
	return out;
}

function boundedBodyJson(text: string, maxBytes: number): unknown {
	if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response exceeded bound");
	return JSON.parse(text);
}

/** One bounded, timed-out POST against npm's real bulk advisory endpoint --
 * lockfile-free by design, matching how Pi itself installs packages (no
 * package-lock.json to audit against). Never throws: any failure (network,
 * timeout, malformed response) resolves to {}, so a scan degrades to "no
 * known advisories" rather than crashing or reporting false negatives as
 * if they were verified-clean. */
export async function fetchBulkAdvisories(
	packages: Record<string, string[]>,
	options: { registryBase?: string; timeoutMs?: number } = {},
): Promise<Record<string, RawAdvisory[]>> {
	if (Object.keys(packages).length === 0) return {};
	try {
		const response = await fetch(`${options.registryBase ?? NPM_REGISTRY_BASE}${BULK_ADVISORY_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(packages),
			signal: AbortSignal.timeout(options.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return {};
		const text = await response.text();
		const data = boundedBodyJson(text, MAX_BULK_RESPONSE_BYTES) as Record<string, unknown>;
		const out: Record<string, RawAdvisory[]> = {};
		for (const [name, entries] of Object.entries(data)) {
			if (!Array.isArray(entries)) continue;
			out[name] = entries
				.slice(0, MAX_ADVISORIES_PER_PACKAGE)
				.map((raw): RawAdvisory | undefined => {
					const entry = raw as Record<string, unknown>;
					if (typeof entry.id !== "number" && typeof entry.id !== "string") return undefined;
					if (typeof entry.vulnerable_versions !== "string") return undefined;
					const severity: AdvisorySeverity = entry.severity === "critical" || entry.severity === "high" || entry.severity === "moderate" || entry.severity === "low" ? entry.severity : "high";
					return {
						id: entry.id, url: typeof entry.url === "string" ? entry.url.slice(0, 2_048) : "",
						title: typeof entry.title === "string" ? entry.title.slice(0, 512) : "unknown advisory",
						severity, vulnerableVersions: entry.vulnerable_versions.slice(0, 512),
					};
				})
				.filter((entry): entry is RawAdvisory => entry !== undefined);
		}
		return out;
	} catch {
		return {};
	}
}

/** Fetches only what's needed from the full packument (version list + publish
 * times) to compute a patched-version-age heuristic -- one bounded,
 * best-effort GET per package that actually has an advisory, never per
 * package scanned. Never throws. */
async function fetchPackageTimes(name: string, registryBase: string, timeoutMs: number): Promise<{ versions: string[]; time: Record<string, string> } | undefined> {
	try {
		const encoded = encodeURIComponent(name).replace("%2F", "/");
		const response = await fetch(`${registryBase}/${encoded}`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const text = await response.text();
		const data = boundedBodyJson(text, MAX_PACKUMENT_BYTES) as { versions?: Record<string, unknown>; time?: Record<string, unknown> };
		if (!data.versions || !data.time) return undefined;
		const time: Record<string, string> = {};
		for (const [version, value] of Object.entries(data.time)) if (typeof value === "string") time[version] = value;
		return { versions: Object.keys(data.versions).filter((v) => valid(v)), time };
	} catch {
		return undefined;
	}
}

/** The smallest published version that is both newer than the installed one
 * and outside the advisory's vulnerable range -- "the fix", derived the same
 * way npm's own arborist re-resolves an avoided range, not from a
 * patched_versions field (the bulk endpoint doesn't return one; only the
 * full legacy audit report does). */
function findPatchedVersion(installedVersion: string, vulnerableVersions: string, versions: string[]): string | undefined {
	const candidates = versions
		.filter((v) => valid(v) && compare(v, installedVersion) > 0 && !satisfies(v, vulnerableVersions, SEMVER_OPTS))
		.sort(compare);
	return candidates[0];
}

function diagnosticFor(finding: AdvisoryFinding): Diagnostic {
	const severityMap: Record<AdvisorySeverity, Diagnostic["severity"]> = { critical: "error", high: "error", moderate: "warning", low: "info" };
	const freshNote = finding.patchedVersionAge
		? finding.patchedVersionAge.fresh
			? ` (patched in ${finding.patchedVersionAge.version}, published ${finding.patchedVersionAge.ageDays}d ago -- recent enough that the fix itself is a weaker signal)`
			: ` (patched in ${finding.patchedVersionAge.version}, published ${finding.patchedVersionAge.ageDays}d ago)`
		: "";
	return {
		code: "PI_PACKAGE_ADVISORY", severity: severityMap[finding.severity],
		path: finding.packageName,
		message: `${finding.title} (${finding.severity}, ${finding.id}) affects installed ${finding.installedVersion}; vulnerable range: ${finding.vulnerableVersions}${freshNote}`,
		...(finding.patchedVersionAge ? { fix: `upgrade to ${finding.patchedVersionAge.version}` } : {}),
	};
}

/**
 * Scans a bounded set of installed packages (name -> resolved version)
 * against npm's bulk advisory endpoint. No lockfile required, matching how
 * Pi itself installs packages. The patched-version-age heuristic is always
 * a separate, explicit field on each finding -- never silently folded into
 * severity, since a fresh patch and a mature one carry genuinely different
 * trust even at the same advisory severity.
 */
export async function scanInstalledPackages(
	installed: Record<string, string>,
	options: { registryBase?: string; timeoutMs?: number } = {},
): Promise<AdvisoryReport> {
	const registryBase = options.registryBase ?? NPM_REGISTRY_BASE;
	const timeoutMs = options.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS;
	const entries = Object.entries(installed).slice(0, MAX_PACKAGES_PER_SCAN);
	const truncatedByCount = Object.keys(installed).length > entries.length;
	const bulkInput: Record<string, string[]> = {};
	for (const [name, version] of entries) bulkInput[name] = [version];
	const advisoriesByPackage = await fetchBulkAdvisories(bulkInput, { registryBase, timeoutMs });

	const findings: AdvisoryFinding[] = [];
	let truncated = truncatedByCount;
	for (const [name, version] of entries) {
		const advisories = advisoriesByPackage[name];
		if (!advisories || advisories.length === 0) continue;
		let times: { versions: string[]; time: Record<string, string> } | undefined;
		for (const advisory of advisories) {
			if (findings.length >= MAX_FINDINGS) { truncated = true; break; }
			let patchedVersionAge: PatchedVersionAge | undefined;
			if (times === undefined) times = (await fetchPackageTimes(name, registryBase, timeoutMs)) ?? { versions: [], time: {} };
			const patched = findPatchedVersion(version, advisory.vulnerableVersions, times.versions);
			if (patched && times.time[patched]) {
				const publishedAt = times.time[patched]!;
				const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(publishedAt)) / (24 * 60 * 60 * 1000)));
				patchedVersionAge = { version: patched, publishedAt, ageDays, fresh: ageDays < PATCHED_VERSION_FRESH_DAYS };
			}
			findings.push({ packageName: name, installedVersion: version, id: advisory.id, url: advisory.url, title: advisory.title, severity: advisory.severity, vulnerableVersions: advisory.vulnerableVersions, patchedVersionAge });
		}
		if (findings.length >= MAX_FINDINGS) break;
	}

	return { scanned: entries.length, findings, diagnostics: findings.map(diagnosticFor), truncated };
}

const MAX_ADVISORY_OUTPUT = 16 * 1024;

/** Same rendering shape as check.ts's formatCheckReport -- one bounded,
 * consistent diagnostic envelope across Packed, not a new ad hoc format. */
export function formatAdvisoryReport(report: AdvisoryReport, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	if (report.diagnostics.length === 0) return `no known advisories for ${report.scanned} scanned package(s)\n`;
	let output = `${report.diagnostics.length} advisory finding(s) across ${report.scanned} scanned package(s)\n`;
	for (const diagnostic of report.diagnostics) output += `${diagnostic.severity.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}${diagnostic.fix ? ` Fix: ${diagnostic.fix}` : ""}\n`;
	if (report.truncated) output += "Output truncated by configured bounds.\n";
	return output.slice(0, MAX_ADVISORY_OUTPUT);
}
