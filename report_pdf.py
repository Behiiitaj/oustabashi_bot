import json
import os
import sys
from pathlib import Path

SKILL_DIR = Path(os.environ.get("PDF_SKILL_DIR", Path(__file__).with_name("pdf_support")))
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from fa_pdf import register_persian_fonts, rtl_line, rtl_paragraph
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


def make_pdf(output, data):
    register_persian_fonts()
    page_w, page_h = A4
    c = canvas.Canvas(output, pagesize=A4)
    margin = 18 * mm
    width = page_w - (2 * margin)
    body = ParagraphStyle("body", fontName="Vazirmatn", fontSize=8.5, leading=14, alignment=TA_RIGHT)
    bold = ParagraphStyle("bold", parent=body, fontName="Vazirmatn-Bold")
    logo_path = Path(__file__).with_name("company-logo.png")

    done = int(data.get("doneCount", 0))
    not_done = sum(row["status"] == "NOT_DONE" for row in data["rows"])
    unchecked = sum(row["status"] == "NOT_CHECKED" for row in data["rows"])
    total = done + not_done + unchecked

    def header():
        c.setFillColor(colors.HexColor("#263B53"))
        c.roundRect(margin, page_h - 34 * mm, width, 20 * mm, 4 * mm, fill=1, stroke=0)
        if logo_path.exists():
            logo_x = margin + 4 * mm
            logo_y = page_h - 32 * mm
            logo_size = 16 * mm
            c.setFillColor(colors.white)
            c.roundRect(logo_x, logo_y, logo_size, logo_size, 3 * mm, fill=1, stroke=0)
            c.drawImage(ImageReader(str(logo_path)), logo_x + 1 * mm, logo_y + 1 * mm, logo_size - 2 * mm, logo_size - 2 * mm, preserveAspectRatio=True, mask="auto")
        c.setFillColor(colors.white)
        c.setFont("Vazirmatn-Bold", 16)
        c.drawRightString(page_w - margin - 5 * mm, page_h - 23 * mm, rtl_line("گزارش پیگیری تسک‌ها"))
        c.setFont("Vazirmatn", 9)
        c.drawRightString(page_w - margin - 5 * mm, page_h - 29 * mm, rtl_line(data["worker"]))
        c.drawString(margin + 25 * mm, page_h - 29 * mm, f"{data['start']}  تا  {data['end']}")

    header()
    y = page_h - 45 * mm
    c.setFillColor(colors.HexColor("#F1F4F7"))
    c.roundRect(margin, y - 17 * mm, width, 14 * mm, 3 * mm, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#17212B"))
    c.setFont("Vazirmatn-Bold", 9)
    c.drawRightString(page_w - margin - 5 * mm, y - 9 * mm, rtl_line(f"تعداد کل: {total}   |   انجام‌شده: {done}   |   انجام‌نشده: {not_done}   |   بررسی‌نشده: {unchecked}"))
    y -= 25 * mm

    def draw_table(table, current_y):
        pending = [table]
        while pending:
            available = current_y - 18 * mm
            parts = pending.pop(0).split(width, available)
            if not parts:
                c.showPage()
                header()
                current_y = page_h - 45 * mm
                pending.insert(0, table)
                continue
            part = parts[0]
            _, table_h = part.wrap(width, page_h)
            if current_y - table_h < 18 * mm:
                c.showPage()
                header()
                current_y = page_h - 45 * mm
                pending.insert(0, part)
                continue
            part.drawOn(c, margin, current_y - table_h)
            current_y -= table_h + 9 * mm
            if parts[1:]:
                pending = parts[1:] + pending
                c.showPage()
                header()
                current_y = page_h - 45 * mm
        return current_y

    task_table_data = [[
        rtl_paragraph("تاریخ", bold, 24 * mm),
        rtl_paragraph("تسک", bold, 72 * mm),
        rtl_paragraph("وضعیت", bold, 30 * mm),
        rtl_paragraph("دلیل انجام نشدن", bold, 48 * mm),
    ]]
    for row in data["rows"]:
        status = "× انجام نشده" if row["status"] == "NOT_DONE" else "؟ پیگیری نشده"
        task_table_data.append([
            Paragraph(row["date"], body),
            rtl_paragraph(row["task"], body, 72 * mm),
            rtl_paragraph(status, body, 30 * mm),
            rtl_paragraph(row["reason"] or "-", body, 48 * mm),
        ])

    c.setFillColor(colors.HexColor("#17212B"))
    c.setFont("Vazirmatn-Bold", 10)
    c.drawRightString(page_w - margin, y, rtl_line("جدول تسک‌ها"))
    y -= 6 * mm
    task_table = Table(task_table_data, colWidths=[24 * mm, 72 * mm, 30 * mm, 48 * mm], repeatRows=1)
    task_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DCE5EE")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#17212B")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C7D0D9")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFB")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    if len(task_table_data) == 1:
        c.setFillColor(colors.HexColor("#687684"))
        c.setFont("Vazirmatn", 8)
        c.drawRightString(page_w - margin, y - 8 * mm, rtl_line("تسکی برای نمایش در این بازه وجود ندارد."))
        y -= 16 * mm
    else:
        y = draw_table(task_table, y)

    day_notes = data.get("dayNotes", [])
    if day_notes:
        if y < 55 * mm:
            c.showPage()
            header()
            y = page_h - 45 * mm
        c.setFillColor(colors.HexColor("#684B00"))
        c.setFont("Vazirmatn-Bold", 10)
        c.drawRightString(page_w - margin, y, rtl_line("جدول روزهای بدون گزارش"))
        y -= 6 * mm
        note_table_data = [[
            rtl_paragraph("تاریخ", bold, 30 * mm),
            rtl_paragraph("وضعیت روز", bold, 45 * mm),
            rtl_paragraph("توضیحات", bold, 99 * mm),
        ]]
        for item in day_notes:
            text = item.get("text", "")
            day_status = "مرخصی احتمالی" if "مرخصی" in text else "تعطیل / گزارش‌نشده"
            note_table_data.append([
                Paragraph(item["date"], body),
                rtl_paragraph(day_status, body, 45 * mm),
                rtl_paragraph(text, body, 99 * mm),
            ])
        note_table = Table(note_table_data, colWidths=[30 * mm, 45 * mm, 99 * mm], repeatRows=1)
        note_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F5DFA3")),
            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#FFF8E6")),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#4A3A12")),
            ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#D4B96A")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        y = draw_table(note_table, y)

    c.setFont("Vazirmatn", 7)
    c.setFillColor(colors.HexColor("#687684"))
    c.drawCentredString(page_w / 2, 10 * mm, rtl_line("گزارش تولیدشده توسط ربات پیگیری تسک‌ها"))
    c.save()


if __name__ == "__main__":
    output = sys.argv[1]
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    make_pdf(output, data)
