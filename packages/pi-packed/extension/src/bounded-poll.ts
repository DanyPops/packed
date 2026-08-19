/**
 * Idempotent start/stop wrapper over setInterval -- a second start() is a no-op rather than a
 * competing timer, and stop() is safe to call even if never started. Same shape as pi-papyrus's
 * and pi-pipes' own BoundedPoll.
 */
export class BoundedPoll {
	private timer: ReturnType<typeof setInterval> | undefined;

	start(intervalMs: number, tick: () => void): void {
		if (this.timer) return;
		this.timer = setInterval(tick, intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
