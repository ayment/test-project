import os
import io
import asyncio
import tempfile
from typing import List, Tuple

import fitz  # PyMuPDF
import pytesseract
from PIL import Image

from deep_translator import GoogleTranslator
import arabic_reshaper
from bidi.algorithm import get_display

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

TOKEN = os.getenv("BOT_TOKEN")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # e.g. https://your-domain.com
PORT = int(os.getenv("PORT", "8080"))

# Arabic font file that supports Arabic glyphs (ship it with your code!)
ARABIC_FONT = os.getenv("ARABIC_FONT", "fonts/Amiri-Regular.ttf")

# OCR language packs installed in your system tesseract
TESS_LANGS = os.getenv("TESS_LANGS", "eng")

# Use auto source so it can translate more than only English
translator = GoogleTranslator(source="auto", target="ar")


def prepare_arabic_for_pdf(text: str) -> str:
    """
    PyMuPDF doesn't do Arabic shaping/RTL layout automatically.
    We reshape + bidi each line so Arabic displays correctly.
    """
    reshaper = arabic_reshaper.ArabicReshaper(configuration={"delete_harakat": False})
    out_lines = []
    for line in text.splitlines():
        if not line.strip():
            out_lines.append("")
            continue
        shaped = reshaper.reshape(line)
        out_lines.append(get_display(shaped))
    return "\n".join(out_lines)


def translate_chunked(text: str, max_chunk_chars: int = 3500) -> str:
    """
    Google translate endpoints often have length limits.
    We split into chunks and translate each chunk.
    """
    text = (text or "").strip()
    if not text:
        return ""

    # Split by paragraphs, then pack into chunks <= max_chunk_chars
    parts = [p.strip() for p in text.split("\n") if p.strip()]
    chunks = []
    buf = ""

    for p in parts:
        if len(buf) + len(p) + 1 <= max_chunk_chars:
            buf = (buf + "\n" + p).strip()
        else:
            if buf:
                chunks.append(buf)
            if len(p) <= max_chunk_chars:
                buf = p
            else:
                # Hard split very long paragraph
                for i in range(0, len(p), max_chunk_chars):
                    chunks.append(p[i : i + max_chunk_chars])
                buf = ""

    if buf:
        chunks.append(buf)

    translated = []
    for c in chunks:
        translated.append(translator.translate(c))
    return "\n\n".join(translated).strip()


def ocr_pil_image(img: Image.Image) -> str:
    """
    OCR for a PIL image.
    """
    if img.mode != "RGB":
        img = img.convert("RGB")

    # Common OCR settings
    config = "--oem 1 --psm 6"
    return pytesseract.image_to_string(img, lang=TESS_LANGS, config=config)


def extract_text_from_pdf_page(page: fitz.Page) -> str:
    """
    Extract selectable text + OCR the rendered page image (works for scanned PDFs).
    """
    extracted = (page.get_text("text") or "").strip()

    # Render full page and OCR it to capture text inside images/scans
    zoom = 3  # ~216 dpi (increase to 4 for better OCR but slower)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    pil = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    ocr = (ocr_pil_image(pil) or "").strip()

    # Combine both
    full = "\n".join([t for t in [extracted, ocr] if t]).strip()
    return full


def split_for_pdf(text: str, max_chars: int = 2600) -> List[str]:
    """
    Simple splitter so very long translations can continue on extra pages.
    (Not perfect typography, but prevents truncation.)
    """
    text = (text or "").strip()
    if len(text) <= max_chars:
        return [text] if text else [""]

    lines = text.splitlines()
    pages = []
    buf = ""

    for line in lines:
        if len(buf) + len(line) + 1 <= max_chars:
            buf += line + "\n"
        else:
            pages.append(buf.strip())
            buf = line + "\n"

    if buf.strip():
        pages.append(buf.strip())

    return pages


def build_translated_pdf(input_pdf_path: str, output_pdf_path: str) -> None:
    """
    Creates a NEW PDF:
      - copy each original page
      - add 1+ translation pages after it
    """
    src = fitz.open(input_pdf_path)
    out = fitz.open()

    fontfile = ARABIC_FONT if (ARABIC_FONT and os.path.exists(ARABIC_FONT)) else None

    for i in range(src.page_count):
        src_page = src[i]
        out.insert_pdf(src, from_page=i, to_page=i)  # copy the original page

        english = extract_text_from_pdf_page(src_page).strip()
        if not english:
            english = "(No text found on this page)"

        arabic = translate_chunked(english).strip()
        if not arabic:
            arabic = "(تعذر الحصول على ترجمة)"

        rect = src_page.rect
        chunks = split_for_pdf(arabic, max_chars=2600)

        for j, chunk in enumerate(chunks, start=1):
            tp = out.new_page(width=rect.width, height=rect.height)

            margin = 40
            header = f"Page {i+1} — Arabic Translation ({j}/{len(chunks)})"
            tp.insert_text((margin, margin - 10), header, fontsize=11)

            box = fitz.Rect(margin, margin + 10, rect.width - margin, rect.height - margin)

            # Prepare RTL Arabic
            prepared_ar = prepare_arabic_for_pdf(chunk)

            tp.insert_textbox(
                box,
                prepared_ar,
                fontsize=12,
                fontfile=fontfile,  # IMPORTANT: embed Arabic font, otherwise Arabic can be blank
                align=fitz.TEXT_ALIGN_RIGHT,
                lineheight=1.2,
            )

    out.save(output_pdf_path, garbage=4, deflate=True)
    out.close()
    src.close()


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Send me a PDF or an image.\n"
        "• PDFs: I will OCR + translate each page to Arabic and return a translated PDF.\n"
        "• Images: I will OCR + translate and send the Arabic text."
    )


async def handle_pdf(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Processing your PDF (OCR + translation)...")

    tg_file = await update.message.document.get_file()

    with tempfile.TemporaryDirectory() as tmp:
        input_path = os.path.join(tmp, update.message.document.file_name or "input.pdf")
        output_path = os.path.join(tmp, "translated.pdf")
        await tg_file.download_to_drive(input_path)

        try:
            await asyncio.to_thread(build_translated_pdf, input_path, output_path)
        except Exception as e:
            await update.message.reply_text(f"Failed to process PDF: {e}")
            return

        with open(output_path, "rb") as f:
            await update.message.reply_document(document=f, filename="translated.pdf")


async def handle_image(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Processing image (OCR + translation)...")

    # Photo sent as photo
    if update.message.photo:
        tg_file = await update.message.photo[-1].get_file()
        suffix = ".jpg"
        name = "image.jpg"
    else:
        # Image sent as document
        tg_file = await update.message.document.get_file()
        name = update.message.document.file_name or "image"
        _, ext = os.path.splitext(name)
        suffix = ext if ext else ".png"

    with tempfile.TemporaryDirectory() as tmp:
        img_path = os.path.join(tmp, f"input{suffix}")
        await tg_file.download_to_drive(img_path)

        def ocr_and_translate() -> Tuple[str, str]:
            img = Image.open(img_path)
            extracted = (ocr_pil_image(img) or "").strip()
            if not extracted:
                extracted = "(No text found)"
            arabic = translate_chunked(extracted).strip()
            if not arabic:
                arabic = "(تعذر الحصول على ترجمة)"
            return extracted, arabic

        try:
            extracted, arabic = await asyncio.to_thread(ocr_and_translate)
        except Exception as e:
            await update.message.reply_text(f"Failed to process image: {e}")
            return

        # Send arabic; if too long, send as txt
        if len(arabic) <= 3500:
            await update.message.reply_text(arabic)
        else:
            txt_path = os.path.join(tmp, "translation_ar.txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(arabic)
            with open(txt_path, "rb") as f:
                await update.message.reply_document(document=f, filename="translation_ar.txt")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Translate plain text messages too
    text = (update.message.text or "").strip()
    if not text:
        return
    arabic = await asyncio.to_thread(translate_chunked, text)
    await update.message.reply_text(arabic or "(تعذر الحصول على ترجمة)")


def main():
    if not TOKEN:
        raise ValueError("BOT_TOKEN is missing!")

    app = Application.builder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.Document.PDF, handle_pdf))

    # Images: photos or images as documents
    app.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, handle_image))

    # Text messages (optional)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    # Webhook if WEBHOOK_URL is set; else polling for development
    if WEBHOOK_URL:
        app.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=TOKEN,
            webhook_url=f"{WEBHOOK_URL}/{TOKEN}",
        )
    else:
        app.run_polling()


if __name__ == "__main__":
    main()
