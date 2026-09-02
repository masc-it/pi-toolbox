import {
	AnalyzerError,
	BoundaryError,
	DEFAULT_LIMITS,
	EXIT_INVARIANT,
	NoFilesError,
	displayValue,
	escapeControls,
	validateLimits,
} from "./analyzer-contract.mjs";
import { rankFiles, renderReport } from "./report.mjs";
import {
	discoverSourceFiles,
	enforceRepositoryLimits,
	parseSourceFiles,
	readRepositoryExclusions,
	resolveRepositoryRoot,
} from "./source-files.mjs";

export function parseArguments(argv) {
	if (argv.length !== 2 || argv[0] !== "--repo-root" || argv[1].length === 0) {
		throw new BoundaryError("Usage: javascript_typescript_complexity.mjs --repo-root <directory>");
	}
	return { repoRoot: argv[1] };
}

export async function inspectRepository(repoRootInput, options = {}) {
	const limits = options.limits ?? DEFAULT_LIMITS;
	validateLimits(limits);
	const root = await resolveRepositoryRoot(repoRootInput);
	const excludePaths = await readRepositoryExclusions(root);
	const files = await discoverSourceFiles(root, excludePaths);
	if (files.length === 0) {
		throw new NoFilesError(`No production JavaScript or TypeScript files found under ${displayValue(root)}`);
	}
	enforceRepositoryLimits(files, limits);
	const metrics = await parseSourceFiles(files, limits);
	return { root, files, metrics };
}

export async function run(argv, options = {}) {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	try {
		const { repoRoot } = parseArguments(argv);
		const { metrics } = await inspectRepository(repoRoot, { limits: options.limits ?? DEFAULT_LIMITS });
		const ranked = rankFiles(metrics);
		if (ranked.length === 0) throw new Error("Repository ranking is empty after successful analysis");
		stdout.write(renderReport(ranked[0]));
		return 0;
	} catch (error) {
		if (error instanceof AnalyzerError) {
			stderr.write(`${escapeControls(error.message)}\n`);
			return error.exitCode;
		}
		const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		stderr.write(`Analyzer invariant failed: ${escapeControls(details)}\n`);
		return EXIT_INVARIANT;
	}
}
