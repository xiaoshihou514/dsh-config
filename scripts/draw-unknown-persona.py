#!/usr/bin/env python3
"""
画「未知模型」的三视图像素画（与 人设/体素/ 下各家同一规格：每格 14px、约 60 格高、
正 / 侧 / 背三视图并排、白底），输出 assets/personas/other.png，供
scripts/voxelize-personas.py 切图。人设/体素/ 里有 other.png 时以那张为准。

人设：神秘旅人——深紫兜帽斗篷（兜帽带尾巴、青色饰边、额前问号徽记）、薄荷银发、
金瞳、内衬深紫长裙、金色领扣，左手提一盏发青光的提灯，深色短靴。

用法：python3 -I scripts/draw-unknown-persona.py
"""

from pathlib import Path

from PIL import Image

CELL = 14
H = 60

HOOD = "#2a2140"
HOOD_LIGHT = "#3d3160"
HOOD_DARK = "#1b1530"
HOOD_MID = "#332850"
TRIM = "#4fe0d0"
TRIM_DARK = "#2a9c92"
HAIR = "#bfe6dc"
HAIR_LIGHT = "#e6fbf5"
HAIR_DARK = "#8fc4b6"
SKIN = "#fbe5d8"
SKIN_SHADE = "#f2cfc0"
BLUSH = "#f6b8bc"
LASH = "#2a2230"
IRIS_DARK = "#b47c14"
IRIS = "#e6b23a"
IRIS_LIGHT = "#f8dc80"
PUPIL = "#5a3a0a"
WHITE = "#ffffff"
DRESS = "#3b2f5c"
DRESS_LIGHT = "#4c3e74"
GOLD = "#e3b546"
GOLD_DARK = "#a8801e"
BOOT = "#1a1428"
BOOT_LIGHT = "#2e2444"
GLOW = "#7ff0e4"
GLOW_CORE = "#d8fffa"


class Grid:
    def __init__(self, w: int) -> None:
        self.w = w
        self.px: dict[tuple[int, int], str] = {}

    def set(self, x: int, y: int, c: str) -> None:
        if 0 <= x < self.w and 0 <= y < H:
            self.px[(x, y)] = c

    def get(self, x: int, y: int) -> str | None:
        return self.px.get((x, y))

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, color, y0: int = 0, y1: int = H - 1) -> None:
        for y in range(max(0, y0), min(H - 1, y1) + 1):
            for x in range(self.w):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                    c = color(x, y) if callable(color) else color
                    if c is not None:
                        self.set(x, y, c)


def hood_shade(cx: float):
    def f(x: int, y: int) -> str:
        if x < cx - 9 or y > 24 and x < cx - 5:
            return HOOD_DARK
        if (x - cx) > 4 and y < 12:
            return HOOD_LIGHT if (x + y) % 3 else HOOD_MID
        if (x - cx) > 8 and y < 18 and (x + y) % 2 == 0:
            return HOOD_MID
        return HOOD
    return f


def cape(g: Grid, cx: float, front_open: bool, lantern: bool) -> None:
    for y in range(26, 56):
        half = 8.5 + (y - 26) * 0.34
        for x in range(g.w):
            d = x - cx
            if abs(d) > half:
                continue
            c = HOOD
            if d < -half + 2:
                c = HOOD_DARK
            elif d > half - 2:
                c = HOOD_LIGHT
            # 褶皱 + 抖动高光
            if y > 34 and int(d + 40) % 5 == 0:
                c = HOOD_DARK
            elif c == HOOD and int(d + 40) % 5 == 2 and (x + y) % 2 == 0:
                c = HOOD_MID
            if y >= 54:
                c = TRIM if y == 54 else TRIM_DARK
            if front_open and y > 28:
                open_half = 0.5 + (y - 28) * 0.2
                if abs(d) <= open_half:
                    c = DRESS_LIGHT if abs(d) < open_half - 1 and y % 4 else DRESS
                    if y >= 53:
                        c = DRESS
                elif abs(d) <= open_half + 1:
                    c = TRIM
            g.set(x, y, c)
    # 袖子鼓包与手
    for side in (-1, 1):
        sx = cx + side * (half_at(36) + 0.5)
        for y in range(29, 41):
            for k in range(3):
                g.set(round(sx - side * k), y, HOOD_DARK if side < 0 else HOOD_LIGHT)
        hx = round(cx + side * (half_at(40) - 1))
        for k in range(-2, 3):
            g.set(hx + k, 39, TRIM)
        for y in range(40, 43):
            for k in range(-1, 2):
                g.set(hx + k, y, SKIN if y < 42 else SKIN_SHADE)
    # 提灯挂在身前（角色右手 = 正视图观者左侧）；背视图被斗篷挡住，不画。
    if not lantern:
        draw_boots(g, cx)
        return
    hx = round(cx - (half_at(40) - 1))
    for y in range(43, 45):
        g.set(hx, y, GOLD_DARK)
    for y in range(45, 53):
        for k in range(-2, 3):
            edge = abs(k) == 2 or y in (45, 52)
            g.set(hx + k, y, GOLD if edge else (GLOW_CORE if abs(k) == 0 and 47 <= y <= 50 else GLOW))
    draw_boots(g, cx)


def draw_boots(g: Grid, cx: float) -> None:
    for bx in (int(cx) - 4, int(cx) + 1):
        for y in range(56, 60):
            for k in range(0, 4):
                g.set(bx + k, y, BOOT_LIGHT if y == 56 or (y == 57 and k == 1) else BOOT)


def half_at(y: int) -> float:
    return 8.5 + (y - 26) * 0.34


def question(g: Grid, cx: int, top: int, color: str) -> None:
    for dx, dy in [(-1, 0), (0, 0), (1, 0), (2, 1), (1, 2), (0, 3), (0, 5)]:
        g.set(cx + dx, top + dy, color)


def front() -> Grid:
    g = Grid(40)
    cx = 20
    # 兜帽
    g.ellipse(cx, 14, 15.5, 14.5, hood_shade(cx), 0, 27)
    # 兜帽开口：头发 + 脸
    opening = lambda x, y: ((x - cx) / 9.6) ** 2 + ((y - 17.5) / 9.3) ** 2 <= 1
    for y in range(7, 28):
        for x in range(40):
            if not opening(x, y):
                continue
            g.set(x, y, SKIN)
    # 刘海（下沿参差）
    for x in range(cx - 10, cx + 11):
        bottom = 13 + (1 if (x - cx) % 3 == 0 else 0) + (1 if abs(x - cx) > 6 else 0)
        for y in range(7, bottom + 1):
            if opening(x, y):
                g.set(x, y, HAIR_LIGHT if y < 10 and (x - cx) % 4 == 1 else (HAIR_DARK if (x - cx) % 3 == 0 else HAIR))
    # 鬓发
    for side in (-1, 1):
        for y in range(13, 32):
            for k in range(2):
                x = cx + side * (8 - k + (1 if y > 24 else 0))
                g.set(x, y, HAIR if k else HAIR_DARK)
    # 开口青色饰边
    for y in range(6, 29):
        for x in range(40):
            if opening(x, y):
                continue
            near = any(opening(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            if near and g.get(x, y) is not None and y < 27:
                g.set(x, y, TRIM)
    # 眼睛（4 宽 × 4 高）
    for ex in (cx - 6, cx + 3):
        for k in range(4):
            g.set(ex + k, 17, LASH)
        for k in range(4):
            g.set(ex + k, 18, IRIS_DARK)
            g.set(ex + k, 19, IRIS)
            g.set(ex + k, 20, IRIS_LIGHT)
        g.set(ex + 1, 18, PUPIL)
        g.set(ex + 2, 18, PUPIL)
        g.set(ex + 1, 19, PUPIL)
        g.set(ex + 2, 19, PUPIL)
        g.set(ex, 18, WHITE)
        g.set(ex + 3, 20, WHITE)
        g.set(ex + (4 if ex > cx else -1), 17, LASH)
    # 腮红、嘴
    for x in (cx - 7, cx - 6, cx + 6, cx + 7):
        g.set(x, 22, BLUSH)
    g.set(cx, 24, SKIN_SHADE)
    g.set(cx - 1, 24, SKIN_SHADE)
    # 额前问号徽记
    question(g, cx, 1, TRIM)
    # 斗篷、领扣
    cape(g, cx, front_open=True, lantern=True)
    for x in range(cx - 1, cx + 2):
        g.set(x, 27, GOLD)
    g.set(cx, 28, GOLD_DARK)
    return g


def back() -> Grid:
    g = Grid(40)
    cx = 20
    g.ellipse(cx, 14, 15.5, 14.5, lambda x, y: HOOD_LIGHT if x < cx - 4 and y < 12 else (HOOD_DARK if x > cx + 9 else HOOD), 0, 27)
    # 兜帽尾巴：从后脑垂到背中
    for y in range(18, 34):
        w = max(0, round(4 - (y - 18) * 0.28))
        for x in range(cx - w, cx + w + 1):
            g.set(x, y, TRIM if abs(x - cx) == w else HOOD_DARK)
    g.set(cx, 34, TRIM)
    cape(g, cx, front_open=False, lantern=False)
    # 尾巴盖在斗篷上
    for y in range(26, 34):
        w = max(0, round(4 - (y - 18) * 0.28))
        for x in range(cx - w, cx + w + 1):
            g.set(x, y, TRIM if abs(x - cx) == w else HOOD_DARK)
    # 兜帽下沿露出的发梢
    for side in (-1, 1):
        for y in range(26, 31):
            g.set(cx + side * 9, y, HAIR)
            g.set(cx + side * 10, y, HAIR_DARK)
    return g


def side() -> Grid:
    """侧视图：面朝左（观者左侧是正面）。"""
    g = Grid(34)
    cx = 17
    g.ellipse(cx, 14, 12.5, 14.5, lambda x, y: HOOD_DARK if x > cx + 7 else (HOOD_LIGHT if y < 10 and x < cx else HOOD), 0, 27)
    # 兜帽尾巴（向后下方）
    for y in range(8, 30):
        x0 = cx + 10 + round((y - 8) * 0.25)
        for k in range(3):
            g.set(x0 + k, y, TRIM if k == 2 else HOOD_DARK)
    # 侧脸开口（前方）
    opening = lambda x, y: ((x - (cx - 7)) / 6.2) ** 2 + ((y - 18) / 8.8) ** 2 <= 1
    for y in range(8, 28):
        for x in range(34):
            if opening(x, y):
                g.set(x, y, SKIN)
    for y in range(8, 15):
        for x in range(34):
            if opening(x, y) and y <= 13 + (1 if x % 3 == 0 else 0):
                g.set(x, y, HAIR if x % 3 else HAIR_DARK)
    # 侧脸后方鬓发
    for y in range(13, 31):
        for x in (cx - 3, cx - 2):
            g.set(x, y, HAIR if x == cx - 3 else HAIR_DARK)
    for y in range(7, 29):
        for x in range(34):
            if opening(x, y):
                continue
            if any(opening(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))) and g.get(x, y) is not None and y < 27:
                g.set(x, y, TRIM)
    # 侧脸的眼睛（窄）
    ex = cx - 11
    for k in range(3):
        g.set(ex + k, 17, LASH)
        g.set(ex + k, 18, IRIS_DARK)
        g.set(ex + k, 19, IRIS)
        g.set(ex + k, 20, IRIS_LIGHT)
    g.set(ex + 1, 18, PUPIL)
    g.set(ex + 1, 19, PUPIL)
    g.set(ex, 18, WHITE)
    g.set(ex + 1, 22, BLUSH)
    g.set(ex + 2, 22, BLUSH)
    # 斗篷侧面：前沿后退、后沿外扩
    for y in range(26, 56):
        f = round(cx - 7 - (y - 26) * 0.22)
        b = round(cx + 7 + (y - 26) * 0.3)
        for x in range(f, b + 1):
            c = HOOD if x > f + 1 else DRESS
            if x > b - 2:
                c = HOOD_DARK
            if y >= 54:
                c = TRIM if y == 54 else TRIM_DARK
            g.set(x, y, c)
    for x in range(cx - 8, cx - 5):
        g.set(x, 27, GOLD)
    # 袖子与手（前侧）
    for y in range(29, 41):
        for x in range(cx - 4, cx):
            g.set(x, y, HOOD_LIGHT if x == cx - 4 else HOOD)
    for y in range(40, 43):
        for x in range(cx - 4, cx - 1):
            g.set(x, y, SKIN if y < 42 else SKIN_SHADE)
    # 提灯在身体另一侧的手上，侧视图里看不到。
    # 靴子（一只，脚尖朝左）
    for y in range(56, 60):
        for x in range(cx - 4, cx + 2):
            g.set(x, y, BOOT_LIGHT if y == 56 else BOOT)
    return g


def main() -> None:
    views = [front(), side(), back()]
    gap = 6
    margin = 4
    width = sum(v.w for v in views) + gap * 2 + margin * 2
    img = Image.new("RGB", (width * CELL, (H + margin * 2) * CELL), (255, 255, 255))
    x0 = margin
    for v in views:
        for (x, y), c in v.px.items():
            rgb = tuple(int(c[i : i + 2], 16) for i in (1, 3, 5))
            img.paste(rgb, ((x0 + x) * CELL, (margin + y) * CELL, (x0 + x + 1) * CELL, (margin + y + 1) * CELL))
        x0 += v.w + gap
    target = Path(__file__).resolve().parents[1] / "assets" / "personas" / "other.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    img.save(target)
    print("写入", target, img.size)


if __name__ == "__main__":
    main()
