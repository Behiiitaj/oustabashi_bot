"""Persian/RTL helpers for building PDFs with reportlab.

Run with the plugin venv python (gap_runtime.py py). reportlab draws glyphs
directly and performs no Unicode shaping or bidi, so raw Persian text comes
out disconnected and left-to-right. These helpers make it correct:

    from fa_pdf import register_persian_fonts, rtl_line, rtl_paragraph
    register_persian_fonts()                  # "Vazirmatn", "Vazirmatn-Bold"
    canvas.drawRightString(x, y, rtl_line("سلام دنیا"))
    story.append(rtl_paragraph(long_text, style, doc.width))

Rules that make RTL come out right (learned the hard way; do not "simplify"):
- Single line (canvas strings, table cells that will not wrap): rtl_line().
- Wrapping text: NEVER feed a whole get_display()'d paragraph to Paragraph —
  reportlab wraps after bidi, so the lines come out bottom-up. And reportlab's
  style.wordWrap="RTL" is a no-op for plain paragraphs. rtl_paragraph() wraps
  the logical text itself (measuring shaped widths), applies bidi per line,
  and joins with <br/>. Pass the real available width (doc.width or cell
  width minus padding).
- Numbers/Latin fragments inside Persian text are handled by the bidi
  algorithm; digits can be localized first with persian_digits().
"""

import re
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import XPreformatted

_reshaper = arabic_reshaper.ArabicReshaper(
    {"delete_harakat": False, "support_ligatures": True})

PERSIAN_DIGITS = str.maketrans("0123456789,", "۰۱۲۳۴۵۶۷۸۹٬")


def register_persian_fonts(fonts_dir=None):
    """Register Vazirmatn (+Bold) from the plugin's bundled assets.

    Returns the registered (regular, bold) font names. Idempotent.
    """
    if "Vazirmatn" in pdfmetrics.getRegisteredFontNames():
        return "Vazirmatn", "Vazirmatn-Bold"
    candidates = [Path(fonts_dir)] if fonts_dir else []
    here = Path(__file__).resolve().parent
    candidates += [
        here.parent / "assets" / "fonts",
        Path.home() / "Library" / "Fonts",
        Path.home() / ".local" / "share" / "fonts",
    ]
    for directory in candidates:
        regular = directory / "Vazirmatn-Regular.ttf"
        bold = directory / "Vazirmatn-Bold.ttf"
        if regular.exists():
            pdfmetrics.registerFont(TTFont("Vazirmatn", str(regular)))
            pdfmetrics.registerFont(
                TTFont("Vazirmatn-Bold", str(bold if bold.exists() else regular)))
            return "Vazirmatn", "Vazirmatn-Bold"
    raise FileNotFoundError(
        "Vazirmatn-Regular.ttf not found; pass fonts_dir= or run "
        "'python3 scripts/gap_runtime.py fonts --install'")


def persian_digits(value):
    """Localize ASCII digits and thousands separators: 1,234 -> ۱٬۲۳۴."""
    return str(value).translate(PERSIAN_DIGITS)


def jalali_date(gregorian=None):
    """Convert a datetime.date (default: today) to Solar Hijri (jy, jm, jd).

    Use this for issue dates on Persian documents instead of guessing the
    year — an invoice dated the wrong Jalali year is a real-world failure.
    """
    import datetime
    day = gregorian or datetime.date.today()
    gy, gm, gd = day.year, day.month, day.day
    g_d_m = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
    gy2 = gy + 1 if gm > 2 else gy
    days = (355666 + 365 * gy + (gy2 + 3) // 4 - (gy2 + 99) // 100
            + (gy2 + 399) // 400 + gd + g_d_m[gm - 1])
    jy = -1595 + 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm, jd = 1 + days // 31, 1 + days % 31
    else:
        jm, jd = 7 + (days - 186) // 30, 1 + (days - 186) % 30
    return jy, jm, jd


def jalali_today_str():
    """Today as a Persian-digit Solar Hijri string: ۱۴۰۵/۰۴/۲۷."""
    jy, jm, jd = jalali_date()
    return persian_digits("{}/{:02d}/{:02d}".format(jy, jm, jd))


def shape(text):
    """Contextual shaping only (logical order preserved). Rarely used alone."""
    return _reshaper.reshape(text)


def rtl_line(text):
    """Shape + bidi one line of text for direct drawing or table cells."""
    return get_display(_reshaper.reshape(str(text)))


def wrap_rtl(text, font_name, font_size, max_width):
    """Break LOGICAL Persian text into visual lines that fit max_width.

    Widths are measured on shaped text (shaping changes glyph widths), the
    break points are chosen in logical order, and bidi runs per line, so the
    lines read top-down and right-to-left correctly.
    """
    lines = []
    for logical_line in str(text).split("\n"):
        words = [w for w in re.split(r"\s+", logical_line.strip()) if w]
        if not words:
            lines.append("")
            continue
        current = []
        for word in words:
            attempt = " ".join(current + [word])
            width = pdfmetrics.stringWidth(shape(attempt), font_name, font_size)
            if current and width > max_width:
                lines.append(rtl_line(" ".join(current)))
                current = [word]
            else:
                current.append(word)
        if current:
            lines.append(rtl_line(" ".join(current)))
    return lines


def rtl_paragraph(text, style, avail_width):
    """Multi-line RTL flowable with correct line order and wrapping.

    style must use a registered Persian-capable font and right alignment
    (alignment=2). avail_width is the width the text will occupy (doc.width
    for SimpleDocTemplate frames, or the table column width minus padding).
    Returns an XPreformatted flowable: it honors the pre-computed line
    breaks and never re-wraps (a Paragraph would re-wrap the visual-order
    lines and push the paragraph's FIRST word onto its own line).
    """
    indent = (style.leftIndent or 0) + (style.rightIndent or 0)
    usable = max(24, avail_width - indent - 2)
    lines = wrap_rtl(text, style.fontName, style.fontSize, usable)
    from xml.sax.saxutils import escape
    return XPreformatted("\n".join(escape(line) for line in lines), style)


if __name__ == "__main__":
    import sys
    register_persian_fonts()
    sample = sys.argv[1] if len(sys.argv) > 1 else "سلام دنیا ۱۲۳"
    print("line :", rtl_line(sample))
    print("wrap :", wrap_rtl(sample, "Vazirmatn", 11, 200))
