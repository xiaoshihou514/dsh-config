#!/usr/bin/env python3
"""
生成对话界面的角色头像：从 `../人设/` 的立绘裁出头部，缩成 96×96 的 WebP，
以 data URL 内联到 `src/client/office/avatars.generated.ts`（不额外请求图片）。

- 八家立绘按 BOX 手工标注的头部框裁剪（中心与边长都是相对原图宽度的比例）。
- 未知模型（兜帽旅人）用 `assets/personas/other.png` 像素三视图的正视图头部，
  按最近邻缩放保持像素风。

换图后重跑：python3 scripts/build-persona-avatars.py（需要 Pillow）。
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PERSONAS = ROOT.parent / "人设"
OUT = ROOT / "src" / "client" / "office" / "avatars.generated.ts"
SIZE = 96

# 厂商 → (文件名, 中心 x, 中心 y, 边长)；均为相对原图宽度的比例。
BOX: dict[str, tuple[str, float, float, float]] = {
    "deepseek": ("deepseek.png", 0.44, 0.24, 0.36),
    "glm": ("glm.png", 0.45, 0.235, 0.36),
    "kimi": ("kimi.png", 0.48, 0.225, 0.34),
    "claude": ("claude.jpeg", 0.465, 0.19, 0.30),
    "gemini": ("gemini.jpeg", 0.535, 0.235, 0.34),
    "gpt": ("gpt.jpeg", 0.475, 0.20, 0.32),
    "grok": ("grok.jpeg", 0.565, 0.30, 0.32),
    "qwen": ("qwen.jpeg", 0.545, 0.215, 0.32),
}

# 兜帽旅人：正视图头部的像素框（左、上、边长），原图坐标。
OTHER = ("other.png", 134, 48, 420)


def webp(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=82, method=6)
    return "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def crop_portrait(name: str, cx: float, cy: float, side: float) -> Image.Image:
    image = Image.open(PERSONAS / name).convert("RGB")
    width = image.size[0]
    x0 = round((cx - side / 2) * width)
    y0 = round((cy - side / 2) * width)
    edge = round(side * width)
    return image.crop((x0, y0, x0 + edge, y0 + edge)).resize((SIZE, SIZE), Image.LANCZOS)


def crop_other() -> Image.Image:
    name, x0, y0, edge = OTHER
    image = Image.open(ROOT / "assets" / "personas" / name).convert("RGB")
    return image.crop((x0, y0, x0 + edge, y0 + edge)).resize((SIZE, SIZE), Image.NEAREST)


def main() -> None:
    urls = {vendor: webp(crop_portrait(*spec)) for vendor, spec in BOX.items()}
    urls["other"] = webp(crop_other())
    lines = [
        "/* 由 scripts/build-persona-avatars.py 生成，勿手改。",
        " * 各厂商角色头像（96×96 WebP data URL），对话界面头像与办公室共用。 */",
        "",
        'import type { Vendor } from "../../office/types.ts";',
        "",
        "export const PERSONA_AVATARS: Readonly<Record<Vendor, string>> = {",
    ]
    for vendor in ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"]:
        lines.append(f'  {vendor}: "{urls[vendor]}",')
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    total = sum(len(u) for u in urls.values())
    print(f"已写入 {OUT.relative_to(ROOT)}（{total // 1024} KB）")


if __name__ == "__main__":
    main()
