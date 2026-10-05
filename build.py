#!/usr/bin/env python3
"""
Сборка данных расширения из единого источника — tools/scraper-export/scraper_to_gipix.py:
  gipix_rules.js — разделы/подкатегории сайта и правила категорий (Python regex → JS regex с флагом u)
  icons/*.png    — иконки расширения

  python3 build.py
"""
import json
import re
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scraper-export"))
import scraper_to_gipix as src  # noqa: E402

W = r"[\p{L}\p{N}_]"


def to_js(p: str) -> str:
    """Python re → JS: в JS без флага u \\w и \\b не понимают кириллицу."""
    out, i = [], 0
    while i < len(p):
        if p.startswith(r"\w", i):
            out.append(W); i += 2
        elif p.startswith(r"\b", i):
            prev = p[i - 1] if i else ""
            out.append(f"(?<!{W})" if prev in ("", "(", "|", ":") else f"(?!{W})"); i += 2
        elif p.startswith('\\"', i):
            out.append('"'); i += 2  # лишнее экранирование запрещено при флаге u
        else:
            out.append(p[i]); i += 1
    return "".join(out)


def png(size: int) -> bytes:
    """Жёлтая плашка с тремя строками «таблицы» — без внешних библиотек."""
    rows = []
    r = size * 0.22
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cx = min(max(x, r), size - 1 - r)
            cy = min(max(y, r), size - 1 - r)
            inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
            bar = any(abs(y - size * k) < size * 0.055 for k in (0.33, 0.5, 0.67)) and size * 0.24 < x < size * 0.76
            dot = abs(y - size * 0.33) < size * 0.055 and size * 0.24 < x < size * 0.34
            if not inside:
                row += bytes([0, 0, 0, 0])
            elif bar and not dot:
                row += bytes([20, 20, 20, 255])
            else:
                row += bytes([255, 214, 0, 255])
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def main() -> None:
    sections = [[name, [[slug, sub] for slug, sub in items]] for name, items in src.SECTIONS.items()]
    rules = [[slug, to_js(rx.pattern)] for slug, rx in src.RULES]
    js = ("// Сгенерировано build.py из tools/scraper-export/scraper_to_gipix.py — не редактировать вручную.\n"
          f"const GIPIX_RULES = {{\n  SECTIONS: {json.dumps(sections, ensure_ascii=False)},\n"
          f"  RULES: {json.dumps(rules, ensure_ascii=False, indent=0)},\n}};\n"
          "if (typeof module !== 'undefined') module.exports = GIPIX_RULES;\n")
    (HERE / "gipix_rules.js").write_text(js, encoding="utf-8")
    (HERE / "icons").mkdir(exist_ok=True)
    for s in (16, 32, 48, 128):
        (HERE / "icons" / f"{s}.png").write_bytes(png(s))
    print(f"gipix_rules.js: {sum(len(i) for _, i in sections)} подкатегорий, {len(rules)} правил; иконки готовы")


if __name__ == "__main__":
    main()
