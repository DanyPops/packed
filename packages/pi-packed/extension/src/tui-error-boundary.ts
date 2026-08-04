import type { Component } from "malevich-tui-components";

/** Keeps a component failure inside its overlay instead of Pi's event loop. */
export class TuiErrorBoundary implements Component {
	private failed = false;

	constructor(
		private readonly component: Component,
		private readonly fallback: readonly string[],
		private readonly onError?: () => void,
	) {}

	render(width: number): string[] {
		if (this.failed) return this.renderFallback(width);
		try {
			return this.component.render(width);
		} catch {
			this.fail();
			return this.renderFallback(width);
		}
	}

	invalidate(): void {
		if (this.failed) return;
		try {
			this.component.invalidate();
		} catch {
			this.fail();
		}
	}

	handleInput(data: string): void {
		if (this.failed) return;
		try {
			this.component.handleInput?.(data);
		} catch {
			this.fail();
		}
	}

	private fail(): void {
		if (this.failed) return;
		this.failed = true;
		this.onError?.();
	}

	private renderFallback(width: number): string[] {
		const boundedWidth = Math.max(0, width);
		return this.fallback.map((line) => line.slice(0, boundedWidth));
	}
}
