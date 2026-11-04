#!/usr/bin/env python3
"""
把 ../人设/体素/<厂商>.png（正 / 侧 / 背三视图像素画）切成统一颗粒度的网格，
生成 src/office-scene/sprites.generated.ts，供场景生成体素角色。

用法：python3 -I scripts/voxelize-personas.py [参考图目录] [--debug 输出目录]

参考图目录里没有的厂商，回退到 assets/personas/<厂商>.png（未知模型由
scripts/draw-unknown-persona.py 生成）。

- 网格大小统一取 DeepSeek 图的像素块（CELL px），各图只自动对齐相位。
- 背景：从边框向内泛洪近背景色的格子；脚下阴影按「底部浅色」剔除。
- 三视图：面积足够大的块按 x 排序为正、侧、背（粘连时在最稀疏的列切开）；
  远处装饰丢弃，紧贴人物且不撑大外框的小块（发丝）并入。
- 侧视图统一为「左边是角色正面」（按皮肤所在侧自动判断并翻转）。
"""

import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

CELL = 14
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
VENDORS = ["claude", "gpt", "gemini", "glm", "grok", "kimi", "qwen", "deepseek", "other"]


def best_phase(a, axis):
    gray = a.mean(axis=2)
    best = (1e18, 0)
    for o in range(CELL):
        if axis == 1:
            g = gray[:, o:]
            n = g.shape[1] // CELL
            var = g[:, : n * CELL].reshape(g.shape[0], n, CELL).var(axis=2).sum()
        else:
            g = gray[o:, :]
            n = g.shape[0] // CELL
            var = g[: n * CELL, :].reshape(n, CELL, g.shape[1]).var(axis=1).sum()
        if var < best[0]:
            best = (var, o)
    return best[1]


def downsample(a):
    ox, oy = best_phase(a, 1), best_phase(a, 0)
    h = (a.shape[0] - oy) // CELL
    w = (a.shape[1] - ox) // CELL
    out = np.zeros((h, w, 3))
    m = CELL // 4
    for r in range(h):
        for c in range(w):
            block = a[oy + r * CELL + m : oy + (r + 1) * CELL - m, ox + c * CELL + m : ox + (c + 1) * CELL - m]
            out[r, c] = np.median(block.reshape(-1, 3), axis=0)
    return out


def lum_sat(c):
    mx, mn = c.max() / 255, c.min() / 255
    return mx, (mx - mn) / mx if mx > 0 else 0


def components(mask):
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    for r in range(h):
        for c in range(w):
            if not mask[r, c] or seen[r, c]:
                continue
            q = deque([(r, c)])
            seen[r, c] = True
            comp = []
            while q:
                y, x = q.popleft()
                comp.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            comps.append(comp)
    return comps


def extract(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float)
    g = downsample(a)
    h, w, _ = g.shape
    border = np.concatenate([g[0], g[-1], g[:, 0], g[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(g - bg, axis=2)
    background = np.zeros((h, w), dtype=bool)
    q = deque([(r, c) for r in range(h) for c in (0, w - 1)] + [(r, c) for c in range(w) for r in (0, h - 1)])
    while q:
        r, c = q.popleft()
        if not (0 <= r < h and 0 <= c < w) or background[r, c] or dist[r, c] > 11:
            continue
        background[r, c] = True
        q.extend([(r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)])
    comps = components(~background)
    comps.sort(key=len, reverse=True)
    big = [c for c in comps if len(c) >= len(comps[0]) * 0.25]
    minors = [c for c in comps if len(c) < len(comps[0]) * 0.25]
    while len(big) < 3:
        widest = max(big, key=lambda c: max(p[1] for p in c) - min(p[1] for p in c))
        xs = [p[1] for p in widest]
        x0, x1 = min(xs), max(xs)
        counts = {x: 0 for x in range(x0, x1 + 1)}
        for p in widest:
            counts[p[1]] += 1
        lo, hi = x0 + (x1 - x0) * 3 // 10, x0 + (x1 - x0) * 7 // 10
        cut = min(range(lo, hi + 1), key=lambda x: counts[x])
        big.remove(widest)
        big += [[p for p in widest if p[1] < cut], [p for p in widest if p[1] >= cut]]
    big.sort(key=len, reverse=True)
    minors += big[3:]
    majors = big[:3]
    boxes = [[min(p[0] for p in c), max(p[0] for p in c), min(p[1] for p in c), max(p[1] for p in c)] for c in majors]
    views = [set(c) for c in majors]
    near = []
    for comp in majors:
        m = np.zeros((h, w), dtype=bool)
        for (y, x) in comp:
            m[max(0, y - 1) : y + 2, max(0, x - 1) : x + 2] = True
        near.append(m)
    for comp in minors:
        for i, m in enumerate(near):
            y0, y1, x0, x1 = boxes[i]
            inside = all(y0 <= y <= y1 and x0 <= x <= x1 for (y, x) in comp)
            if len(comp) <= 40 and inside and any(m[y, x] for (y, x) in comp):
                views[i] |= set(comp)
                break
    order = sorted(range(3), key=lambda i: boxes[i][2])
    out = []
    for i in order:
        cells = views[i]
        bottom = max(p[0] for p in cells)
        cleaned = set()
        for (r, c) in cells:
            lum, sat = lum_sat(g[r, c])
            if r >= bottom - 3 and lum > 0.8 and sat < 0.2:
                continue
            cleaned.add((r, c))
        out.append(cleaned)
    return g, out


def is_skin(c):
    r, gg, b = c / 255
    return r > 0.88 and gg > 0.7 and b > 0.62 and r - b > 0.08 and r >= gg >= b - 0.02


def view_grid(g, cells, top, bottom):
    xs = [p[1] for p in cells]
    x0, x1 = min(xs), max(xs)
    return [[tuple(g[r, c]) if (r, c) in cells else None for c in range(x0, x1 + 1)] for r in range(top, bottom + 1)]


def faces_left(rows):
    skin, other = [], []
    for r in range(len(rows) // 2):
        for c, color in enumerate(rows[r]):
            if color is not None:
                (skin if is_skin(np.array(color)) else other).append(c)
    if not skin or not other:
        return True
    return np.mean(skin) < np.mean(other)


def main():
    args = sys.argv[1:]
    debug = None
    if "--debug" in args:
        i = args.index("--debug")
        debug = Path(args[i + 1])
        del args[i : i + 2]
    root = Path(args[0]) if args else Path(__file__).resolve().parents[2] / "人设" / "体素"
    target = Path(__file__).resolve().parents[1] / "src" / "office-scene" / "sprites.generated.ts"
    result = {}
    for vendor in VENDORS:
        path = root / f"{vendor}.png"
        if not path.exists():
            # 仓库自带的人设（目前只有未知模型）：人设目录里没有时用这张。
            path = Path(__file__).resolve().parents[1] / "assets" / "personas" / f"{vendor}.png"
        if not path.exists():
            continue
        g, views = extract(path)
        top = min(p[0] for v in views for p in v)
        bottom = max(p[0] for v in views for p in v)
        grids = [view_grid(g, v, top, bottom) for v in views]
        if not faces_left(grids[1]):
            grids[1] = [list(reversed(row)) for row in grids[1]]
        H = len(grids[0])
        W = sum(len(gr[0]) for gr in grids)
        img = Image.new("RGB", (W, H), (255, 255, 255))
        x = 0
        for gr in grids:
            for r, row in enumerate(gr):
                for c, color in enumerate(row):
                    if color is not None:
                        img.putpixel((x + c, r), tuple(int(v) for v in color))
            x += len(gr[0])
        q = img.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        pal = (q.getpalette() or [])[: 64 * 3]
        pal += [0] * (64 * 3 - len(pal))  # 颜色少于 64 种的图（如自绘人设）补齐
        palette = ["#%02x%02x%02x" % tuple(pal[i * 3 : i * 3 + 3]) for i in range(64)]
        encoded = []
        x = 0
        for gr in grids:
            encoded.append(
                ["".join("." if color is None else ALPHABET[q.getpixel((x + c, r))] for c, color in enumerate(row)) for r, row in enumerate(gr)]
            )
            x += len(gr[0])
        result[vendor] = {"palette": palette, "front": encoded[0], "side": encoded[1], "back": encoded[2]}
        print(vendor, "高", H, "宽", [len(gr[0]) for gr in grids])
        if debug is not None:
            debug.mkdir(parents=True, exist_ok=True)
            img.resize((W * 8, H * 8), Image.NEAREST).save(debug / f"{vendor}.png")
    header = (
        "/* 由 scripts/voxelize-personas.py 生成，勿手改。\n"
        " * 每个厂商：64 色调色板 + 正 / 侧（左为正面）/ 背 三视图，'.' 为空，\n"
        " * 其余字符按 SPRITE_ALPHABET 索引调色板；第一行是头顶，最后一行是脚底。 */\n\n"
    )
    body = "export interface SpriteSheet {\n  readonly palette: readonly string[];\n  readonly front: readonly string[];\n  readonly side: readonly string[];\n  readonly back: readonly string[];\n}\n\n"
    body += f"export const SPRITE_ALPHABET = {json.dumps(ALPHABET)};\n\n"
    body += "export const SPRITES: Readonly<Record<string, SpriteSheet>> = " + json.dumps(result, ensure_ascii=False) + ";\n"
    target.write_text(header + body)
    print("写入", target, target.stat().st_size, "字节")


if __name__ == "__main__":
    main()
