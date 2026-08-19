/**
 * Persistent above-editor widget for real doctor.run issues -- mirrors pi-papyrus's own
 * TaskOverlay/NoteOverlay and pi-pipes' own JobsOverlay: factory-form ctx.ui.setWidget
 * registration, requestRender on refresh, hides the widget entirely (setWidget(key, undefined))
 * rather than an empty box once the report is clean.
 *
 * doctor.run lives exclusively on the daemon's Vehicle protocol surface (/vehicle/*), not the
 * legacy PackedExtensionClient RPC surface packed.ts's Natives wraps (see ExtensionOperationName
 * in protocol.ts -- "doctor.run" is not one of them) -- this overlay builds its own reconnecting
 * VehicleClient the same way vehicle-tools.ts's registerPackedVehicle does.
 *
 * Polled at a conservative interval (see DOCTOR_WIDGET_POLL_INTERVAL_MS): unlike Tasks/Notes/Jobs,
 * doctor.run is a real daemon-wide scan (extension smoke tests, npm-tree walks, systemd
 * shell-outs), not a cheap row read.
 */
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import { createReconnectingVehicleClient } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { AutoRotatingWindow } from "malevich-tui-components";
import { BoundedPoll } from "./bounded-poll.js";
import {
	buildDoctorWidgetProjection,
	type DoctorWidgetProjection,
	PACKED_DOCTOR_WIDGET_VISIBLE_ROWS,
	renderDoctorWidgetLines,
} from "./doctor-widget.js";
import { currentVehicleClientTarget } from "./vehicle-target.js";

const WIDGET_KEY = "pi-packed-doctor";

/** doctor.run is a real daemon-wide scan, not a cheap row read -- a much longer interval than
 * Tasks/Notes/Jobs' own 15-20s cadence. */
export const DOCTOR_WIDGET_POLL_INTERVAL_MS = 90_000;

/** How often the widget's own auto-rotating overflow page advances. */
export const DOCTOR_WIDGET_ROTATION_INTERVAL_MS = 6_000;

const EMPTY_PROJECTION: DoctorWidgetProjection = { issues: [], total: 0 };

function defaultClient(): VehicleClient {
	// connectRetry:true (vehicle-client's own bounded background retry budget) covers a daemon
	// that crashed and is mid systemd-restart -- matches registerPackedVehicle's own construction.
	return createReconnectingVehicleClient(
		async () => {
			const resolved = currentVehicleClientTarget();
			if (!resolved) throw new Error("Packed daemon is not running");
			return new RemoteVehicleClient({ baseUrl: resolved.baseUrl, token: resolved.token });
		},
		{ connectRetry: true },
	);
}

export class DoctorOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	// biome-ignore lint/suspicious/noExplicitAny: same TUI-handle shape every other overlay in this ecosystem keeps untyped (requestRender is all that's used).
	private tui: any | undefined;
	private projection: DoctorWidgetProjection = EMPTY_PROJECTION;
	private readonly poll = new BoundedPoll();
	/** Repaint-only ticker (no data refetch) so the widget's own auto-rotating page visibly
	 * advances even when nothing else has changed. */
	private readonly rotationPoll = new BoundedPoll();
	private readonly rotation = new AutoRotatingWindow({
		totalRows: 0,
		pageSize: PACKED_DOCTOR_WIDGET_VISIBLE_ROWS,
		intervalMs: DOCTOR_WIDGET_ROTATION_INTERVAL_MS,
	});
	private readonly client: VehicleClient;

	constructor(client: VehicleClient = defaultClient()) {
		this.client = client;
	}

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/** Never throws: called from a poll timer and from session_start, neither of which should turn
	 * a best-effort status widget into a crashed extension host over a daemon that isn't running
	 * yet or a rendering bug. */
	async refresh(): Promise<void> {
		try {
			const report = await this.client.invoke<DoctorReport>("doctor.run", 1, {}, { permissions: ["packed:read"] });
			this.projection = buildDoctorWidgetProjection(report);
		} catch {
			this.projection = EMPTY_PROJECTION;
		}
		try {
			this.render();
		} catch {
			// A rendering bug must not crash the extension host over a best-effort status widget.
		}
	}

	private render(): void {
		if (!this.uiCtx) return;

		if (this.projection.total === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
				this.rotationPoll.stop();
			}
			return;
		}

		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				// biome-ignore lint/suspicious/noExplicitAny: tui is only ever used for requestRender(), matching every other overlay in this ecosystem.
				(tui: any, theme: Theme) => {
					this.tui = tui;
					return {
						render: (width: number) => renderDoctorWidgetLines(theme, this.projection, width, this.rotation),
						invalidate: () => {
							// Theme changed -- force re-registration, matching every other overlay in this ecosystem.
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
			this.rotationPoll.start(DOCTOR_WIDGET_ROTATION_INTERVAL_MS, () => this.tui?.requestRender?.());
		} else {
			this.tui?.requestRender?.();
		}
	}

	startPolling(intervalMs: number = DOCTOR_WIDGET_POLL_INTERVAL_MS): void {
		this.poll.start(intervalMs, () => {
			void this.refresh();
		});
	}

	stopPolling(): void {
		this.poll.stop();
	}

	dispose(): void {
		this.stopPolling();
		this.rotationPoll.stop();
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
