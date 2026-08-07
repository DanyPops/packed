import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildDetailLines, type Component, type TextMeasure } from "malevich-tui-components";
import { formatDownloadCount, formatRelativeDate } from "./model.js";
import type { Natives, PackageInfo } from "./packed.js";
import { sanitizeTerminalText } from "./terminal-text.js";

const README_CHAR_LIMIT = 50_000;
const DETAIL_LINE_LIMIT = 2_000;
const VIEWPORT_LINES = 18;

export class PackageInspector implements Component {
	private info: PackageInfo | undefined;
	private error: string | undefined;
	private loading = true;
	private scrollOffset = 0;

	constructor(
		private readonly packageName: string,
		private readonly natives: Natives,
		private readonly theme: Theme,
		private readonly measure: TextMeasure,
		private readonly onClose: () => void,
		private readonly requestRender: () => void,
	) {}

	async load(): Promise<void> {
		try {
			this.info = await this.natives.info(this.packageName);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "down") || data === "j") this.scrollOffset += 1;
		else if (matchesKey(data, "up") || data === "k") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (data === "g") this.scrollOffset = 0;
		else if (data === "G") this.scrollOffset = Number.MAX_SAFE_INTEGER;
		this.requestRender();
	}

	render(width: number): string[] {
		const heading = this.theme.bold(this.theme.fg("accent", `Inspect ${this.packageName}`));
		const help = this.theme.fg("muted", "esc/q close · ↑↓/j/k scroll · g/G top/bottom");
		if (this.loading) return [heading, help, "", this.theme.fg("muted", "Loading registry metadata…")];
		if (this.error) return [heading, help, "", this.theme.fg("error", this.error)];
		if (!this.info) return [heading, help, "", this.theme.fg("muted", "No package metadata")];

		const info = this.info;
		const rawReadme = sanitizeTerminalText(info.readme?.trim() || "No README published.");
		const readmeTruncated = rawReadme.length > README_CHAR_LIMIT;
		const readme = rawReadme.slice(0, README_CHAR_LIMIT);
		const detailMeasure: TextMeasure = { ...this.measure, wrapTextWithAnsi };
		const released = formatRelativeDate(info.modified);
		const weekly = formatDownloadCount(info.downloads?.weekly);
		const monthly = formatDownloadCount(info.downloads?.monthly);
		const details = buildDetailLines(Math.max(1, width), {
			fields: [
				{ label: "Version", value: sanitizeTerminalText(info.version) },
				// "Released" reflects the latest publish across ANY version (npm's own abbreviated-doc
				// `modified` field -- see HttpRegistry.modifiedAt()), not necessarily this exact pinned
				// version's own publish date; the Find tab's search-result Card shows the exact
				// per-version date instead, since npm's search API already returns that for free.
				...(released ? [{ label: "Released", value: released }] : []),
				...(weekly || monthly
					? [{ label: "Downloads", value: [weekly && `${weekly}/week`, monthly && `${monthly}/month`].filter(Boolean).join(" · ") }]
					: []),
				...(info.license ? [{ label: "License", value: sanitizeTerminalText(info.license) }] : []),
				...(info.repository ? [{ label: "Repository", value: sanitizeTerminalText(info.repository) }] : []),
			],
			sections: [
				...(info.description ? [{ heading: "Description", body: sanitizeTerminalText(info.description) }] : []),
				{ heading: "README (registry metadata)", body: readme },
			],
			theme: {
				field: (s) => this.theme.fg("dim", s),
				heading: (s) => this.theme.bold(this.theme.fg("accent", s)),
				byline: (s) => this.theme.fg("muted", s),
				body: (s) => s,
			},
			measure: detailMeasure,
		}).slice(0, DETAIL_LINE_LIMIT);
		if (readmeTruncated || details.length === DETAIL_LINE_LIMIT) details.push(this.theme.fg("warning", "Output truncated."));
		const maxOffset = Math.max(0, details.length - VIEWPORT_LINES);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visible = details.slice(this.scrollOffset, this.scrollOffset + VIEWPORT_LINES);
		return [
			heading,
			help,
			this.theme.fg("dim", `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${details.length}`),
			"",
			...visible,
		];
	}
}
