#!/usr/bin/env python3
"""
生成对话界面的角色头像（像素版，与办公室 3D 场景里的角色一致）：取
`src/office-scene/sprites.generated.ts` 的正视图网格（由 `scripts/voxelize-personas.py`
从 `../人设/体素/` 三视图降采样而来，兜帽旅人来自 `assets/personas/other.png`），
裁出头部，一格一像素输出 PNG，以 data URL 写入 `src/client/office/avatars.generated.ts`。

- 头部：从头顶到脖子（与 3D 角色同一切分：脖子在离脚 57% 高度处）。
- 水平中心：`sprite-character.ts` 里 `FACE_SPEC` 手工标注的两眼外沿中点。
- 空白处保持透明；浏览器端按最近邻放大（`image-rendering: pixelated`），不做平滑。

换图或重跑体素化后：python3 scripts/build-persona-avatars.py（需要 Pillow）。
"""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SPRITES = ROOT / "src" / "office-scene" / "sprites.generated.ts"
CHARACTER = ROOT / "src" / "office-scene" / "sprite-character.ts"
OUT = ROOT / "src" / "client" / "office" / "avatars.generated.ts"
VENDORS = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"]


def load_sprites() -> tuple[str, dict]:
    text = SPRITES.read_text(encoding="utf-8")
    alphabet = re.search(r'SPRITE_ALPHABET = "([^"]+)"', text).group(1)
    body = text[text.index("= {", text.index("export const SPRITES")) + 2 :].rstrip().rstrip(";")
    return alphabet, json.loads(body)


def load_face_spec() -> dict[str, tuple[int, int]]:
    """各家两眼外沿的列（左眼左列、右眼右列）。"""
    text = CHARACTER.read_text(encoding="utf-8")
    spec: dict[str, tuple[int, int]] = {}
    for vendor, left, right in re.findall(
        r"(\w+): \{ L: \[\d+, \d+, (\d+), \d+\], R: \[\d+, \d+, \d+, (\d+)\]", text
    ):
        spec[vendor] = (int(left), int(right))
    return spec


def head_image(alphabet: str, sheet: dict, eyes: tuple[int, int]) -> Image.Image:
    rows: list[str] = sheet["front"]
    height = len(rows)
    width = len(rows[0])
    neck_row = height - 1 - round(height * 0.57)
    top = next(r for r, row in enumerate(rows) if row.strip(".") != "")
    side = neck_row - top + 2
    center = (eyes[0] + eyes[1]) / 2
    left = round(center - side / 2)
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    pixels = image.load()
    for y in range(side):
        row = top + y
        if row >= height:
            break
        for x in range(side):
            col = left + x
            if col < 0 or col >= width:
                continue
            ch = rows[row][col]
            if ch == ".":
                continue
            color = sheet["palette"][alphabet.index(ch)]
            pixels[x, y] = (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16), 255)
    return image


def png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def main() -> None:
    alphabet, sprites = load_sprites()
    faces = load_face_spec()
    urls = {vendor: png(head_image(alphabet, sprites[vendor], faces[vendor])) for vendor in VENDORS}
    lines = [
        "/* 由 scripts/build-persona-avatars.py 生成，勿手改。",
        " * 各厂商角色头像（像素版：办公室体素角色正视图的头部，一格一像素 PNG data URL，",
        " * 显示时按最近邻放大）。 */",
        "",
        'import type { Vendor } from "../../office/types.ts";',
        "",
        "export const PERSONA_AVATARS: Readonly<Record<Vendor, string>> = {",
    ]
    for vendor in VENDORS:
        lines.append(f'  {vendor}: "{urls[vendor]}",')
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    total = sum(len(u) for u in urls.values())
    print(f"已写入 {OUT.relative_to(ROOT)}（{total // 1024} KB）")


if __name__ == "__main__":
    main()
