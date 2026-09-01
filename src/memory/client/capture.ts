import type { MemoryStatus } from "../settings-protocol.ts";
import { MemoryServerConnection } from "./connection.ts";

export class MemorySessionClient {
	private closed = false;

	constructor(private readonly connection: MemoryServerConnection) {}

	async captureUser(content: string, createdAt: string): Promise<void> {
		this.assertOpen();
		await this.connection.request("captureUser", { content, createdAt });
	}

	async captureAgent(content: string, createdAt: string): Promise<void> {
		this.assertOpen();
		await this.connection.request("captureAgent", { content, createdAt });
	}

	settleExchange(settledAt: string): Promise<boolean> {
		this.assertOpen();
		return this.connection.request("settleExchange", { settledAt });
	}

	getStatus(): Promise<MemoryStatus> {
		this.assertOpen();
		return this.connection.request("getStatus", {});
	}

	changeEnabled(action: "on" | "off" | "toggle"): Promise<MemoryStatus> {
		this.assertOpen();
		return this.connection.request("changeEnabled", { action });
	}

	async close(settledAt: string): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.connection.request("closeSession", { settledAt });
		} finally {
			this.connection.close();
		}
	}

	disconnect(): void {
		if (this.closed) return;
		this.closed = true;
		this.connection.close();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Memory session client is closed");
	}
}
