import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ToolboxConfigStore } from "./config.ts";
import { ToolboxDatabase } from "./db/database.ts";
import {
	SqliteFeatureSpecRepository,
	SqliteImplementationRepository,
	SqliteProjectRepository,
} from "./db/repositories.ts";
import type { ProjectContext } from "./domain.ts";
import { WorkflowModelClient } from "./model/client.ts";
import { GitProjectResolver } from "./project/git-identity.ts";
import { RepositoryInspector } from "./project/repository-context.ts";
import { FeatureSpecWorkflow } from "./workflows/feature-spec.ts";

export class ToolboxRuntime {
	readonly config = new ToolboxConfigStore();
	private readonly gitResolver = new GitProjectResolver();
	private database: ToolboxDatabase | null = null;

	async resolveProject(cwd: string): Promise<ProjectContext> {
		const identity = await this.gitResolver.resolve(cwd);
		return this.projectRepository().resolve(identity);
	}

	createFeatureSpecWorkflow(registry: ModelRegistry): FeatureSpecWorkflow {
		return new FeatureSpecWorkflow(
			this.featureSpecRepository(),
			new WorkflowModelClient(registry),
			new RepositoryInspector(),
		);
	}

	featureSpecRepository(): SqliteFeatureSpecRepository {
		return new SqliteFeatureSpecRepository(this.connection());
	}

	implementationRepository(): SqliteImplementationRepository {
		return new SqliteImplementationRepository(this.connection());
	}

	close(): void {
		this.database?.close();
		this.database = null;
	}

	private projectRepository(): SqliteProjectRepository {
		return new SqliteProjectRepository(this.connection());
	}

	private connection(): ToolboxDatabase["connection"] {
		this.database ??= new ToolboxDatabase();
		return this.database.connection;
	}
}
