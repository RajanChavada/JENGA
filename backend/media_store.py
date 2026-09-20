"""Local-disk storage for uploaded evidence video.

ponytail: single-machine local disk, no cleanup job. Fine for the demo/dev
target this backend runs against today; swap for object storage (S3/GCS)
before any real deployment — the same ceiling `lib/media-store.ts` on the
old video-interpretation-pipeline branch carried, restated here because this
is a fresh implementation against a different backend, not a port of that
file.
"""

from __future__ import annotations

import uuid
from pathlib import Path

MEDIA_DIR = Path(__file__).resolve().parent / ".data" / "media"

_EXT_BY_MIME = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}


def save(data: bytes, mime_type: str) -> tuple[str, Path]:
    """Write `data` under a fresh id. Returns (id, absolute path)."""
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    media_id = uuid.uuid4().hex
    ext = _EXT_BY_MIME.get(mime_type, "bin")
    path = MEDIA_DIR / f"{media_id}.{ext}"
    path.write_bytes(data)
    return media_id, path


def path_for(media_id: str) -> Path | None:
    """The stored file for `media_id`, or None if it doesn't exist.

    Globs on the id rather than requiring the caller to also know the
    extension — `save`'s caller gets the extension back via the path it
    returns, but `GET /api/media/{id}` only has the id from the URL.
    """
    matches = list(MEDIA_DIR.glob(f"{media_id}.*"))
    return matches[0] if matches else None
