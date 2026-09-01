import { MemorySettingsStore } from "../settings.ts";
import type { MemoryRequestIdentity } from "../request-receipts.ts";
import type { MemoryStatus } from "../settings-protocol.ts";
import type { MemoryConsumerSupervisor } from "./supervisor.ts";

export class MemoryServerSettings {
	constructor(
		private readonly store: MemorySettingsStore,
		private readonly consumers: MemoryConsumerSupervisor,
	) {}

	getStatus(): MemoryStatus {
		return this.store.getStatus();
	}

	async change(
		request: MemoryRequestIdentity,
		action: "on" | "off" | "toggle",
	): Promise<MemoryStatus> {
		const status = this.store.changeEnabledWithReceipt(request, action, new Date().toISOString());
		await this.consumers.setEnabled(status.enabled);
		return status;
	}
}
