#!/usr/bin/env python3
"""Create a local, non-versioned configuration for personal-knowledge-recall."""

from __future__ import annotations

import argparse
import json
import ntpath
import os
from pathlib import Path, PurePosixPath
import tempfile
from typing import Iterable


SCHEMA_VERSION = 1
DEFAULT_ENTRY_FILES = ["00-AI入口.md", "README.md", "Home.md"]
WINDOWS_DEVICE_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "CLOCK$",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


class ConfigurationError(ValueError):
    """Raised when a configuration value would be unsafe or unusable."""


def portable_relative_path(value: str, field_name: str) -> str:
    """Return one normalized portable relative path or raise."""

    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"{field_name} must not be empty")
    if value != value.strip():
        raise ConfigurationError(
            f"{field_name} must not have leading or trailing whitespace: {value!r}"
        )

    raw = value
    drive, _ = ntpath.splitdrive(raw)
    normalized = raw.replace("\\", "/")
    candidate = PurePosixPath(normalized)

    if drive or normalized.startswith("/") or normalized.startswith("//") or candidate.is_absolute():
        raise ConfigurationError(f"{field_name} must be a relative path: {value}")

    parts = candidate.parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ConfigurationError(f"{field_name} contains an unsafe path segment: {value}")
    if any(
        any(ord(character) < 32 for character in part)
        or any(character in '<>:"|?*' for character in part)
        or part.endswith((" ", "."))
        or part.split(".", 1)[0].upper() in WINDOWS_DEVICE_NAMES
        for part in parts
    ):
        raise ConfigurationError(f"{field_name} is not portable: {value}")

    return "/".join(parts)


def _is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def validate_vault(value: str) -> Path:
    raw = Path(value).expanduser()
    if not raw.is_absolute():
        raise ConfigurationError("vault_root must be an absolute path")
    if not raw.exists():
        raise ConfigurationError(f"vault_root does not exist: {raw}")
    if not raw.is_dir():
        raise ConfigurationError(f"vault_root is not a directory: {raw}")
    if _is_link_or_junction(raw):
        raise ConfigurationError("vault_root must not be a symlink or directory junction")

    # Resolve once and persist the canonical location. On Windows an 8.3 short
    # path can differ textually from its long path without being a redirect, so
    # string comparison would create a false positive. The root itself and all
    # configured children are still checked for links and junctions.
    return raw.resolve(strict=True)


def validate_child(root: Path, relative: str, field_name: str) -> str:
    normalized = portable_relative_path(relative, field_name)
    target = root.joinpath(*PurePosixPath(normalized).parts)
    root_norm = os.path.normcase(str(root))
    target_norm = os.path.normcase(str(target.resolve(strict=False)))

    try:
        common = os.path.commonpath([root_norm, target_norm])
    except ValueError as exc:
        raise ConfigurationError(f"{field_name} escapes vault_root: {relative}") from exc
    if common != root_norm:
        raise ConfigurationError(f"{field_name} escapes vault_root: {relative}")

    current = root
    for part in PurePosixPath(normalized).parts:
        current = current / part
        if current.exists() and _is_link_or_junction(current):
            raise ConfigurationError(f"{field_name} passes through a symlink or junction: {relative}")
    return normalized


def unique_in_order(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def build_config(
    vault: str,
    entries: Iterable[str],
    restricted: Iterable[str],
) -> dict[str, object]:
    root = validate_vault(vault)

    entry_files = unique_in_order(
        validate_child(root, value, "entry_files") for value in entries
    )
    restricted_paths = unique_in_order(
        validate_child(root, value, "restricted_paths") for value in restricted
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "vault_root": str(root),
        "entry_files": entry_files,
        "restricted_paths": restricted_paths,
    }


def absolute_without_resolving(path: Path) -> Path:
    """Make a path absolute without following a final or parent link."""

    return Path(os.path.abspath(os.path.expanduser(str(path))))


def validate_output_path(output: Path) -> None:
    if not output.name:
        raise ConfigurationError("configuration output must name a file")

    # Check every currently existing component. Path.is_symlink() also catches
    # dangling links, for which exists() is false.
    for component in (output, *output.parents):
        if _is_link_or_junction(component):
            raise ConfigurationError(
                f"configuration output must not use a symlink or directory junction: {component}"
            )


def write_json_atomic(path: Path, payload: dict[str, object], force: bool) -> Path:
    output = absolute_without_resolving(path)
    validate_output_path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    validate_output_path(output)

    lock = output.with_name(f".{output.name}.lock")
    try:
        lock_handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise ConfigurationError(f"configuration write is already in progress: {lock}") from exc

    temporary: Path | None = None
    try:
        os.close(lock_handle)
        validate_output_path(output)
        if os.path.lexists(output) and not force:
            raise ConfigurationError(
                f"configuration already exists: {output}; use --force to replace it"
            )

        handle, temporary_name = tempfile.mkstemp(
            prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
        )
        temporary = Path(temporary_name)
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

        # The un-resolved destination means an existing link is replaced as a
        # directory entry rather than followed. We still reject links above so
        # that --force cannot be used to repoint configuration writes.
        validate_output_path(output)
        os.replace(temporary, output)
        temporary = None
        return output
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def parse_args() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Validate an Obsidian vault and create local-config.json."
    )
    parser.add_argument("--vault", required=True, help="absolute path to the Obsidian vault")
    parser.add_argument(
        "--entry",
        action="append",
        dest="entries",
        help="relative entry file; may be repeated",
    )
    parser.add_argument(
        "--restricted",
        action="append",
        default=[],
        help="relative restricted directory; may be repeated",
    )
    parser.add_argument(
        "--output",
        default=str(repository_root / "local-config.json"),
        help="configuration output path",
    )
    parser.add_argument("--force", action="store_true", help="replace an existing config")
    parser.add_argument("--json", action="store_true", help="print a machine-readable result")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = build_config(
            args.vault,
            args.entries or DEFAULT_ENTRY_FILES,
            args.restricted,
        )
        output = write_json_atomic(Path(args.output), config, args.force)
    except (ConfigurationError, OSError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"ERROR: {exc}", file=os.sys.stderr)
        return 2

    result = {"ok": True, "config": str(output), "vault_root": config["vault_root"]}
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Created {output}")
        print(f"Vault: {config['vault_root']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
