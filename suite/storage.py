"""Local paths and state shared by the installer and workflow."""

import hashlib
import json
import os
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path


def is_redirect(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def local_path(value):
    path = Path(os.path.abspath(value))
    for part in (*reversed(path.parents), path):
        if os.path.lexists(part) and is_redirect(part):
            raise ValueError(f"Redirected path is outside the supported scope: {part}")
    return path


def relative_parts(value):
    if not isinstance(value, str) or "\\" in value or ":" in value:
        raise ValueError("Expected a portable relative path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Expected a portable relative path")
    return parts


def inside(root, relative):
    return local_path(root.joinpath(*relative_parts(relative)))


def read_path(root, relative):
    path = inside(root, relative)
    if not path.is_file():
        raise ValueError(f"Missing file: {relative}")
    return path


def overlaps(left, right):
    return left == right or left in right.parents or right in left.parents


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    fingerprint = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(256 * 1024), b""):
            fingerprint.update(data)
    return fingerprint.hexdigest()


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_text(path, text):
    local_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, encoding="utf-8", newline="\n", mode="w", delete=False
        ) as stream:
            temp = Path(stream.name)
            stream.write(text)
        os.replace(temp, path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def save_json(path, value):
    atomic_text(path, json_text(value))


@contextmanager
def workflow_lock(runtime):
    lock = inside(runtime, ".workflow.lock")
    try:
        with lock.open("x", encoding="ascii") as stream:
            stream.write(str(os.getpid()))
    except FileExistsError as exc:
        raise ValueError("Workflow is locked. Check whether another run is still active.") from exc
    try:
        yield
    finally:
        lock.unlink()
