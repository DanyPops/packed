import {
	createLogger as createDaemonLogger,
	type LogFields,
	type LogLevel,
	type Logger,
} from "@danypops/daemon-kit/logging";

export type { LogFields, LogLevel, Logger };
export type LogSink = (line: string) => void;

/** Keeps Packed's injectable test sink while delegating level handling and serialization to daemon-kit. */
export function createLogger(component: string, sink?: LogSink, minLevel?: LogLevel): Logger {
	const destination = sink
		? { write(chunk: string) { sink(chunk.trimEnd()); return true; } }
		: undefined;
	return createDaemonLogger(component, {
		level: minLevel,
		levelEnvVar: "PI_PACKED_LOG_LEVEL",
		destination,
	});
}
