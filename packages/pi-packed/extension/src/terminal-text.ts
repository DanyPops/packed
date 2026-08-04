const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** Removes terminal control bytes from external registry text while preserving tabs and line breaks. */
export function sanitizeTerminalText(text: string): string {
	return text.replace(UNSAFE_TERMINAL_CONTROL, "");
}
