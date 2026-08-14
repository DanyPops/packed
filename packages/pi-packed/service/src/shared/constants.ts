/**
 * constants.ts — every magic value in one place, named.
 * (lexicon: replace-magic-number-with-symbolic-constant)
 */

// --- Upstream ---
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

// --- Search / pagination ---
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_PAGE_SIZE = 250; // npm registry max page size
export const PI_PACKAGE_KEYWORD = "keywords:pi-package";

// --- Native tool presentation bounds ---
export const TOOL_MODEL_CONTENT_MAX_CHARACTERS = 2_000;
export const TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS = 32_000;
export const TOOL_DETAILS_MAX_PACKAGES = 50;
export const TOOL_DETAILS_MAX_DESCRIPTION_CHARACTERS = 240;
export const TOOL_DETAILS_MAX_OUTPUT_CHARACTERS = 1_000;
export const TOOL_DETAILS_MAX_KEYWORDS = 20;
export const TOOL_DETAILS_MAX_CAPABILITIES = 12;
export const TOOL_COLLAPSED_PACKAGE_PREVIEW = 3;

// --- Upstream etiquette (429s) ---
export const RETRY_MAX_ATTEMPTS = 6;
export const RETRY_BASE_DELAY_MS = 2_000; // 2+4+8+16+32s spans npm's ~60s search window
export const PAGE_DELAY_MS = 100; // politeness pause between catalog pages
export const MIRROR_PAGE_DELAY_MS = 400; // manual full-sync: extra polite (burst limits)

// --- GitHub self-throttling (single-candidate commit lookup only, never bulk) ---
// Confirmed against GitHub's own docs and @octokit/plugin-throttling's reference
// shape: retry a short secondary-limit or transient failure, but never block an
// interactive `packed score` call for anywhere near the full primary-limit reset
// window (which can be up to an hour away).
export const GITHUB_RETRY_MAX_ATTEMPTS = 4;
export const GITHUB_MAX_TOTAL_BACKOFF_MS = 60_000; // hard cap across every retry combined
export const GITHUB_SECONDARY_RATE_LIMIT_FALLBACK_MS = 60_000; // matches plugin-throttling's own fallbackSecondaryRateRetryAfter default when no Retry-After header is present
export const GITHUB_TRANSIENT_BASE_DELAY_MS = 1_000; // 1+2+4s for a plain network blip or 5xx, well under the total cap

// --- Cache / fetch ---
export const CACHE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 800;
export const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
export const MIRROR_OPERATION_TIMEOUT_MS = 2 * 60_000;
// Confirmed live: 500 packages (index build's own bound) took just over
// MIRROR_OPERATION_TIMEOUT_MS end to end -- a dedicated, more generous
// budget, matching the same per-operation-timeout pattern mirror() uses.
export const INDEX_OPERATION_TIMEOUT_MS = 10 * 60_000;

// --- Daemon ---
export const WATCH_INTERVAL_DEFAULT_MS = 30 * 60_000; // updates diff cadence
export const CATALOG_INTERVAL_DEFAULT_MS = 6 * 3_600_000; // full mirror TTL
export const INDEX_INTERVAL_DEFAULT_MS = 6 * 3_600_000; // static index regeneration TTL, same cadence as the catalog mirror it reads from
// Vehicle-service drift sweep cadence -- catches an out-of-band npm install/update a running
// daemon never picked up (e.g. a plain `pkg_update`/`pi update --extension`, which has no way to
// notify Armada/pi-packed at all -- see pkg-update-never-restarts-vehicle-daemon). Now that
// startDaemon() also runs every maintenance task once immediately at startup (see
// vehicle-server's own daemon.ts), a restart of pi-packed itself no longer waits out this
// interval at all -- this cadence now only bounds the OTHER case: an out-of-band update that
// lands while pi-packed's own daemon is already running and stays up. 30 minutes was tuned for
// a background safety net, not an interactive "I just updated something" workflow; 5 minutes
// keeps the same self-healing guarantee at a much more reasonable latency for a per-pass cost
// that's still just a handful of cheap native-service inspections for a fleet this size.
export const RECONCILE_INTERVAL_DEFAULT_MS = 5 * 60_000;
export const IDLE_BUDGET_DEFAULT_MS = 10 * 60_000; // on-demand self-exit
export const WATCHDOG_TICK_MS = 15_000;

// --- State file names ---
export const UPDATES_FILE = "updates.json";
export const DB_FILE = "packed.db";
export const INDEX_FILE = "index.json";
export const SETTINGS_FILE = "settings.json";
export const SECURITY_FILE = "security.json";

// --- Environment knobs ---
export const ENV = {
	HOME: "PI_PACKED_HOME",
	PI_HOME: "PI_PACKED_PI_HOME",
	WATCH_SECS: "PI_PACKED_WATCH_SECS",
	CATALOG_SECS: "PI_PACKED_CATALOG_SECS",
	INDEX_SECS: "PI_PACKED_INDEX_SECS",
	RECONCILE_SECS: "PI_PACKED_RECONCILE_SECS",
	IDLE_SECS: "PI_PACKED_IDLE_SECS",
} as const;
