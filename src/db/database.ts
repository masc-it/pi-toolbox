import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyMigrations } from "./migrations.ts";

const DATABASE_DIRECTORY = "pi-toolbox";
const DATABASE_FILENAME = "toolbox.sqlite";

export class ToolboxDatabase {
	readonly path: string;
	readonly connection: Database.Database;

	constructor(agentDirectory = getAgentDir()) {
		this.path = join(agentDirectory, DATABASE_DIRECTORY, DATABASE_FILENAME);
		mkdirSync(dirname(this.path), { recursive: true });
		this.connection = new Database(this.path);
		this.configure();
		applyMigrations(this.connection);
	}

	close(): void {
		if (this.connection.open) {
			this.connection.close();
		}
	}

	private configure(): void {
		this.connection.pragma("foreign_keys = ON");
		this.connection.pragma("journal_mode = WAL");
		this.connection.pragma("busy_timeout = 5000");
	}
}
