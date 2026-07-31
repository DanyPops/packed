/**
 * spinner.ts — a tiny, testable indeterminate-progress ticker for a
 * surface with no discrete step count (a single in-flight subprocess
 * call, unlike ProgressBar's own known N-of-M batch position). tick() is
 * the pure, synchronously-testable core; start()/stop() wire it to a real
 * interval for genuine on-screen animation. pi-tui's own Loader component
 * does the identical thing internally but keeps its current frame private
 * (it owns a whole Text line), so it can't be embedded inline in a
 * caller's own row the way this one is -- hence this small local one.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export class Spinner {
	private index = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	/** Current animation frame -- a single braille glyph. */
	glyph(): string {
		return FRAMES[this.index]!;
	}

	/** Advances one frame. Pure and synchronous -- the deterministic unit under test; start() is just this wired to a real timer. */
	tick(): void {
		this.index = (this.index + 1) % FRAMES.length;
	}

	/** Wires tick() to a real interval, calling onTick after each advance so a host can requestRender(). Idempotent -- calling start() again restarts cleanly rather than stacking a second interval. */
	start(onTick: () => void): void {
		this.stop();
		this.timer = setInterval(() => {
			this.tick();
			onTick();
		}, INTERVAL_MS);
	}

	/** Safe to call even if never started, or more than once. */
	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
