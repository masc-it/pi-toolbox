#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./javascript-typescript-complexity/application.mjs";

export {
	DEFAULT_LIMITS,
	EXIT_ANALYSIS,
	EXIT_BOUNDARY,
	EXIT_INVARIANT,
	EXIT_NO_FILES,
	EXIT_RESOURCE,
} from "./javascript-typescript-complexity/analyzer-contract.mjs";
export { inspectRepository, parseArguments, run } from "./javascript-typescript-complexity/application.mjs";
export { rankFiles, renderReport } from "./javascript-typescript-complexity/report.mjs";
export {
	discoverSourceFiles,
	enforceRepositoryLimits,
	isExcludedPath,
	parseSourceFiles,
	readRepositoryExclusions,
	resolveRepositoryRoot,
} from "./javascript-typescript-complexity/source-files.mjs";
export { analyzeSourceFile } from "./javascript-typescript-complexity/scope-metrics.mjs";

async function isMainModule(invokedPath) {
	if (!invokedPath) return false;
	try {
		return (await realpath(path.resolve(invokedPath))) === (await realpath(fileURLToPath(import.meta.url)));
	} catch {
		return false;
	}
}

if (await isMainModule(process.argv[1])) {
	process.exitCode = await run(process.argv.slice(2));
}
