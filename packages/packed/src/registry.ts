/**
 * registry.ts — driven adapter: npm registry over HTTP (web-standard fetch).
 * Lean mapping = Facade over npm's verbose package documents.
 */
import type { DownloadObservations, Pkg, PkgInfo, Registry, SearchPage } from "./ports.ts";
import {
	NPM_REGISTRY_BASE, SEARCH_PAGE_SIZE, RETRY_MAX_ATTEMPTS, RETRY_BASE_DELAY_MS, PAGE_DELAY_MS, REGISTRY_FETCH_TIMEOUT_MS,
} from "./constants.ts";
import { createLogger } from "./log.ts";

const log = createLogger("registry");

/** Upstream etiquette: honor Retry-After on 429, exponential backoff
 * otherwise, give up after RETRY_MAX_ATTEMPTS. */
async function fetchWithRetry(url: string, init: RequestInit | undefined, baseDelayMs: number): Promise<Response> {
	let lastErr: Error | undefined;
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
		const t0 = Date.now();
		try {
			const signal = init?.signal
				? AbortSignal.any([init.signal, AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS)])
				: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS);
			const res = await fetch(url, { ...init, signal });
			const ms = Date.now() - t0;
			if (res.status === 429 && attempt < RETRY_MAX_ATTEMPTS) {
				const ra = res.headers.get("retry-after");
				const delayMs =
					ra !== null && Number(ra) > 0
						? Number(ra) * 1000 // authoritative only when positive
						: baseDelayMs * 2 ** (attempt - 1); // npm sends 0: use exponential
				log.warn("429 rate-limited, backing off", { attempt, delayMs, ms, url: url.slice(0, 120) });
				await Bun.sleep(delayMs);
				continue;
			}
			log.debug("fetch", { status: res.status, ms, attempt, url: url.slice(0, 120) });
			return res;
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			log.warn("fetch error, retrying", { attempt, error: lastErr.message, url: url.slice(0, 120) });
			if (attempt < RETRY_MAX_ATTEMPTS) await Bun.sleep(baseDelayMs * 2 ** (attempt - 1));
		}
	}
	log.error("retry budget exhausted", { attempts: RETRY_MAX_ATTEMPTS, url: url.slice(0, 120) });
	throw lastErr ?? new Error("retry budget exhausted");
}

export class HttpRegistry implements Registry {
	constructor(
		private base = NPM_REGISTRY_BASE,
		private pageSize = SEARCH_PAGE_SIZE,
		private pageDelayMs = PAGE_DELAY_MS,
		private retryBaseDelayMs = RETRY_BASE_DELAY_MS,
		private downloadsBase = "https://api.npmjs.org",
	) {}

	async search(query: string, limit: number): Promise<SearchPage> {
		return this.searchPage(query, 0, limit);
	}

	async searchPage(query: string, from: number, size: number): Promise<SearchPage> {
		const params = new URLSearchParams({ text: query, size: String(size), from: String(from) });
		const res = await fetchWithRetry(`${this.base}/-/v1/search?${params}`, undefined, this.retryBaseDelayMs);
		if (!res.ok) throw new Error(`npm search: HTTP ${res.status}`);
		const doc = (await res.json()) as {
			total?: number;
			objects?: { package?: { name?: string; version?: string; description?: string; date?: string } }[];
		};
		const results: Pkg[] = (doc.objects ?? []).flatMap((o) => {
			const p = o.package;
			return p?.name
				? [{
					name: boundedString(p.name, 214)!, version: boundedString(p.version, 128) ?? "", description: boundedString(p.description, 512), date: boundedString(p.date, 64),
					packageEvidence: { shape: "keyword-only" as const, verified: false, evidence: ["npm keyword search candidate; tarball not inspected"] },
				}]
				: [];
		});
		return { results, total: doc.total ?? results.length };
	}

	async searchAll(query: string): Promise<Pkg[]> {
		// Map by name: npm's ranking shifts mid-pagination and a package can
		// appear on two pages — first occurrence wins.
		const byName = new Map<string, Pkg>();
		let from = 0;
		for (;;) {
			if (from > 0 && this.pageDelayMs > 0) await Bun.sleep(this.pageDelayMs);
			const { results, total } = await this.searchPage(query, from, this.pageSize);
			if (results.length === 0 || from >= total) break;
			for (const p of results) {
				if (!byName.has(p.name)) byName.set(p.name, p);
			}
			from += results.length;
		}
		return [...byName.values()];
	}

	async info(name: string): Promise<PkgInfo> {
		const encoded = encodeURIComponent(name).replace("%2F", "/");
		const res = await fetchWithRetry(`${this.base}/${encoded}/latest`, { headers: { accept: "application/json" } }, this.retryBaseDelayMs);
		if (!res.ok) throw new Error(`npm info ${name}: HTTP ${res.status}`);
		const v = await boundedJson(res, 1024 * 1024) as {
			name?: string; version?: string; description?: string; homepage?: string; license?: unknown;
			repository?: unknown; bugs?: unknown; keywords?: string[]; pi?: Record<string, unknown>;
			peerDependencies?: Record<string, string>;
			dist?: { unpackedSize?: number; integrity?: string; attestations?: { url?: string; provenance?: unknown } };
		};
		const manifestFields = v.pi ? Object.keys(v.pi).filter((key) => ["extensions", "skills", "prompts", "themes"].includes(key)) : [];
		return {
			name: boundedString(v.name, 214) ?? boundedString(name, 214)!,
			version: boundedString(v.version, 128) ?? "",
			description: boundedString(v.description, 512), homepage: boundedString(v.homepage, 2_048),
			repository: boundedString(rawToString(v.repository, "url"), 2_048), bugs: boundedString(rawToString(v.bugs, "url"), 2_048),
			license: boundedString(rawToString(v.license, "type"), 128),
			keywords: v.keywords?.filter((value): value is string => typeof value === "string").slice(0, 50).map((value) => value.slice(0, 64)),
			pi: boundedPiManifest(v.pi), peerDependencies: boundedDependencies(v.peerDependencies), readmeAvailable: false,
			unpackedSize: v.dist?.unpackedSize,
			packageEvidence: manifestFields.length > 0
				? { shape: "manifest", verified: false, evidence: manifestFields.map((field) => `registry package.json pi.${field}; tarball not inspected`) }
				: { shape: "keyword-only", verified: false, evidence: ["registry metadata has no Pi manifest resources; tarball not inspected"] },
			publication: { integrity: v.dist?.integrity, provenanceUrl: v.dist?.attestations?.provenance ? v.dist.attestations.url : undefined, trustedPublisher: "unknown" },
		};
	}

	async downloads(name: string): Promise<DownloadObservations> {
		const encoded = encodeURIComponent(name).replace("%2F", "/");
		const [weekly, monthly] = await Promise.all([
			fetchWithRetry(`${this.downloadsBase}/downloads/point/last-week/${encoded}`, undefined, this.retryBaseDelayMs),
			fetchWithRetry(`${this.downloadsBase}/downloads/point/last-month/${encoded}`, undefined, this.retryBaseDelayMs),
		]);
		if (!weekly.ok || !monthly.ok) throw new Error(`npm downloads ${name}: HTTP ${weekly.ok ? monthly.status : weekly.status}`);
		const [weekDoc, monthDoc] = await Promise.all([boundedJson(weekly, 64 * 1024), boundedJson(monthly, 64 * 1024)]) as [{ downloads?: number }, { downloads?: number }];
		return { weekly: boundedCount(weekDoc.downloads), monthly: boundedCount(monthDoc.downloads), observedAt: new Date().toISOString() };
	}
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > maxBytes) throw new Error(`npm response exceeds ${maxBytes} bytes`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error(`npm response exceeds ${maxBytes} bytes`);
	return JSON.parse(new TextDecoder().decode(bytes));
}

function boundedString(value: unknown, max: number): string | undefined {
	return typeof value === "string" ? value.slice(0, max) : undefined;
}

function boundedPiManifest(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
		if (Array.isArray(source[field])) result[field] = source[field].filter((item): item is string => typeof item === "string").slice(0, 100).map((item) => item.slice(0, 256));
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function boundedDependencies(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.slice(0, 100)
		.map(([name, range]) => [name.slice(0, 214), range.slice(0, 128)]);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function boundedCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : undefined;
}

/** npm fields appear as plain string OR object: license: "MIT" | {type:"MIT"}. */
function rawToString(raw: unknown, objKey: string): string | undefined {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object") {
		const v = (raw as Record<string, unknown>)[objKey];
		if (typeof v === "string") return v;
	}
	return undefined;
}
