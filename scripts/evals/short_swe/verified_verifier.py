"""Trusted rewrites for pinned SWE-bench Verified test templates."""

import json
import re
import shlex
from pathlib import Path

INSTALLS = {
    "python -m pip install -e .[test] --verbose",
    "python -m pip install -e .",
    "python -m pip install -e .[dev]",
    "python -m pip install -e .[test]",
    "python -m pip install .",
}
PARSER = 'uv run parser.py | tee -a "$LOG_FILE"'
LOG_ASSIGNMENT = "LOG_FILE=$(mktemp)"
TEE_REDIRECT = 'exec > >(tee "$LOG_FILE") 2>&1'


def trusted_base_commit(task_dir: Path) -> str:
    config = json.loads((task_dir / "tests" / "config.json").read_text())
    base = config.get("base_commit")
    if not isinstance(base, str) or len(base) != 40 or any(ch not in "0123456789abcdef" for ch in base):
        raise ValueError("invalid SWE-bench base commit")
    return base


def patch_collect_command(task_dir: Path) -> str:
    base = trusted_base_commit(task_dir)
    return (
        "rm -rf /logs/artifacts && "
        "git add -N -- . && "
        f"git diff --binary --no-ext-diff {base} -- . > /tmp/prime-agent.patch"
    )


def rewrite_test_script(script: str) -> str:
    install_lines = [line for line in script.splitlines() if line.strip().startswith("python -m pip install")]
    if (
        script.count(PARSER) != 1
        or script.count(LOG_ASSIGNMENT) != 1
        or script.count(TEE_REDIRECT) != 1
        or script.count(" || true") != 1
        or len(install_lines) > 1
        or any(line.strip() not in INSTALLS for line in install_lines)
    ):
        raise RuntimeError("SWE-bench verifier template did not match")
    for line in install_lines:
        replacement = line[: len(line) - len(line.lstrip())] + (
            ": # dependencies are pinned in the task image; test the mounted source tree"
        )
        script = script.replace(line, replacement, 1)
    script = script.replace(" || true", " || TEST_STATUS=$?", 1)
    script = script.replace(LOG_ASSIGNMENT, "LOG_FILE=/dev/null", 1)
    script = script.replace(TEE_REDIRECT, ": # output captured by the runtime controller", 1)
    return script.replace(PARSER, 'exit "${TEST_STATUS:-0}"', 1)


# Maximum patch size accepted for filtering (prevents memory abuse).
MAX_PATCH_BYTES = 16 * 1024 * 1024

# Paths that control test execution; a candidate patch must not touch them
# in the verifier sandbox because the pinned test metadata is the contract.
TEST_CONTROL = re.compile(
    r"^(?:[^/]+/)*"
    r"(?:conftest\.py|pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg|"
    r"test_[^/]*\.py|[^/]*_test\.py)$"
)


def _decode_patch(raw: bytes | str) -> str:
    """Decode a runtime.read patch payload to text."""
    if isinstance(raw, str):
        return raw
    if len(raw) > MAX_PATCH_BYTES:
        raise RuntimeError("candidate patch exceeds the filtering cap")
    return raw.decode("utf-8", errors="strict")


def _patch_paths(header: str) -> tuple[str, str]:
    """Extract the a-side and b-side paths from a diff --git header."""
    tokens = shlex.split(header)
    a_path = ""
    b_path = ""
    for token in tokens:
        if token.startswith("a/") and not a_path:
            a_path = token[2:]
        elif token.startswith("b/") and not b_path:
            b_path = token[2:]
    return a_path, b_path


def filter_test_control(raw: bytes | str) -> str:
    """Drop hunks that modify test-control paths from a unified diff.

    The input may be raw bytes (as returned by Runtime.read) or text.
    Only diff --git headers are recognized; a patch without any
    recognized header is rejected so traditional header-less diffs
    cannot bypass the filter.
    """
    patch = _decode_patch(raw)
    kept: list[str] = []
    current: list[str] = []
    a_path = ""
    b_path = ""
    saw_header = False
    for line in patch.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current and not (TEST_CONTROL.fullmatch(a_path) or TEST_CONTROL.fullmatch(b_path)):
                kept.extend(current)
            current = [line]
            a_path, b_path = _patch_paths(line)
            saw_header = True
        else:
            current.append(line)
    if current and not (TEST_CONTROL.fullmatch(a_path) or TEST_CONTROL.fullmatch(b_path)):
        kept.extend(current)
    if not saw_header and patch.strip():
        raise RuntimeError("candidate patch has no diff --git header; refusing to filter")
    return "".join(kept)
