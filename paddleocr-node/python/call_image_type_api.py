#!/usr/bin/env python3
"""Call the local image-type API.

Usage:
  python python/call_image_type_api.py "D:\\path\\image.jpg"
  python python/call_image_type_api.py "D:\\path\\image.jpg" --url http://localhost:3100/api/image-type
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import uuid
from pathlib import Path
from urllib import request


def classify_image(image_path: str, url: str) -> dict:
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"图片不存在: {path}")

    boundary = f"----image-type-{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = head + path.read_bytes() + tail

    req = request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="调用本地快速识图 API")
    parser.add_argument("image", help="图片路径")
    parser.add_argument("--url", default="http://localhost:3100/api/image-type", help="API 地址")
    args = parser.parse_args()

    result = classify_image(args.image, args.url)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
