#!/usr/bin/env python3
"""
PaddleOCR Node.js 服务端 — 通过 stdin/stdout JSON-line 协议与 Node.js 通信。
支持识别图片和 PDF 中的文字。

协议：
  Node → Python: {"id": N, "type": "ocr", "input": "/path/to/file", "options": {...}}
  Python → Node: {"id": N, "type": "result", "success": true, "data": {...}}
  
  启动时 Python → Node: {"type": "ready", "version": "...", "pid": ...}
  
  心跳: {"id": N, "type": "ping"} → {"id": N, "type": "result", "success": true, "data": "pong"}
  退出: {"id": N, "type": "exit"}
"""

from __future__ import annotations

import json
import sys
import os
import traceback
import base64
import tempfile
import uuid
import mimetypes
from collections.abc import Mapping
from pathlib import Path

# ---------------------------------------------------------------------------
# PDF 支持：优先用 pdfplumber 解析机器生成 PDF；扫描 PDF 回退为图片 OCR
# ---------------------------------------------------------------------------
try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    pdfplumber = None
    HAS_PDFPLUMBER = False

try:
    import fitz  # PyMuPDF
    HAS_FITZ = True
except ImportError:
    fitz = None
    HAS_FITZ = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# ---------------------------------------------------------------------------
# PaddleOCR
# ---------------------------------------------------------------------------
try:
    from paddleocr import PaddleOCR
    HAS_PADDLE = True
except ImportError:
    PaddleOCR = None
    HAS_PADDLE = False


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def pdf_to_images(pdf_path: str, dpi: int = 200) -> list[str]:
    """
    将 PDF 的每一页渲染为 PNG 图片，返回临时文件路径列表。
    调用方负责清理。
    """
    if not HAS_FITZ:
        raise RuntimeError(
            "扫描 PDF 回退 OCR 需要 PyMuPDF 渲染页面。请执行: pip install PyMuPDF"
        )

    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return []
    image_paths = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        zoom = dpi / 72  # fitz 默认 72 DPI
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        # 写为临时 PNG
        tmp = tempfile.NamedTemporaryFile(
            suffix=".png", prefix=f"ocr_page_{page_num + 1}_", delete=False
        )
        tmp.close()  # 释放句柄，否则 Windows 下后续 os.unlink 会 Permission denied
        pix.save(tmp.name)
        image_paths.append(tmp.name)

    doc.close()
    return image_paths


def file_to_data_url(file_path: str, mime_type: str | None = None) -> str:
    mime = mime_type or mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def pdf_page_previews(pdf_path: str, dpi: int = 120) -> list[str]:
    """
    将 PDF 每页渲染为轻量 PNG data URL，供前端按当前页预览。
    pdfplumber 不提供渲染能力，因此这里复用 PyMuPDF。
    """
    if not HAS_FITZ:
        return []

    previews: list[str] = []
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return []

    try:
        zoom = dpi / 72
        mat = fitz.Matrix(zoom, zoom)
        for page in doc:
            try:
                pix = page.get_pixmap(matrix=mat, alpha=False)
                encoded = base64.b64encode(pix.tobytes("png")).decode("ascii")
                previews.append(f"data:image/png;base64,{encoded}")
            except Exception:
                previews.append("")
    finally:
        doc.close()
    return previews


def normalize_ocr_result(result_list: list) -> list[dict]:
    """
    将 PaddleOCR.predict() 返回的结果统一为标准列表。
    PaddleOCR 2.x 返回结构：[ [ [[x1,y1],...], (text, score) ], ... ]
    """
    boxes = []
    if not result_list:
        return boxes

    for item in result_list:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            poly, (text, score) = item
            # poly 可以是 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] 或 8-元素列表
            if isinstance(poly, list) and len(poly) == 4:
                coords = poly
            elif isinstance(poly, list) and len(poly) == 8:
                coords = [
                    [poly[0], poly[1]],
                    [poly[2], poly[3]],
                    [poly[4], poly[5]],
                    [poly[6], poly[7]],
                ]
            else:
                coords = poly  # 保底
            boxes.append({
                "box": coords,
                "text": text,
                "score": round(float(score), 4),
            })
    return boxes


def cleanup_temp_files(paths: list[str]):
    """安全删除临时文件"""
    for p in paths:
        try:
            if os.path.exists(p):
                os.unlink(p)
        except Exception:
            pass


def box_bounds(box: list) -> tuple[float, float, float, float]:
    """返回文本框的 x1, y1, x2, y2。"""
    points = box
    if hasattr(points, "tolist"):
        points = points.tolist()
    if not isinstance(points, list) or not points:
        return 0.0, 0.0, 0.0, 0.0
    try:
        xs = [float(p[0]) for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
        ys = [float(p[1]) for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
    except Exception:
        return 0.0, 0.0, 0.0, 0.0
    if not xs or not ys:
        return 0.0, 0.0, 0.0, 0.0
    return min(xs), min(ys), max(xs), max(ys)


def median(values: list[float], default: float = 0.0) -> float:
    clean = sorted(v for v in values if v > 0)
    if not clean:
        return default
    mid = len(clean) // 2
    if len(clean) % 2:
        return clean[mid]
    return (clean[mid - 1] + clean[mid]) / 2


def group_boxes_into_rows(boxes: list[dict]) -> list[dict]:
    """按 y 坐标把 OCR 文本框合并成阅读行。"""
    metrics = []
    for box in boxes:
        text = str(box.get("text", "")).strip()
        if not text:
            continue
        x1, y1, x2, y2 = box_bounds(box.get("box", []))
        height = max(1.0, y2 - y1)
        metrics.append({
            "box": box,
            "text": text,
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "xc": (x1 + x2) / 2,
            "yc": (y1 + y2) / 2,
            "height": height,
            "width": max(1.0, x2 - x1),
        })

    if not metrics:
        return []

    row_threshold = max(8.0, median([m["height"] for m in metrics], 12.0) * 0.75)
    rows: list[dict] = []
    for item in sorted(metrics, key=lambda m: (m["yc"], m["x1"])):
        target = None
        for row in rows:
            if abs(row["yc"] - item["yc"]) <= row_threshold:
                target = row
                break
        if target is None:
            rows.append({"yc": item["yc"], "items": [item]})
        else:
            target["items"].append(item)
            target["yc"] = sum(i["yc"] for i in target["items"]) / len(target["items"])

    for row in rows:
        row["items"].sort(key=lambda m: m["x1"])
        row["text"] = " ".join(i["text"] for i in row["items"])
        row["x1"] = min(i["x1"] for i in row["items"])
        row["y1"] = min(i["y1"] for i in row["items"])
        row["x2"] = max(i["x2"] for i in row["items"])
        row["y2"] = max(i["y2"] for i in row["items"])

    rows.sort(key=lambda r: r["yc"])
    return rows


def cluster_columns(rows: list[dict]) -> list[float]:
    """从多列行中估计表格列中心。"""
    candidate_items = [
        item
        for row in rows
        if len(row["items"]) >= 2
        for item in row["items"]
    ]
    if not candidate_items:
        return []

    widths = [i["width"] for i in candidate_items]
    heights = [i["height"] for i in candidate_items]
    threshold = max(24.0, min(median(widths, 60.0) * 0.55, median(heights, 14.0) * 4.5))

    clusters: list[list[float]] = []
    for x in sorted(i["xc"] for i in candidate_items):
        if not clusters or abs((sum(clusters[-1]) / len(clusters[-1])) - x) > threshold:
            clusters.append([x])
        else:
            clusters[-1].append(x)

    anchors = [sum(c) / len(c) for c in clusters]
    return anchors if len(anchors) >= 2 else []


def row_to_cells(row: dict, anchors: list[float]) -> list[str]:
    """把一行文本按列中心映射到单元格。"""
    if not anchors:
        return []
    boundaries = [-float("inf")]
    for i in range(len(anchors) - 1):
        boundaries.append((anchors[i] + anchors[i + 1]) / 2)
    boundaries.append(float("inf"))

    cells = [[] for _ in anchors]
    for item in row["items"]:
        col = 0
        for idx in range(len(anchors)):
            if boundaries[idx] <= item["xc"] < boundaries[idx + 1]:
                col = idx
                break
        cells[col].append(item)

    values = []
    for group in cells:
        group.sort(key=lambda m: m["x1"])
        values.append(" ".join(i["text"] for i in group).strip())
    return values


def table_to_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    col_count = max(len(r) for r in rows)
    normalized = [(r + [""] * col_count)[:col_count] for r in rows]

    def clean(value: str) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ").strip()

    lines = []
    lines.append("| " + " | ".join(clean(c) for c in normalized[0]) + " |")
    lines.append("| " + " | ".join("---" for _ in range(col_count)) + " |")
    for row in normalized[1:]:
        lines.append("| " + " | ".join(clean(c) for c in row) + " |")
    return "\n".join(lines)


def normalize_table_rows(rows: list) -> list[list[str]]:
    """把 pdfplumber/OCR 表格单元格标准化为字符串二维数组。"""
    normalized: list[list[str]] = []
    for row in rows or []:
        if row is None:
            continue
        cells = []
        for cell in row:
            value = "" if cell is None else str(cell)
            cells.append(value.strip())
        if any(cells):
            normalized.append(cells)

    if not normalized:
        return []

    col_count = max(len(row) for row in normalized)
    return [(row + [""] * col_count)[:col_count] for row in normalized]


def table_result_from_rows(rows: list[list[str]], bbox: list[float] | tuple | None = None) -> dict:
    """生成统一的 OcrTableResult 字典。"""
    normalized = normalize_table_rows(rows)
    col_count = max((len(row) for row in normalized), default=0)
    filled = sum(1 for row in normalized for cell in row if cell)
    total = max(1, len(normalized) * max(1, col_count))
    safe_bbox = [round(float(v), 2) for v in bbox] if bbox else [0, 0, 0, 0]
    return {
        "rows": normalized,
        "rowCount": len(normalized),
        "columnCount": col_count,
        "bbox": safe_bbox,
        "confidence": round(filled / total, 4),
        "markdown": table_to_markdown(normalized),
    }


def pdf_word_to_box(word: dict) -> dict:
    """把 pdfplumber 的 word 坐标转成当前前端可复用的四点文本框。"""
    x0 = float(word.get("x0", 0))
    x1 = float(word.get("x1", x0))
    top = float(word.get("top", word.get("y0", 0)))
    bottom = float(word.get("bottom", word.get("y1", top)))
    return {
        "box": [[x0, top], [x1, top], [x1, bottom], [x0, bottom]],
        "text": str(word.get("text", "")).strip(),
        "score": 1.0,
    }


def extract_pdfplumber_tables(page) -> list[dict]:
    """使用 pdfplumber 的表格检测结果生成 OcrTableResult。"""
    tables: list[dict] = []
    try:
        table_objects = page.find_tables() or []
    except Exception:
        table_objects = []

    for table_obj in table_objects:
        try:
            rows = table_obj.extract() or []
            table = table_result_from_rows(rows, getattr(table_obj, "bbox", None))
            if table["rows"]:
                tables.append(table)
        except Exception:
            continue

    # 部分 PDF 线框不明显时 find_tables 可能失败；extract_tables 可作为文本策略兜底。
    if not tables:
        try:
            for rows in page.extract_tables() or []:
                table = table_result_from_rows(rows)
                if table["rows"]:
                    tables.append(table)
        except Exception:
            pass

    return tables


def extract_pdf_layout_text(page) -> str:
    """使用 pdfplumber 布局模式提取文本，尽量保留 PDF 原始空格、缩进和列位置。"""
    try:
        text = page.extract_text(layout=True, x_density=7.25, y_density=13)
    except TypeError:
        text = page.extract_text(layout=True)
    except Exception:
        text = None

    if text and text.strip():
        return text.rstrip()

    try:
        return page.extract_text() or ""
    except Exception:
        return ""


def parse_pdf_with_pdfplumber(pdf_path: str) -> dict:
    """
    使用 pdfplumber 解析机器生成 PDF。
    pdfplumber 不做 OCR；扫描件没有可提取文本时由调用方回退到图片 OCR。
    """
    if not HAS_PDFPLUMBER:
        raise RuntimeError(
            "需要 pdfplumber 来解析 PDF。请执行: pip install pdfplumber"
        )

    pages = []
    total_text = []
    previews = pdf_page_previews(pdf_path)

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            page_text = extract_pdf_layout_text(page)
            try:
                words = page.extract_words() or []
            except Exception:
                words = []

            boxes = [pdf_word_to_box(word) for word in words if str(word.get("text", "")).strip()]
            tables = extract_pdfplumber_tables(page)

            pages.append({
                "page": page.page_number,
                "boxes": boxes,
                "tables": tables,
                "previewImage": previews[page_idx] if page_idx < len(previews) else "",
                "fullText": page_text,
            })
            total_text.append(page_text)

    return {
        "source": pdf_path,
        "totalPages": len(pages),
        "pages": pages,
        "fullText": "\n".join(total_text),
    }


def pdfplumber_result_has_content(result: dict) -> bool:
    for page in result.get("pages", []):
        if page.get("fullText", "").strip():
            return True
        if page.get("boxes"):
            return True
        if page.get("tables"):
            return True
    return False


def _pdf_page_has_content(page_dict: dict) -> bool:
    """判断 pdfplumber 提取的单个页面是否有可用文字/框/表格。"""
    if page_dict.get("fullText", "").strip():
        return True
    if page_dict.get("boxes"):
        return True
    if page_dict.get("tables"):
        return True
    return False


def render_single_pdf_page(pdf_path: str, page_num: int, dpi: int = 200) -> str:
    """
    渲染 PDF 指定页码（从 1 开始）为 PNG 临时文件。
    调用方负责清理返回的文件路径。
    """
    if not HAS_FITZ:
        raise RuntimeError(
            "需要 PyMuPDF 来渲染 PDF 页面。请执行: pip install PyMuPDF"
        )
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_num - 1]
        zoom = dpi / 72
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        tmp = tempfile.NamedTemporaryFile(
            suffix=".png", prefix=f"ocr_page_{page_num}_", delete=False
        )
        tmp.close()
        pix.save(tmp.name)
        return tmp.name
    finally:
        doc.close()


def extract_tables_from_boxes(boxes: list[dict]) -> list[dict]:
    """
    基于 OCR 坐标近似重建表格。
    适合普通扫描件中的横向/纵向对齐表格；复杂合并单元格仍以 OCR 文本为准。
    """
    rows = group_boxes_into_rows(boxes)
    if len(rows) < 2:
        return []

    anchors = cluster_columns(rows)
    if len(anchors) < 2:
        return []

    table_rows = []
    for row in rows:
        cells = row_to_cells(row, anchors)
        non_empty = sum(1 for c in cells if c)
        table_rows.append({
            "row": row,
            "cells": cells,
            "nonEmpty": non_empty,
        })

    tables: list[dict] = []
    current: list[dict] = []

    for row in table_rows:
        is_table_like = row["nonEmpty"] >= 2
        if is_table_like:
            current.append(row)
            continue
        if len(current) >= 2:
            tables.append(build_table_result(current, len(anchors)))
        current = []

    if len(current) >= 2:
        tables.append(build_table_result(current, len(anchors)))

    return [t for t in tables if len(t["rows"]) >= 2]


def build_table_result(segment: list[dict], column_count: int) -> dict:
    rows = [(r["cells"] + [""] * column_count)[:column_count] for r in segment]
    source_rows = [r["row"] for r in segment]
    x1 = min(r["x1"] for r in source_rows)
    y1 = min(r["y1"] for r in source_rows)
    x2 = max(r["x2"] for r in source_rows)
    y2 = max(r["y2"] for r in source_rows)
    filled = sum(1 for row in rows for cell in row if cell)
    total = max(1, len(rows) * column_count)
    return {
        "rows": rows,
        "rowCount": len(rows),
        "columnCount": column_count,
        "bbox": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
        "confidence": round(filled / total, 4),
        "markdown": table_to_markdown(rows),
    }


# ---------------------------------------------------------------------------
# OCR 引擎类
# ---------------------------------------------------------------------------

class OcrEngine:
    """单例 OCR 引擎，复用 PaddleOCR 实例"""

    def __init__(self, options: dict):
        self._options = options
        self._ocr: PaddleOCR | None = None
        self._current_options: dict = {}
        self._init_engine()

    def _init_engine(self):
        if not HAS_PADDLE:
            raise RuntimeError(
                "PaddleOCR 未安装。请执行: pip install paddleocr"
            )

        kwargs = {
            "lang": self._options.get("lang", "ch"),
            "ocr_version": self._options.get("ocrVersion", "PP-OCRv6"),
        }

        # PaddleOCR 3.7 / PP-OCRv6 pipeline options
        option_map = {
            "textDetectionModelName": "text_detection_model_name",
            "textRecognitionModelName": "text_recognition_model_name",
            "useDocOrientationClassify": "use_doc_orientation_classify",
            "useDocUnwarping": "use_doc_unwarping",
            "useTextlineOrientation": "use_textline_orientation",
            "engine": "engine",
        }
        for opt_key, kw_key in option_map.items():
            if opt_key in self._options and self._options[opt_key] is not None:
                kwargs[kw_key] = self._options[opt_key]

        device = self._options.get("device", "auto")
        if device and device != "auto":
            kwargs["device"] = device

        # 模型路径覆盖
        for key in ("text_detection_model_dir", "text_recognition_model_dir"):
            if key in self._options:
                kwargs[key] = self._options[key]

        # 阈值
        for opt_key, kw_key in [
            ("textDetThresh", "text_det_thresh"),
            ("textDetBoxThresh", "text_det_box_thresh"),
            ("textRecScoreThresh", "text_rec_score_thresh"),
        ]:
            if opt_key in self._options and self._options[opt_key] is not None:
                kwargs[kw_key] = float(self._options[opt_key])

        # return_word_box
        if "returnWordBox" in self._options:
            kwargs["return_word_box"] = self._options["returnWordBox"]

        # 输入形状
        if "textDetInputShape" in self._options:
            kwargs["text_det_input_shape"] = self._options["textDetInputShape"]
        if "textRecInputShape" in self._options:
            kwargs["text_rec_input_shape"] = self._options["textRecInputShape"]

        # 额外参数
        extra = self._options.get("extraArgs", {})
        kwargs.update(extra)

        try:
            self._ocr = PaddleOCR(**kwargs)
        except RuntimeError as e:
            msg = str(e)
            if "paddlepaddle" in msg.lower() or "paddle_static" in msg:
                raise RuntimeError(
                    "PaddlePaddle 深度学习框架未安装。\n\n"
                    "请选择以下方式之一安装:\n\n"
                    "  📦 方式一 (推荐 — Conda):\n"
                    "     conda install -c conda-forge paddlepaddle\n\n"
                    "  🐍 方式二 (pip):\n"
                    f"     {sys.executable} -m pip install paddlepaddle\n\n"
                    "  💡 GPU 用户请安装:\n"
                    f"     {sys.executable} -m pip install paddlepaddle-gpu\n\n"
                    "安装后重启此服务即可。"
                )
            raise

    def recognize(self, input_path: str, options: dict | None = None) -> dict:
        """
        识别图片或 PDF 文件。
        PDF 逐页处理：优先文字解析（pdfplumber），无文字时回退 OCR，不重复解析。
        options 可包含: enableTable (bool)
        """
        path = Path(input_path)
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {input_path}")

        suffix = path.suffix.lower()
        is_pdf = suffix == ".pdf"
        self._current_options = options or {}

        if not is_pdf:
            # 图片 → 直接 OCR
            return self._ocr_image_file(str(path))

        # PDF → 逐页优先文字解析，无文字时回退 OCR
        return self._recognize_pdf(str(path))

    def _ocr_image_file(self, file_path: str) -> dict:
        """对单张图片执行 OCR，返回 OcrResult 结构。"""
        result = self._ocr.predict(file_path)
        boxes = self._extract_boxes(result)
        page_rows = group_boxes_into_rows(boxes)
        page_text = "\n".join(r["text"] for r in page_rows if r["text"].strip())
        enable_table = self._current_options.get("enableTable", True)
        tables = extract_tables_from_boxes(boxes) if enable_table else []
        pages = [{
            "page": 1,
            "boxes": boxes,
            "tables": tables,
            "previewImage": "",
            "fullText": page_text,
        }]
        return {
            "source": file_path,
            "totalPages": 1,
            "pages": pages,
            "fullText": page_text,
        }

    def _recognize_pdf(self, pdf_path: str) -> dict:
        """
        PDF 逐页处理：优先用 pdfplumber 文字解析，
        无文字内容的页码回退到渲染为图片后 OCR。
        同一页不会同时走两条路径，不重复。
        """
        pdf_result = parse_pdf_with_pdfplumber(pdf_path)
        pdf_pages = pdf_result.get("pages", [])

        enable_table = self._current_options.get("enableTable", True)

        # 如果关闭了表格，剥离 pdfplumber 页中的表格
        if not enable_table:
            for p in pdf_pages:
                p["tables"] = []

        # 如果每页都有内容，直接返回（纯文字 PDF，无需 OCR）
        if all(_pdf_page_has_content(p) for p in pdf_pages):
            return pdf_result

        dpi = self._options.get("pdfDpi", 200)
        temp_images: list[str] = []
        result_pages: list[dict] = []
        total_text: list[str] = []

        try:
            for page_dict in pdf_pages:
                if _pdf_page_has_content(page_dict):
                    # 文字提取成功 → 保留 pdfplumber 结果
                    result_pages.append(page_dict)
                    total_text.append(page_dict.get("fullText", ""))
                else:
                    # 文字提取失败 → 只对该页单独 OCR，不重复解析
                    page_num = page_dict.get("page", 1)
                    img_file = render_single_pdf_page(pdf_path, page_num, dpi)
                    temp_images.append(img_file)

                    ocr_result = self._ocr.predict(img_file)
                    boxes = self._extract_boxes(ocr_result)
                    page_rows = group_boxes_into_rows(boxes)
                    page_text = "\n".join(r["text"] for r in page_rows if r["text"].strip())
                    tables = extract_tables_from_boxes(boxes) if enable_table else []

                    result_pages.append({
                        "page": page_num,
                        "boxes": boxes,
                        "tables": tables,
                        "previewImage": file_to_data_url(img_file, "image/png"),
                        "fullText": page_text,
                    })
                    total_text.append(page_text)

            return {
                "source": pdf_path,
                "totalPages": len(result_pages),
                "pages": result_pages,
                "fullText": "\n".join(total_text),
            }

        finally:
            if temp_images:
                cleanup_temp_files(temp_images)

    def _extract_boxes(self, result) -> list[dict]:
        """
        从 PaddleOCR.predict 的返回值中提取文本框。
        PaddleOCR v3.x 返回的 result 是 list[XXXResult]，
        每个 XXXResult 有结构化的属性。
        """
        boxes = []

        if not result:
            return boxes

        # PaddleOCR 3.7 返回 Result 对象。结构化数据位于
        # result.json["res"]，同时兼容 Mapping 风格 Result 和旧版列表。
        for page_result in result:
            try:
                raw = self._result_mapping(page_result)
                if raw and "rec_texts" in raw:
                    boxes.extend(self._boxes_from_v3_result(raw))
                # 兼容早期 PaddleX 对象式结果
                elif hasattr(page_result, "ocr_result"):
                    ocr_res = page_result.ocr_result
                    if ocr_res is None:
                        continue
                    for item in ocr_res:
                        poly = item.poly  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
                        txt = item.text
                        score = item.score
                        boxes.append({
                            "box": poly,
                            "text": txt,
                            "score": round(float(score), 4),
                        })
                elif hasattr(page_result, "bbox"):
                    for item in page_result.bbox:
                        boxes.append({
                            "box": item.get("poly", []),
                            "text": item.get("text", ""),
                            "score": round(float(item.get("score", 0)), 4),
                        })
                else:
                    # 兜底：尝试 dict 或 list 格式
                    raw = page_result if isinstance(page_result, (Mapping, list, tuple)) else []

                    if isinstance(raw, (list, tuple)):
                        boxes.extend(normalize_ocr_result(raw))
                    elif isinstance(raw, Mapping):
                        if "boxes" in raw:
                            boxes.extend(raw["boxes"])

            except Exception:
                # 如果某个对象解析失败，尝试兜底解析
                try:
                    boxes.extend(normalize_ocr_result([page_result]))
                except Exception:
                    continue

        return boxes

    @staticmethod
    def _result_mapping(page_result) -> Mapping | None:
        """提取 PaddleOCR 3.7 Result 的实际 ``res`` 字典。"""
        candidates = [page_result]
        for attr in ("json", "res"):
            try:
                value = getattr(page_result, attr, None)
                if callable(value):
                    value = value()
                if value is not None:
                    candidates.append(value)
            except Exception:
                pass

        for candidate in candidates:
            if not isinstance(candidate, Mapping):
                continue
            nested = candidate.get("res")
            if isinstance(nested, Mapping):
                return nested
            if "rec_texts" in candidate:
                return candidate
        return None

    @staticmethod
    def _boxes_from_v3_result(raw: Mapping) -> list[dict]:
        texts = raw.get("rec_texts")
        scores = raw.get("rec_scores")
        polys = raw.get("rec_polys")
        rects = raw.get("rec_boxes")
        texts = [] if texts is None else texts
        scores = [] if scores is None else scores
        polys = [] if polys is None else polys
        rects = [] if rects is None else rects
        boxes = []

        for index, value in enumerate(texts):
            text = str(value).strip()
            if not text:
                continue

            poly = polys[index] if index < len(polys) else []
            if hasattr(poly, "tolist"):
                poly = poly.tolist()
            if not poly and index < len(rects):
                rect = rects[index]
                if hasattr(rect, "tolist"):
                    rect = rect.tolist()
                if isinstance(rect, (list, tuple)) and len(rect) >= 4:
                    x1, y1, x2, y2 = rect[:4]
                    poly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]

            score = scores[index] if index < len(scores) else 0
            boxes.append({
                "box": poly,
                "text": text,
                "score": round(float(score), 4),
            })
        return boxes


# ---------------------------------------------------------------------------
# 服务主循环 — JSON-line 协议
# ---------------------------------------------------------------------------

class OcrServer:
    """通过 stdin/stdout 与 Node.js 通信的 OCR 服务"""

    def __init__(self, options: dict):
        self._engine = OcrEngine(options)
        self._request_id = 0
        self._running = True

    def send(self, msg: dict):
        """向 stdout 发送 JSON 行"""
        line = json.dumps(msg, ensure_ascii=False)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def send_error(self, req_id: int, message: str, traceback_str: str = ""):
        self.send({
            "id": req_id,
            "type": "result",
            "success": False,
            "error": message,
            "traceback": traceback_str,
        })

    def handle_ocr(self, req: dict):
        req_id = req.get("id", 0)
        input_path = req.get("input", "")
        input_type = req.get("inputType", "file")
        options_override = req.get("options", {})

        try:
            # 处理 base64 输入 — 写到临时文件
            if input_type == "base64":
                tmp = tempfile.NamedTemporaryFile(
                    suffix=".png", prefix="ocr_base64_", delete=False
                )
                try:
                    image_data = base64.b64decode(input_path)
                    tmp.write(image_data)
                    tmp.close()
                    result = self._engine.recognize(tmp.name, options_override if options_override else None)
                finally:
                    if os.path.exists(tmp.name):
                        os.unlink(tmp.name)
            else:
                result = self._engine.recognize(input_path, options_override if options_override else None)

            self.send({
                "id": req_id,
                "type": "result",
                "success": True,
                "data": result,
            })

        except FileNotFoundError as e:
            self.send_error(req_id, str(e))
        except Exception as e:
            tb = traceback.format_exc()
            self.send_error(req_id, f"OCR 识别失败: {e}", tb)

    def handle_message(self, msg: dict):
        msg_type = msg.get("type")
        req_id = msg.get("id", 0)

        if msg_type == "ocr":
            self.handle_ocr(msg)
        elif msg_type == "ping":
            self.send({
                "id": req_id,
                "type": "result",
                "success": True,
                "data": "pong",
            })
        elif msg_type == "exit":
            self.send({
                "id": req_id,
                "type": "result",
                "success": True,
                "data": "bye",
            })
            self._running = False
        else:
            self.send_error(req_id, f"未知消息类型: {msg_type}")

    def run(self):
        """读取 stdin 中的 JSON 行并响应"""
        self.send({
            "type": "ready",
            "version": self._get_version(),
            "pid": os.getpid(),
        })

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                self.handle_message(msg)
            except json.JSONDecodeError as e:
                self.send_error(0, f"JSON 解析错误: {e}")
            except Exception as e:
                tb = traceback.format_exc()
                self.send_error(0, f"内部错误: {e}", tb)

            if not self._running:
                break

    @staticmethod
    def _get_version() -> str:
        try:
            from paddleocr import __version__
            return __version__
        except Exception:
            try:
                import paddleocr
                return getattr(paddleocr, "__version__", "unknown")
            except Exception:
                return "unknown"


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    # 从命令行参数读取初始化选项（JSON 字符串）
    init_options = {}
    if len(sys.argv) > 1:
        try:
            init_options = json.loads(sys.argv[1])
        except json.JSONDecodeError:
            pass

    server = OcrServer(init_options)

    try:
        server.run()
    except BrokenPipeError:
        # Node.js 端已关闭连接
        pass
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
