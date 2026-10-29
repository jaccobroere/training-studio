"""Worker process for media decoding (see media/store.py `process`): bytes on stdin, one JSON
document on stdout. Runs under an address-space limit set by the parent, so a decompression
bomb ends here, not in the server."""

from __future__ import annotations

import base64
import json
import sys

from media import store


def main() -> None:
    content = sys.stdin.buffer.read()
    try:
        p = store.decode(content, store.sniff(content))
    except store.MediaError as e:
        out = {"error": e.code, "detail": e.detail, "status": e.status}
    else:
        b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
        out = {"media": p.media, "ext": p.ext, "width": p.width, "height": p.height, "n_pages": p.n_pages,
               "text": p.text, "data": "" if p.media == store.PDF else b64(p.data),
               "pages": [b64(x) for x in p.pages]}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
