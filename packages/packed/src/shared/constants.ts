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

// --- Cache / fetch ---
export const CACHE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 800;
export const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
export const MIRROR_OPERATION_TIMEOUT_MS = 2 * 60_000;

// --- Daemon ---
export const WATCH_INTERVAL_DEFAULT_MS = 30 * 60_000; // updates diff cadence
export const CATALOG_INTERVAL_DEFAULT_MS = 6 * 3_600_000; // full mirror TTL
export const INDEX_INTERVAL_DEFAULT_MS = 6 * 3_600_000; // static index regeneration TTL, same cadence as the catalog mirror it reads from
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
	IDLE_SECS: "PI_PACKED_IDLE_SECS",
} as const;
