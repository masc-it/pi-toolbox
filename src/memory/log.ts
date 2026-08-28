export interface MemoryErrorWriter {
	logError(msg: string, createdAt: string): void;
}

export function recordMemoryError(writer: MemoryErrorWriter, entry: Record<string, unknown>): void {
	try {
		writer.logError(JSON.stringify(entry), new Date().toISOString());
	} catch {
		// Memory logging must not interrupt the main Pi session.
	}
}
