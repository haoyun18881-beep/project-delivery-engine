from __future__ import annotations

import hashlib
import re
from pathlib import Path


def project_slug(project_name: str, project_root: str | None = None) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", project_name.strip()).strip("-._")
    if not base:
        base = "project"
    if project_root:
        digest = hashlib.sha256(str(Path(project_root)).lower().encode("utf-8")).hexdigest()[:8]
        return f"{base}-{digest}"
    return base

