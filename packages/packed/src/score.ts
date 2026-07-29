import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { PkgInfo, Registry } from "./ports.ts";
import { NpmPackVerifier, type PackReport } from "./pack.ts";
import { satisfiesRange } from "./publish.ts";
import { resolveCurrentPiVersion } from "./pi-version.ts";
import { lastLocalCommitAt, githubLastCommitAt, type FetchGithubLastCommitAt } from "./commit-freshness.ts";

const PI_COMMAND_NAME = "@earendil-works/pi-coding-agent";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The peer range Pi's own docs actually recommend -- carries no real
 * compatibility signal, so it's treated identically to an absent range. */
const WILDCARD_PI_RANGE = "*";
const PI_PEER_DEPENDENCY = "@earendil-works/pi-coding-agent";

export type ReadinessStatus = "ready" | "partial" | "missing" | "unknown" | "observed";

export interface AdoptionDimension {
	status: ReadinessStatus;
	met: number;
	total: number;
	evidence: string[];
	actions: string[];
}

export interface AdoptionReport {
	target: string;
	source: "local" | "registry";
	package: { name: string; version: string };
	dimensions: {
		discoverability: AdoptionDimension;
		firstRun: AdoptionDimension;
		trust: AdoptionDimension;
		maintenance: AdoptionDimension;
		traction: AdoptionDimension;
		compatibility: AdoptionDimension;
		freshness: AdoptionDimension;
	};
}

const MAX_TEXT_BYTES = 128 * 1024;

function dimension(met: number, total: number, evidence: string[], actions: string[], unknown = false): AdoptionDimension {
	return { status: unknown ? "unknown" : met === total ? "ready" : met === 0 ? "missing" : "partial", met, total, evidence, actions };
}

function readText(path: string): string {
	try { return readFileSync(path).subarray(0, MAX_TEXT_BYTES).toString(); } catch { return ""; }
}

function localManifest(root: string): Record<string, unknown> {
	try { return JSON.parse(readFileSync(join(root, "package.json")).subarray(0, 1024 * 1024).toString()) as Record<string, unknown>; }
	catch { return {}; }
}

function stringField(value: unknown): string | undefined {
	if (typeof value === "string") return value.slice(0, 4_096);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return typeof record.url === "string" ? record.url.slice(0, 4_096) : undefined;
	}
	return undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 50) : [];
}

function discoverability(info: PkgInfo): AdoptionDimension {
	const evidence: string[] = [];
	const actions: string[] = [];
	let met = 0;
	if (info.name && info.name.length <= 64) { met++; evidence.push(`focused package name: ${info.name}`); } else actions.push("use a focused package name");
	if (info.description && info.description.length >= 10 && info.description.length <= 160) { met++; evidence.push("bounded package description"); } else actions.push("add a 10-160 character description");
	if (info.keywords?.includes("pi-package")) { met++; evidence.push("pi-package keyword"); } else actions.push("add the pi-package keyword");
	let total = 4;
	if (info.readmeAvailable === false) { total = 3; evidence.push("README content is unavailable from the bounded registry metadata endpoint"); }
	else if ((info.readme ?? "").trim().length > 0) { met++; evidence.push("README published"); } else actions.push("publish a README");
	return dimension(met, total, evidence, actions);
}

function firstRun(info: PkgInfo): AdoptionDimension {
	if (info.readmeAvailable === false) return { status: "unknown", met: 0, total: 0, evidence: ["README content is unavailable from the bounded registry metadata endpoint"], actions: ["run packed score against a checkout for first-run evidence"] };
	const readme = info.readme ?? "";
	const evidence: string[] = [];
	const actions: string[] = [];
	let met = 0;
	if (/pi\s+install\s+(?:npm:|git:|https:)/i.test(readme)) { met++; evidence.push("Pi install command in README"); } else actions.push("add one copyable pi install command");
	if (/(^|\n)#{1,3}\s+(usage|example)|```[\s\S]{0,2000}```/i.test(readme)) { met++; evidence.push("usage example in README"); } else actions.push("add one concrete usage example");
	if (/!\[[^\]]*\]\([^)]*\)|pi\.(?:gallery|image|video)/i.test(readme)) { met++; evidence.push("visual/gallery evidence"); } else actions.push("add a screenshot or Pi gallery image/video when UI behavior benefits from it");
	return dimension(met, 3, evidence, actions);
}

function trust(info: PkgInfo): AdoptionDimension {
	const evidence: string[] = [];
	const actions: string[] = [];
	let met = 0;
	if (info.repository && /^(?:git\+)?https?:\/\//.test(info.repository)) { met++; evidence.push("public repository URL declared"); } else actions.push("declare a public repository URL");
	if (info.license) { met++; evidence.push(`license: ${info.license}`); } else actions.push("declare a license");
	if (info.bugs?.startsWith("http")) { met++; evidence.push("issue tracker declared"); } else actions.push("declare an issue tracker");
	if (info.publication?.integrity) { met++; evidence.push("npm tarball integrity published"); } else actions.push("publish an integrity-bound npm tarball");
	if (info.publication?.provenanceUrl) { met++; evidence.push("npm provenance attestation published"); } else actions.push("publish with provenance");
	if (info.publication?.trustedPublisher === "verified") { met++; evidence.push("trusted publisher verified"); }
	else actions.push("verify trusted publisher configuration separately; provenance alone does not prove it");
	if (info.packageEvidence?.verified) { met++; evidence.push(`${info.packageEvidence.shape} Pi shape verified from tarball contents`); }
	else actions.push("verify the exact tarball's Pi shape with packed pack");
	actions.push("run packed check --smoke when bounded extension startup evidence is needed");
	return dimension(met, 7, evidence, actions);
}

function maintenance(info: PkgInfo): AdoptionDimension {
	const evidence: string[] = [];
	const actions: string[] = [];
	let met = 0;
	if (info.modified) {
		const age = Date.now() - Date.parse(info.modified);
		if (Number.isFinite(age) && age <= 366 * 24 * 60 * 60 * 1000) { met++; evidence.push(`release metadata updated ${info.modified}`); }
		else actions.push("publish a compatible maintenance release or explain maintenance status");
	} else actions.push("registry release recency is unavailable");
	if (info.peerDependencies?.["@earendil-works/pi-coding-agent"]) { met++; evidence.push(`Pi compatibility: ${info.peerDependencies["@earendil-works/pi-coding-agent"]}`); }
	else actions.push("declare the supported Pi peer range");
	const readme = info.readme ?? "";
	if (/changelog|release notes/i.test(readme)) { met++; evidence.push("changelog or release notes linked"); } else actions.push("link release notes or a changelog");
	return dimension(met, 3, evidence, actions);
}

interface FreshnessCandidate {
	date: string;
	/** "commit" is a real git-history date (local checkout, or GitHub's
	 * Commits API); "publish" is the npm publish-date proxy -- used only
	 * when a real commit date could not be resolved. */
	source: "commit" | "publish";
}

/**
 * Compares the candidate's most accurate available date -- a real commit
 * (local `git log`, or GitHub's Commits API for a pre-install registry
 * candidate) when resolvable, falling back to the npm publish-date proxy
 * otherwise -- against @earendil-works/pi-coding-agent's own last publish
 * date. The publish-date proxy is reasonable but still a proxy: real
 * published packages in this ecosystem publish via CI immediately on
 * tag/commit (confirmed live across dozens of real packages: OIDC
 * trusted-publisher via GitHub Actions is the dominant pattern), which is
 * exactly why a real commit date, when available, is preferred instead.
 * Observational only, like traction() -- no invented threshold for "how
 * stale is bad"; Pi enforces nothing here. Unknown (never a guess)
 * whenever neither source resolved, or pi's own publish date is
 * unavailable.
 */
function freshness(candidate: FreshnessCandidate | undefined, piModified: string | undefined): AdoptionDimension {
	if (!candidate) {
		return { status: "unknown", met: 0, total: 0, evidence: ["candidate's commit history and npm publish date are both unavailable"], actions: [] };
	}
	if (!piModified) {
		return { status: "unknown", met: 0, total: 0, evidence: ["pi-coding-agent's own latest npm publish date is unavailable"], actions: [] };
	}
	const candidateMs = Date.parse(candidate.date);
	const piMs = Date.parse(piModified);
	if (!Number.isFinite(candidateMs) || !Number.isFinite(piMs)) {
		return { status: "unknown", met: 0, total: 0, evidence: ["dates could not be parsed"], actions: [] };
	}
	const deltaDays = Math.round((piMs - candidateMs) / MS_PER_DAY);
	const relation = deltaDays > 0 ? `${deltaDays}d before pi-coding-agent's latest publish` : deltaDays < 0 ? `${-deltaDays}d after pi-coding-agent's latest publish` : "the same day as pi-coding-agent's latest publish";
	const sourceLabel = candidate.source === "commit" ? "last real commit" : "npm publish date (commit history unavailable; proxy for commit recency)";
	return {
		status: "observed", met: 0, total: 0,
		evidence: [`candidate's ${sourceLabel}: ${candidate.date}`, `pi-coding-agent last published ${piModified} -- candidate is ${relation}`],
		actions: [],
	};
}

function traction(info: PkgInfo): AdoptionDimension {
	const observations = info.downloads;
	if (!observations || (observations.weekly === undefined && observations.monthly === undefined)) {
		return { status: "unknown", met: 0, total: 0, evidence: ["traction is observational, not a quality signal; npm download data unavailable"], actions: [] };
	}
	const evidence = [
		`${observations.weekly ?? "unknown"} weekly npm downloads`,
		`${observations.monthly ?? "unknown"} monthly npm downloads`,
		`observed ${observations.observedAt}; downloads are not a quality signal`,
	];
	return { status: "observed", met: 0, total: 0, evidence, actions: [] };
}

/**
 * Compares a candidate's declared @earendil-works/pi-coding-agent peer
 * range against the running Pi version. This is an informal signal, not an
 * official Pi mechanism: Pi's own docs tell authors to declare "*" (no
 * real constraint), real published packages ignore that guidance anyway
 * (earendil-works/pi#4907), and Pi's own installer performs zero
 * validation of this range at install or load time. Never blocks install
 * by itself -- Packed does not gate on this, and neither does Pi.
 */
function compatibility(info: PkgInfo, currentPiVersion: string | undefined): AdoptionDimension {
	const declared = info.peerDependencies?.[PI_PEER_DEPENDENCY]?.trim();
	if (!declared || declared === WILDCARD_PI_RANGE) {
		return {
			status: "unknown", met: 0, total: 0,
			evidence: [declared ? `declared Pi peer range is "*" (Pi's own recommended convention; carries no real signal)` : "no declared Pi peer range (matches Pi's own recommended \"*\" convention)"],
			actions: [],
		};
	}
	if (!currentPiVersion) {
		return {
			status: "unknown", met: 0, total: 0,
			evidence: [`declared Pi peer range ${declared}, but the running Pi version could not be determined`],
			actions: ["run packed pi status to check pi's own version detection"],
		};
	}
	const satisfied = satisfiesRange(currentPiVersion, declared);
	if (satisfied === undefined) {
		return {
			status: "unknown", met: 0, total: 0,
			evidence: [`declared Pi peer range ${declared} could not be evaluated (only exact, ^, and ~ ranges are supported)`],
			actions: [],
		};
	}
	if (satisfied) {
		return {
			status: "ready", met: 1, total: 1,
			evidence: [`declared Pi peer range ${declared} is satisfied by the running pi ${currentPiVersion}`],
			actions: [],
		};
	}
	return {
		status: "missing", met: 0, total: 1,
		evidence: [`declared Pi peer range ${declared} is NOT satisfied by the running pi ${currentPiVersion}`],
		actions: ["this is an informal, Pi-unenforced signal (see earendil-works/pi#4907) -- packed never blocks install on it, but this package may not work correctly on the currently running Pi version"],
	};
}

export function assessRegistryAdoption(info: PkgInfo, currentPiVersion?: string, piModified?: string, candidateCommitAt?: string): AdoptionReport {
	const candidate: FreshnessCandidate | undefined = candidateCommitAt
		? { date: candidateCommitAt, source: "commit" }
		: info.modified
			? { date: info.modified, source: "publish" }
			: undefined;
	return {
		target: info.name, source: "registry", package: { name: info.name, version: info.version },
		dimensions: { discoverability: discoverability(info), firstRun: firstRun(info), trust: trust(info), maintenance: maintenance(info), traction: traction(info), compatibility: compatibility(info, currentPiVersion), freshness: freshness(candidate, piModified) },
	};
}

export async function assessLocalAdoption(packagePath: string, pack: PackReport, currentPiVersion?: string, piModified?: string): Promise<AdoptionReport> {
	const root = realpathSync(resolve(packagePath));
	const pkg = localManifest(root);
	const readmeName = ["README.md", "README", "readme.md"].find((name) => existsSync(join(root, name)));
	const info: PkgInfo = {
		name: typeof pkg.name === "string" ? pkg.name.slice(0, 214) : basename(root),
		version: typeof pkg.version === "string" ? pkg.version.slice(0, 128) : "",
		description: typeof pkg.description === "string" ? pkg.description.slice(0, 512) : undefined,
		keywords: strings(pkg.keywords), license: stringField(pkg.license), repository: stringField(pkg.repository), bugs: stringField(pkg.bugs),
		peerDependencies: pkg.peerDependencies && typeof pkg.peerDependencies === "object" ? pkg.peerDependencies as Record<string, string> : undefined,
		pi: pkg.pi && typeof pkg.pi === "object" ? pkg.pi as Record<string, unknown> : undefined,
		readme: readmeName ? readText(join(root, readmeName)) : undefined, readmeAvailable: true,
		publication: { integrity: pack.integrity, trustedPublisher: "unknown" },
		packageEvidence: { shape: pack.shape.kind, verified: pack.shape.verified, evidence: pack.shape.evidence },
	};
	// A local checkout has no npm publish date, but does have real git
	// history -- prefer that over the (unavailable) publish-date proxy.
	const commitAt = await lastLocalCommitAt(root);
	const report = assessRegistryAdoption(info, currentPiVersion, piModified, commitAt);
	report.target = root;
	report.source = "local";
	if (!pack.ok) report.dimensions.trust.actions.push("resolve npm tarball verification errors");
	if (existsSync(join(root, "CHANGELOG.md"))) {
		report.dimensions.maintenance.met = Math.min(report.dimensions.maintenance.total, report.dimensions.maintenance.met + 1);
		report.dimensions.maintenance.evidence.push("CHANGELOG.md present");
		report.dimensions.maintenance.actions = report.dimensions.maintenance.actions.filter((action) => !action.includes("release notes"));
		report.dimensions.maintenance.status = report.dimensions.maintenance.met === report.dimensions.maintenance.total ? "ready" : "partial";
	}
	return report;
}

export async function scoreTarget(
	target: string, registry: Registry,
	verifier: Pick<NpmPackVerifier, "verify"> = new NpmPackVerifier(),
	currentPiVersion: () => Promise<string | undefined> = resolveCurrentPiVersion,
	fetchGithubCommit: FetchGithubLastCommitAt = githubLastCommitAt,
): Promise<AdoptionReport> {
	const piVersion = await currentPiVersion();
	let piModified: string | undefined;
	if (registry.modifiedAt) {
		try { piModified = await registry.modifiedAt(PI_COMMAND_NAME); } catch { /* freshness remains explicitly unknown */ }
	}
	if (existsSync(resolve(target))) {
		const pack = await verifier.verify(target);
		return await assessLocalAdoption(target, pack, piVersion, piModified);
	}
	const info = await registry.info(target);
	if (registry.downloads) {
		try { info.downloads = await registry.downloads(target); } catch { /* traction remains explicitly unknown */ }
	}
	if (registry.modifiedAt) {
		try { info.modified = await registry.modifiedAt(target); } catch { /* freshness proxy remains explicitly unknown */ }
	}
	// githubLastCommitAt never throws -- undefined for a non-GitHub host, a
	// missing repository field, a rate limit, or any other failure.
	const candidateCommitAt = await fetchGithubCommit(info.repository, info.repositoryDirectory);
	return assessRegistryAdoption(info, piVersion, piModified, candidateCommitAt);
}

export function formatAdoptionReport(report: AdoptionReport, json = false): string {
	if (json) return JSON.stringify(report) + "\n";
	let out = `${report.package.name}@${report.package.version} adoption readiness (${report.source})\n`;
	for (const [name, value] of Object.entries(report.dimensions)) {
		out += `\n${name}: ${value.status}${value.total ? ` (${value.met}/${value.total})` : ""}\n`;
		for (const evidence of value.evidence) out += `  evidence: ${evidence}\n`;
		for (const action of value.actions) out += `  action: ${action}\n`;
	}
	return out.slice(0, 16 * 1024);
}
