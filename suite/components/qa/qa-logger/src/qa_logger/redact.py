from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from typing import Any


@dataclass(frozen=True)
class RedactionFinding:
    category: str
    location: str
    action: str = "redacted"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (
        "private_key",
        re.compile(
            r"-----BEGIN\s+[A-Z0-9 ]*PRIVATE\s+KEY-----.*?-----END\s+[A-Z0-9 ]*PRIVATE\s+KEY-----",
            re.IGNORECASE | re.DOTALL,
        ),
        "[REDACTED:private_key]",
    ),
    (
        "authorization",
        re.compile(r"\bAuthorization\s*[:=]\s*[^\r\n,;]+", re.IGNORECASE),
        "[REDACTED:authorization]",
    ),
    (
        "bearer_token",
        re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE),
        "[REDACTED:bearer_token]",
    ),
    (
        "cookie",
        re.compile(r"\bCookie\s*[:=]\s*[^\r\n]+", re.IGNORECASE),
        "[REDACTED:cookie]",
    ),
    (
        "credential_field",
        re.compile(
            r"\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)\b"
            r"\s*[:=]\s*['\"]?[^'\"\s,;]{6,}",
            re.IGNORECASE,
        ),
        "[REDACTED:credential_field]",
    ),
]


def redact_text(value: str, location: str) -> tuple[str, list[RedactionFinding]]:
    findings: list[RedactionFinding] = []
    redacted = value
    for category, pattern, replacement in _PATTERNS:
        if pattern.search(redacted):
            findings.append(RedactionFinding(category=category, location=location))
            redacted = pattern.sub(replacement, redacted)
    return redacted, findings


def redact_value(value: Any, location: str = "$") -> tuple[Any, list[RedactionFinding]]:
    if isinstance(value, str):
        return redact_text(value, location)
    if isinstance(value, list):
        next_values: list[Any] = []
        findings: list[RedactionFinding] = []
        for index, item in enumerate(value):
            next_item, item_findings = redact_value(item, f"{location}[{index}]")
            next_values.append(next_item)
            findings.extend(item_findings)
        return next_values, findings
    if isinstance(value, dict):
        next_dict: dict[str, Any] = {}
        findings: list[RedactionFinding] = []
        for key, item in value.items():
            redacted_key, key_findings = redact_text(str(key), f"{location}.{key}.__key__")
            next_item, item_findings = redact_value(item, f"{location}.{redacted_key}")
            next_dict[redacted_key] = next_item
            findings.extend(key_findings)
            findings.extend(item_findings)
        return next_dict, findings
    return value, []


def sensitivity_level(findings: list[RedactionFinding]) -> str:
    return "redacted" if findings else "none"

