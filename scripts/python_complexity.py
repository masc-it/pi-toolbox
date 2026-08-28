#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
from __future__ import annotations

import argparse
import ast
import os
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

SKIP_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "venv",
    "__pycache__",
    "build",
    "dist",
    "htmlcov",
    "node_modules",
    "site-packages",
}
SOFT_LIMITS = {
    "cyclomatic_complexity": 4,
    "max_nesting_depth": 2,
    "logical_line_count": 20,
    "parameter_count": 4,
    "local_variable_count": 8,
    "branch_count": 4,
    "module_logical_line_count": 250,
}
HARD_LIMITS = {
    "cyclomatic_complexity": 10,
    "max_nesting_depth": 4,
    "logical_line_count": 40,
    "parameter_count": 6,
}

EXIT_BOUNDARY = 2
EXIT_NO_FILES = 3
EXIT_ANALYSIS = 4
EXIT_INVARIANT = 5


class RepositoryError(Exception):
    pass


class AnalysisError(Exception):
    def __init__(self, path: Path, error: Exception) -> None:
        self.path = path
        self.error = error
        super().__init__(str(error))


class AnalyzerInvariantError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class SourceSpan:
    start_line: int
    end_line: int

    def format(self) -> str:
        if self.start_line == self.end_line:
            return f"L{self.start_line}"
        return f"L{self.start_line}-L{self.end_line}"


@dataclass(slots=True)
class FunctionMetrics:
    name: str
    qualname: str
    lineno: int
    end_lineno: int
    cyclomatic_complexity: int
    max_nesting_depth: int
    logical_line_count: int
    parameter_count: int
    local_variable_count: int
    branch_count: int
    bare_except_count: int
    bare_except_spans: tuple[SourceSpan, ...] = ()
    quality_score: int = 100


@dataclass(slots=True)
class FileMetrics:
    path: Path
    module_logical_line_count: int
    top_level_statement_spans: tuple[SourceSpan, ...] = ()
    function_metrics: list[FunctionMetrics] = field(default_factory=list)
    quality_score: int = 100
    hard_limit_violation_count: int = 0

    @property
    def highest_complexity(self) -> int:
        return max((item.cyclomatic_complexity for item in self.function_metrics), default=0)

    @property
    def deepest_nesting(self) -> int:
        return max((item.max_nesting_depth for item in self.function_metrics), default=0)

    @property
    def largest_function(self) -> int:
        return max((item.logical_line_count for item in self.function_metrics), default=0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Find the worst Python complexity offender in a repository.")
    parser.add_argument("--repo-root", required=True, type=Path, help="Repository root to analyze.")
    return parser


def resolve_repo_root(path: Path) -> Path:
    try:
        root = path.expanduser().resolve(strict=True)
    except OSError as error:
        raise RepositoryError(f"Unable to resolve repository root {path}: {error}") from error
    if not root.is_dir():
        raise RepositoryError(f"Repository root is not a directory: {root}")
    return root


def discover_python_files(root: Path) -> list[Path]:
    git_paths = list_git_files(root)
    raw_paths = git_paths if git_paths is not None else walk_python_files(root)
    discovered: dict[Path, Path] = {}

    for raw_path in raw_paths:
        candidate = raw_path if raw_path.is_absolute() else root / raw_path
        if candidate.suffix != ".py":
            continue
        try:
            relative = candidate.relative_to(root)
        except ValueError as error:
            raise RepositoryError(f"Discovered path is outside the repository root: {candidate}") from error
        if is_excluded(relative):
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RepositoryError(f"Unable to resolve discovered path {relative.as_posix()}: {error}") from error
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise RepositoryError(f"Discovered Python file resolves outside the repository root: {relative.as_posix()}") from error
        if resolved.is_file():
            discovered[resolved] = resolved

    return sorted(discovered.values(), key=lambda path: path.relative_to(root).as_posix())


def list_git_files(root: Path) -> list[Path] | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            check=False,
            capture_output=True,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None

    return [Path(os.fsdecode(item)) for item in result.stdout.split(b"\0") if item]


def walk_python_files(root: Path) -> list[Path]:
    paths: list[Path] = []
    walk_errors: list[OSError] = []

    def record_error(error: OSError) -> None:
        walk_errors.append(error)

    try:
        for directory, dirnames, filenames in os.walk(root, topdown=True, onerror=record_error, followlinks=False):
            dirnames[:] = sorted(name for name in dirnames if name not in SKIP_DIRS)
            for filename in sorted(filenames):
                if filename.endswith(".py"):
                    paths.append(Path(directory) / filename)
    except OSError as error:
        walk_errors.append(error)

    if walk_errors:
        details = "; ".join(str(error) for error in walk_errors[:5])
        raise RepositoryError(f"Unable to discover repository files: {details}")
    return paths


def is_excluded(relative_path: Path) -> bool:
    parts = relative_path.parts
    if any(part in SKIP_DIRS for part in parts[:-1]):
        return True
    if any(part in {"test", "tests"} for part in parts[:-1]):
        return True
    filename = relative_path.name
    return (
        filename == "conftest.py"
        or filename.startswith("test_")
        or filename.endswith("_test.py")
    )


def is_docstring_stmt(node: ast.stmt) -> bool:
    return isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)


def extract_target_names(target: ast.AST) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [name for element in target.elts for name in extract_target_names(element)]
    if isinstance(target, ast.Starred):
        return extract_target_names(target.value)
    return []


def is_constant_assignment(node: ast.stmt) -> bool:
    if not isinstance(node, (ast.Assign, ast.AnnAssign)):
        return False
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    names = [name for target in targets for name in extract_target_names(target)]
    return bool(names) and all(name.isupper() for name in names)


def is_main_guard(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    return (
        len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and len(test.comparators) == 1
        and isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def get_node_span(node: ast.AST) -> SourceSpan:
    lineno = getattr(node, "lineno", None)
    if not isinstance(lineno, int):
        raise AnalyzerInvariantError(f"AST node {type(node).__name__} has no source line")
    end_lineno = getattr(node, "end_lineno", None) or lineno
    return SourceSpan(lineno, end_lineno)


def collect_logical_lines(tree: ast.AST) -> int:
    return len(
        {
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.stmt) and not is_docstring_stmt(node) and hasattr(node, "lineno")
        }
    )


def collect_top_level_statement_spans(tree: ast.Module) -> tuple[SourceSpan, ...]:
    spans: list[SourceSpan] = []
    for statement in tree.body:
        if isinstance(statement, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if is_docstring_stmt(statement) or is_main_guard(statement) or is_constant_assignment(statement):
            continue
        spans.append(get_node_span(statement))
    return tuple(spans)


class FunctionComplexityAnalyzer(ast.NodeVisitor):
    def __init__(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.root = node
        self.cyclomatic_complexity = 1
        self.max_nesting_depth = 0
        self.branch_count = 0
        self.bare_except_count = 0
        self.bare_except_spans: list[SourceSpan] = []
        self.nesting_depth = 0
        self.line_numbers: set[int] = set()
        self.locals: set[str] = set()

    def analyze(self) -> FunctionMetrics:
        self.visit_body(self.root.body)
        return FunctionMetrics(
            name=self.root.name,
            qualname=self.root.name,
            lineno=self.root.lineno,
            end_lineno=self.root.end_lineno or self.root.lineno,
            cyclomatic_complexity=self.cyclomatic_complexity,
            max_nesting_depth=self.max_nesting_depth,
            logical_line_count=len(self.line_numbers),
            parameter_count=self.count_parameters(),
            local_variable_count=len(self.locals),
            branch_count=self.branch_count,
            bare_except_count=self.bare_except_count,
            bare_except_spans=tuple(self.bare_except_spans),
        )

    def count_parameters(self) -> int:
        node = self.root
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        count = sum(argument.arg not in {"self", "cls"} for argument in arguments)
        return count + int(node.args.vararg is not None) + int(node.args.kwarg is not None)

    def visit_body(self, statements: list[ast.stmt]) -> None:
        for statement in statements:
            self.visit(statement)

    @contextmanager
    def nested(self):
        self.nesting_depth += 1
        self.max_nesting_depth = max(self.max_nesting_depth, self.nesting_depth)
        try:
            yield
        finally:
            self.nesting_depth -= 1

    def record_statement(self, node: ast.stmt) -> None:
        if not is_docstring_stmt(node):
            self.line_numbers.add(node.lineno)

    def handle_branch(self, node: ast.stmt, increment: int = 1) -> None:
        self.record_statement(node)
        self.branch_count += increment
        self.cyclomatic_complexity += increment

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.line_numbers.add(node.lineno)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.line_numbers.add(node.lineno)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.line_numbers.add(node.lineno)

    def visit_If(self, node: ast.If) -> None:
        self.handle_branch(node)
        self.visit(node.test)
        with self.nested():
            self.visit_body(node.body)
            self.visit_body(node.orelse)

    def visit_For(self, node: ast.For) -> None:
        self.handle_branch(node)
        self.collect_target(node.target)
        self.visit(node.iter)
        with self.nested():
            self.visit_body(node.body)
            self.visit_body(node.orelse)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.handle_branch(node)
        self.collect_target(node.target)
        self.visit(node.iter)
        with self.nested():
            self.visit_body(node.body)
            self.visit_body(node.orelse)

    def visit_While(self, node: ast.While) -> None:
        self.handle_branch(node)
        self.visit(node.test)
        with self.nested():
            self.visit_body(node.body)
            self.visit_body(node.orelse)

    def visit_Try(self, node: ast.Try) -> None:
        self.record_statement(node)
        with self.nested():
            self.visit_body(node.body)
            for handler in node.handlers:
                self.branch_count += 1
                self.cyclomatic_complexity += 1
                if handler.type is None:
                    self.bare_except_count += 1
                    self.bare_except_spans.append(get_node_span(handler))
                if handler.name:
                    self.locals.add(handler.name)
                self.visit_body(handler.body)
            self.visit_body(node.orelse)
            self.visit_body(node.finalbody)

    def visit_With(self, node: ast.With) -> None:
        self.record_statement(node)
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.collect_target(item.optional_vars)
        with self.nested():
            self.visit_body(node.body)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        self.record_statement(node)
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.collect_target(item.optional_vars)
        with self.nested():
            self.visit_body(node.body)

    def visit_Match(self, node: ast.Match) -> None:
        non_default_cases = sum(
            not isinstance(case.pattern, ast.MatchAs) or case.pattern.name is not None for case in node.cases
        )
        if non_default_cases:
            self.handle_branch(node, non_default_cases)
        else:
            self.record_statement(node)
        self.visit(node.subject)
        with self.nested():
            for case in node.cases:
                if case.guard is not None:
                    self.branch_count += 1
                    self.cyclomatic_complexity += 1
                    self.visit(case.guard)
                self.visit_body(case.body)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self.cyclomatic_complexity += 1
        self.branch_count += 1
        self.generic_visit(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        self.cyclomatic_complexity += max(0, len(node.values) - 1)
        self.generic_visit(node)

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self.handle_comprehension(node.generators)
        self.generic_visit(node)

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self.handle_comprehension(node.generators)
        self.generic_visit(node)

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self.handle_comprehension(node.generators)
        self.generic_visit(node)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self.handle_comprehension(node.generators)
        self.generic_visit(node)

    def handle_comprehension(self, generators: list[ast.comprehension]) -> None:
        increment = sum(len(generator.ifs) for generator in generators)
        self.cyclomatic_complexity += increment
        self.branch_count += increment
        for generator in generators:
            self.collect_target(generator.target)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.record_statement(node)
        for target in node.targets:
            self.collect_target(target)
        self.visit(node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self.record_statement(node)
        self.collect_target(node.target)
        if node.value is not None:
            self.visit(node.value)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self.record_statement(node)
        self.collect_target(node.target)
        self.visit(node.value)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.collect_target(node.target)
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:
        self.record_statement(node)
        if node.value is not None:
            self.visit(node.value)

    def visit_Raise(self, node: ast.Raise) -> None:
        self.record_statement(node)
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:
        self.record_statement(node)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:
        self.record_statement(node)
        self.generic_visit(node)

    def visit_Pass(self, node: ast.Pass) -> None:
        self.record_statement(node)

    def visit_Break(self, node: ast.Break) -> None:
        self.record_statement(node)

    def visit_Continue(self, node: ast.Continue) -> None:
        self.record_statement(node)

    def collect_target(self, target: ast.AST) -> None:
        self.locals.update(extract_target_names(target))


class ModuleAnalyzer(ast.NodeVisitor):
    def __init__(self) -> None:
        self.class_stack: list[str] = []
        self.function_stack: list[str] = []
        self.function_metrics: list[FunctionMetrics] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.record_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.record_function(node)

    def record_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.function_stack.append(node.name)
        metrics = FunctionComplexityAnalyzer(node).analyze()
        metrics.qualname = ".".join([*self.class_stack, *self.function_stack])
        metrics.quality_score = score_function(metrics)
        self.function_metrics.append(metrics)
        self.generic_visit(node)
        self.function_stack.pop()


def score_function(metrics: FunctionMetrics) -> int:
    penalty = 0.0
    penalty += max(0, metrics.cyclomatic_complexity - SOFT_LIMITS["cyclomatic_complexity"]) * 4
    penalty += max(0, metrics.max_nesting_depth - SOFT_LIMITS["max_nesting_depth"]) * 5
    penalty += max(0, metrics.logical_line_count - SOFT_LIMITS["logical_line_count"]) * 1.5
    penalty += max(0, metrics.parameter_count - SOFT_LIMITS["parameter_count"]) * 3
    penalty += max(0, metrics.local_variable_count - SOFT_LIMITS["local_variable_count"]) * 1
    penalty += max(0, metrics.branch_count - SOFT_LIMITS["branch_count"]) * 2
    return max(0, round(100 - penalty))


def compute_file_quality(metrics: FileMetrics) -> int:
    scores = [function.quality_score for function in metrics.function_metrics]
    base = 100.0 if not scores else 0.7 * min(scores) + 0.3 * (sum(scores) / len(scores))
    module_penalty = 0.0
    if metrics.path.name != "__init__.py":
        module_penalty += max(0, metrics.module_logical_line_count - SOFT_LIMITS["module_logical_line_count"]) * 0.1
        module_penalty += len(metrics.top_level_statement_spans) * 2
    return max(0, round(base - module_penalty))


def count_hard_limit_violations(functions: list[FunctionMetrics]) -> int:
    return sum(
        getattr(function, metric_name) > threshold
        for function in functions
        for metric_name, threshold in HARD_LIMITS.items()
    )


def analyze_file(path: Path, root: Path) -> FileMetrics:
    relative_path = path.relative_to(root)
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError) as error:
        raise AnalysisError(relative_path, error) from error

    analyzer = ModuleAnalyzer()
    analyzer.visit(tree)
    metrics = FileMetrics(
        path=relative_path,
        module_logical_line_count=collect_logical_lines(tree),
        top_level_statement_spans=collect_top_level_statement_spans(tree),
        function_metrics=analyzer.function_metrics,
    )
    metrics.quality_score = compute_file_quality(metrics)
    metrics.hard_limit_violation_count = count_hard_limit_violations(metrics.function_metrics)
    validate_metrics(metrics)
    return metrics


def validate_metrics(metrics: FileMetrics) -> None:
    if not 0 <= metrics.quality_score <= 100:
        raise AnalyzerInvariantError(f"Invalid file quality score for {metrics.path.as_posix()}")
    for function in metrics.function_metrics:
        values = (
            function.cyclomatic_complexity,
            function.max_nesting_depth,
            function.logical_line_count,
            function.parameter_count,
            function.local_variable_count,
            function.branch_count,
            function.bare_except_count,
        )
        if not 0 <= function.quality_score <= 100 or any(value < 0 for value in values):
            raise AnalyzerInvariantError(f"Invalid function metrics for {metrics.path.as_posix()}:{function.qualname}")


def rank_files(metrics: list[FileMetrics]) -> list[FileMetrics]:
    return sorted(
        metrics,
        key=lambda item: (
            item.quality_score,
            -item.hard_limit_violation_count,
            -item.highest_complexity,
            -item.deepest_nesting,
            -item.module_logical_line_count,
            item.path.as_posix(),
        ),
    )


def rank_functions(functions: list[FunctionMetrics]) -> list[FunctionMetrics]:
    return sorted(
        functions,
        key=lambda item: (
            item.quality_score,
            -item.cyclomatic_complexity,
            -item.max_nesting_depth,
            -item.logical_line_count,
            item.qualname,
        ),
    )


def crosses_soft_limit(metrics: FunctionMetrics) -> bool:
    return any(
        getattr(metrics, metric_name) > threshold
        for metric_name, threshold in SOFT_LIMITS.items()
        if metric_name != "module_logical_line_count"
    )


def format_spans(spans: tuple[SourceSpan, ...]) -> str:
    return ", ".join(span.format() for span in spans)


def render_report(metrics: FileMetrics) -> str:
    functions = rank_functions(metrics.function_metrics)
    lines = [
        f"- `{metrics.path.as_posix()}`",
        f"  - Quality heuristic: {metrics.quality_score}/100",
        f"  - Module logical lines: {metrics.module_logical_line_count}",
        f"  - Functions: {len(metrics.function_metrics)}",
        f"  - Hard-limit violations: {metrics.hard_limit_violation_count}",
    ]
    if metrics.top_level_statement_spans:
        lines.append(
            f"  - Top-level executable statements: {len(metrics.top_level_statement_spans)} at {format_spans(metrics.top_level_statement_spans)}"
        )
    if not functions:
        lines.append("  - None found")
        return "\n".join(lines) + "\n"

    biggest = functions[0]
    if biggest is None:
        raise AnalyzerInvariantError("Function ranking returned no biggest offender")
    lines.extend(
        [
            f"  - Biggest offender: `{biggest.qualname}` at {SourceSpan(biggest.lineno, biggest.end_lineno).format()}",
            f"    - Quality heuristic: {biggest.quality_score}/100",
            f"    - Cyclomatic complexity: {biggest.cyclomatic_complexity}",
            f"    - Maximum nesting depth: {biggest.max_nesting_depth}",
            f"    - Logical lines: {biggest.logical_line_count}",
            f"    - Parameters: {biggest.parameter_count}",
            f"    - Local variables: {biggest.local_variable_count}",
            f"    - Branches: {biggest.branch_count}",
        ]
    )
    if biggest.bare_except_count:
        lines.append(
            f"    - Bare `except` clauses: {biggest.bare_except_count} at {format_spans(biggest.bare_except_spans)}"
        )

    hotspots = [function for function in functions[1:] if crosses_soft_limit(function)][:4]
    if hotspots:
        lines.append("  - Other hotspots:")
        for function in hotspots:
            lines.append(
                f"    - `{function.qualname}` at {SourceSpan(function.lineno, function.end_lineno).format()}: "
                f"quality {function.quality_score}/100, complexity {function.cyclomatic_complexity}, "
                f"nesting {function.max_nesting_depth}, logical lines {function.logical_line_count}, "
                f"parameters {function.parameter_count}, locals {function.local_variable_count}, branches {function.branch_count}"
            )
    return "\n".join(lines) + "\n"


def run(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = resolve_repo_root(args.repo_root)
        paths = discover_python_files(root)
    except RepositoryError as error:
        print(error, file=sys.stderr)
        return EXIT_BOUNDARY

    if not paths:
        print(f"No production Python files found under {root}", file=sys.stderr)
        return EXIT_NO_FILES

    try:
        results = [analyze_file(path, root) for path in paths]
        ranked = rank_files(results)
        if not ranked:
            raise AnalyzerInvariantError("Repository ranking is empty after successful discovery")
        sys.stdout.write(render_report(ranked[0]))
    except AnalysisError as error:
        print(f"{error.path.as_posix()}: {error.error}", file=sys.stderr)
        return EXIT_ANALYSIS
    except AnalyzerInvariantError as error:
        print(f"Analyzer invariant failed: {error}", file=sys.stderr)
        return EXIT_INVARIANT
    except Exception as error:
        print(f"Analyzer invariant failed: {type(error).__name__}: {error}", file=sys.stderr)
        return EXIT_INVARIANT
    return 0


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
