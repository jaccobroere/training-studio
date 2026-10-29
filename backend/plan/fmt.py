from __future__ import annotations

from datetime import date


def day_label(d: date) -> str:
    """'Sat 16 Jan' — the one way plan dates are written in summaries."""
    return d.strftime("%a %-d %b")
