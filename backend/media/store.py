"""Uploaded files: recognise, re-encode, read and store them (ported from stenen's
uploads.py / images.py / attachments.py).

- The type comes from the first bytes, never from the file name or the browser's claim:
  PNG, JPEG, WebP, HEIC/HEIF and (for chat attachments) PDF.
- Images are oriented, scaled to at most 2000 px, re-encoded (JPEG for photos, PNG for
  screenshots and line art) and stripped of metadata (EXIF, GPS). HEIC/WebP always become
  JPEG/PNG, so stored files are always .jpg or .png.
- PDFs keep their bytes; their text is extracted (page and character caps). A PDF with
  (almost) no text layer is a scan: its first pages are rendered to PNG for the model.
- All decoding (Pillow, pypdf, pdfium) runs in a short-lived worker process (`media/worker.py`)
  with an address-space limit and a timeout, off the event loop: a decompression bomb or an
  absurd PDF page can fail one upload, never the server. Pixel counts and PDF page sizes are
  capped before anything is allocated.
- Files live in `users/<id>/media/<file>`, one `media_file` row each (sha256, size, type).
  The data export already includes `media/`.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import math
import os
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

import db
from core.settings import settings
from models import MediaFile

MAX_BYTES = 20 * 1024 * 1024  # per file, before re-encoding
MAX_SIDE = 2000
QUALITY = 82
MAX_PNG_BYTES = 1_500_000  # a "graphic" that encodes larger than this is stored as JPEG
MAX_PDF_PAGES_READ = 30  # pages whose text is extracted
MAX_TEXT_CHARS = 20_000  # characters of extracted text kept per PDF
MAX_PAGES_RENDERED = 3  # pages of a scanned PDF rendered for the model
RENDER_SIDE = 1600
MAX_PIXELS = 40_000_000  # decoded image size we accept (~40 MP); larger is refused up front
MAX_PDF_PAGES = 500  # more pages than this is not a document we read
MAX_PAGE_PT = 5000  # longest PDF page side in points (~70 inches); A0 is 3370
WORKER_TIMEOUT_S = 30
SCANNED_BELOW_CHARS = 200

PDF, PNG, JPEG, WEBP, HEIC = (
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
)
IMAGES = (PNG, JPEG, WEBP, HEIC)
HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"mif1", b"msf1"}


class MediaError(Exception):
    def __init__(self, code: str, detail: str, status: int = 422):
        super().__init__(detail)
        self.code, self.detail, self.status = code, detail, status


def sniff(content: bytes) -> str | None:
    """Media type from the magic bytes, or None when it isn't one we accept."""
    if content.startswith(b"%PDF-"):
        return PDF
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if content.startswith(b"\xff\xd8\xff"):
        return JPEG
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return WEBP
    if content[4:8] == b"ftyp" and content[8:12] in HEIF_BRANDS:
        return HEIC
    return None


def _pil():
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # Pillow itself refuses beyond 2x this
    return Image


def _flat(img):
    Image = _pil()
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    return img.convert("RGB")


def _too_big() -> str:
    return f"This image is too large; use one under {MAX_PIXELS // 1_000_000} megapixels."


def compress(content: bytes, max_side: int = MAX_SIDE) -> tuple[bytes, str, int, int]:
    """Any accepted image → (bytes, media type, width, height). Always re-encoded, so no
    metadata survives; photos become JPEG, graphics (few colours) PNG."""
    from PIL import ImageOps

    Image = _pil()
    try:
        img = Image.open(io.BytesIO(content))
    except Image.DecompressionBombError as e:
        raise MediaError("image_too_large", _too_big()) from e
    if img.width * img.height > MAX_PIXELS:
        raise MediaError("image_too_large", _too_big())
    if img.format == "JPEG":  # decode at reduced size (a power-of-two DCT shortcut)
        img.draft("RGB", (max_side * 2, max_side * 2))
    try:
        img.load()
    except Image.DecompressionBombError as e:
        raise MediaError("image_too_large", _too_big()) from e
    source = img.format
    img = ImageOps.exif_transpose(img)
    img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    graphic = source != "JPEG" and img.convert("RGB").getcolors(maxcolors=4096) is not None
    if graphic:
        clean = img.convert("RGBA") if img.mode in ("RGBA", "LA", "P") else img.convert("RGB")
        clean.save(out, "PNG", optimize=True)
        media = PNG
    if graphic and out.tell() > MAX_PNG_BYTES:
        # Few colours but noisy (dithering, gradients): PNG would be several MB, too big
        # to forward with a feedback note or hand to a model. JPEG keeps it readable.
        out = io.BytesIO()
        graphic = False
    if not graphic:
        _flat(img).save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        media = JPEG
    return out.getvalue(), media, img.width, img.height


def _png(pil_image) -> bytes:
    pil_image.thumbnail((RENDER_SIDE, RENDER_SIDE))
    out = io.BytesIO()
    _flat(pil_image).save(out, "PNG", optimize=True)
    return out.getvalue()


def _render_page(page):
    """Render so the longest side is about RENDER_SIDE px, whatever the page's size in points."""
    w, h = page.get_size()
    side = max(w, h)
    if not (w > 0 and h > 0) or side > MAX_PAGE_PT or math.isnan(side):
        raise MediaError("pdf_page_too_large", "This PDF has a page size we can't render.")
    return page.render(scale=min(RENDER_SIDE / side, 8.0)).to_pil()


def read_pdf(content: bytes, render: bool = True) -> tuple[int, str, list[bytes]]:
    """(pages, extracted text, rendered page PNGs for scans)."""
    import pypdfium2
    from pypdf import PdfReader

    logging.getLogger("pypdf").setLevel(logging.ERROR)
    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        raise MediaError("pdf_encrypted", "This PDF is password-protected.")
    n = len(reader.pages)
    if n > MAX_PDF_PAGES:
        raise MediaError("pdf_too_long", f"This PDF has too many pages (limit {MAX_PDF_PAGES}).")
    text = "\n".join((p.extract_text() or "") for p in reader.pages[:MAX_PDF_PAGES_READ]).strip()
    text = re.sub(r"[ \t]+\n", "\n", text)
    images: list[bytes] = []
    if render and len(text) < SCANNED_BELOW_CHARS:
        try:
            pdf = pypdfium2.PdfDocument(content)
            for i in range(min(len(pdf), MAX_PAGES_RENDERED)):
                images.append(_png(_render_page(pdf[i])))
        except pypdfium2.PdfiumError:
            if not text:
                raise
            images = []  # a short text layer is still something to read
    return n, text[:MAX_TEXT_CHARS], images


def media_dir() -> Path:
    p = db.data_dir() / "media"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _clean_name(filename: str) -> str:
    name = Path((filename or "").replace("\\", "/")).name.strip()
    return re.sub(r"[\x00-\x1f]", "", name)[:200] or "file"


@dataclass
class Processed:
    media: str
    ext: str
    data: bytes
    width: int | None
    height: int | None
    n_pages: int
    text: str
    pages: list[bytes]


def validate(content: bytes, purpose: str) -> str:
    """Cheap checks on the raw bytes; returns the sniffed media type."""
    if not content:
        raise MediaError("empty_file", "The file is empty.")
    if len(content) > MAX_BYTES:
        raise MediaError("too_large", f"Choose a file up to {MAX_BYTES // (1024 * 1024)} MB.", 413)
    media = sniff(content)
    allowed = IMAGES + ((PDF,) if purpose == "chat" else ())
    if media not in allowed:
        raise MediaError(
            "unsupported_type",
            "Choose a PNG, JPEG, WebP or HEIC image" + (" or a PDF." if purpose == "chat" else "."),
        )
    return media


def decode(content: bytes, media: str) -> Processed:
    """The heavy part (runs in the worker process): re-encode an image or read a PDF."""
    if media == PDF:
        try:
            n_pages, text, page_pngs = read_pdf(content)
        except MediaError:
            raise
        except Exception as e:  # corrupt PDFs
            raise MediaError("unreadable", "This PDF could not be read.") from e
        return Processed(PDF, "pdf", content, None, None, n_pages, text, page_pngs)
    try:
        data, media, width, height = compress(content)
    except MediaError:
        raise
    except Exception as e:  # corrupt or truncated images
        raise MediaError("unreadable", "This image could not be read.") from e
    return Processed(media, "jpg" if media == JPEG else "png", data, width, height, 1, "", [])


def _memory_limit():
    """The child's pre-exec hook. The limit is read here, in the parent: the hook itself runs
    between fork and exec, where it must not touch settings (locks, caches, env parsing)."""
    limit = settings().media_worker_mem_mb * 1024 * 1024

    def preexec() -> None:  # pragma: no cover - runs in the child
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))

    return preexec


def process(content: bytes, purpose: str) -> Processed:
    """validate + decode in a child process with a memory limit and a timeout, so a hostile
    file can fail this upload but not take the server down. Blocking: call it off the event loop."""
    media = validate(content, purpose)
    try:
        # The decoder handles untrusted bytes. Give it only what it needs to run:
        # inheriting the app environment would hand a decoder bug the Ollama key,
        # the feedback webhook secret and the Garmin token path. Network egress is
        # still shared with the app; a separate container is the next step.
        proc = subprocess.run(
            [sys.executable, "-m", "media.worker"],
            check=False,
            input=content,
            capture_output=True,
            timeout=WORKER_TIMEOUT_S,
            cwd=str(Path(__file__).resolve().parents[1]),
            env={
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
                # Keep the app's temp/cache paths: compose points TMPDIR at the
                # data volume and HOME/XDG_CACHE_HOME at /tmp. Do not silently
                # move decoder temp files into the tmpfs.
                "HOME": os.environ.get("HOME", "/tmp"),
                "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
                "XDG_CACHE_HOME": os.environ.get("XDG_CACHE_HOME", "/tmp/.cache"),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONIOENCODING": "utf-8",
                "LANG": "C.UTF-8",
            },
            preexec_fn=_memory_limit(),
        )
    except subprocess.TimeoutExpired as e:
        raise MediaError("too_slow", "This file took too long to process.") from e
    try:
        out = json.loads(proc.stdout)
    except ValueError as e:  # killed (memory limit) or crashed
        raise MediaError("unreadable", "This file could not be processed.") from e
    if "error" in out:
        raise MediaError(out["error"], out["detail"], out.get("status", 422))
    b64 = base64.b64decode
    return Processed(
        out["media"],
        out["ext"],
        content if media == PDF else b64(out["data"]),
        out["width"],
        out["height"],
        out["n_pages"],
        out["text"],
        [b64(p) for p in out["pages"]],
    )


def store(
    s: Session, p: Processed, filename: str, *, purpose: str, thread_id: str | None = None
) -> MediaFile:
    mid = uuid.uuid4().hex[:16]
    folder = media_dir()
    file = f"{mid}.{p.ext}"
    (folder / file).write_bytes(p.data)
    pages = []
    for i, png in enumerate(p.pages, start=1):
        name = f"{mid}-p{i}.png"
        (folder / name).write_bytes(png)
        pages.append(name)
    stem = _clean_name(filename).rsplit(".", 1)[0]
    row = MediaFile(
        id=mid,
        file=file,
        purpose=purpose,
        media_type=p.media,
        filename=f"{stem}.{p.ext}",
        size=len(p.data),
        sha256=hashlib.sha256(p.data).hexdigest(),
        width=p.width,
        height=p.height,
        n_pages=p.n_pages,
        text=p.text,
        pages=pages,
        thread_id=thread_id,
    )
    s.add(row)
    s.commit()
    return row


def save(
    s: Session, content: bytes, filename: str, *, purpose: str, thread_id: str | None = None
) -> MediaFile:
    """Validate, re-encode and store one upload; returns the committed row. Blocking."""
    return store(s, process(content, purpose), filename, purpose=purpose, thread_id=thread_id)


async def save_async(
    s: Session, content: bytes, filename: str, *, purpose: str, thread_id: str | None = None
) -> MediaFile:
    """`save` for async routes: the decoding runs in a worker process awaited via the thread pool."""
    from starlette.concurrency import run_in_threadpool

    p = await run_in_threadpool(process, content, purpose)
    return store(s, p, filename, purpose=purpose, thread_id=thread_id)


def info(m: MediaFile) -> dict:
    return {
        "id": m.id,
        "file": m.file,
        "url": f"/api/media/{m.id}",
        "purpose": m.purpose,
        "media_type": m.media_type,
        "filename": m.filename,
        "size": m.size,
        "sha256": m.sha256,
        "width": m.width,
        "height": m.height,
        "pages": m.n_pages,
        "has_text": bool(m.text),
        "rendered_pages": len(m.pages or []),
        "created_at": m.created_at.isoformat() + "Z",
    }


def find(s: Session, ident: str) -> MediaFile | None:
    """By id or by stored file name (what entity media lists carry)."""
    from sqlalchemy import select

    if not re.match(r"^[A-Za-z0-9_.-]{1,120}$", ident or ""):
        return None
    row = s.get(MediaFile, ident)
    if row is None:
        row = s.scalars(select(MediaFile).where(MediaFile.file == ident)).first()
    return row


def path_of(name: str) -> Path:
    return media_dir() / Path(name).name


def read_bytes(name: str) -> bytes:
    return path_of(name).read_bytes()
