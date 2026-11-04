/**
 * 小体素部件：岗位道具、组长星标、闪光、问号。尺寸单位为 {@link PROP_VOXEL}，
 * 道具的握持点是 {@link PROP_HAND}（体素坐标）。
 */

import type { RoleKind } from "../office/types.ts";
import { Voxels, mix, shade } from "./voxel.ts";

export const PROP_VOXEL = 0.0425;
/** 道具体素坐标中的握持点（手心）。 */
export const PROP_HAND: readonly [number, number, number] = [7, 20, 0];

const WHITE = "#ffffff";
const GOLD = "#e3b546";

/** 岗位道具（+x 手持）。 */
export function buildRoleProp(role: RoleKind): Voxels {
  const v = new Voxels();
  const hy = PROP_HAND[1];
  const hx = PROP_HAND[0];
  switch (role) {
    case "lead": {
      v.box(hx - 1, hy - 3, 3, hx + 7, hy + 10, 3, "#8a5a33");
      v.box(hx, hy - 2, 4, hx + 6, hy + 8, 4, WHITE);
      for (let y = hy; y <= hy + 7; y += 2) v.box(hx + 2, y, 5, hx + (y % 4 === 0 ? 5 : 4), y, 5, "#9aa6b8");
      for (let y = hy; y <= hy + 7; y += 2) v.set(hx + 1, y, 5, "#4fb85b");
      v.box(hx + 2, hy + 9, 4, hx + 4, hy + 10, 5, GOLD);
      break;
    }
    case "frontend": {
      v.box(hx - 1, hy - 3, 3, hx + 9, hy + 5, 3, "#2a2d36");
      const palette = ["#ec6fa8", "#5bc0eb", "#ffd23f", "#9a6cf0", "#4fb85b", "#ffffff"];
      for (let x = hx; x <= hx + 8; x += 1)
        for (let y = hy - 2; y <= hy + 4; y += 1)
          v.set(x, y, 4, y === hy + 4 ? "#3a3f4a" : palette[(Math.floor(x / 3) + Math.floor(y / 2)) % palette.length]!);
      break;
    }
    case "backend": {
      v.box(hx + 1, hy - 3, 2, hx + 2, hy + 9, 3, "#9aa3ad");
      for (let a = 0; a < 14; a += 1) {
        const ang = (a / 14) * Math.PI * 2;
        if (Math.sin(ang) > 0.6) continue;
        v.set(hx + 1 + Math.round(Math.cos(ang) * 3), hy + 12 + Math.round(Math.sin(ang) * 3), 2, "#9aa3ad");
        v.set(hx + 2 + Math.round(Math.cos(ang) * 3), hy + 12 + Math.round(Math.sin(ang) * 3), 3, "#9aa3ad");
      }
      v.box(hx + 1, hy - 3, 2, hx + 2, hy + 1, 3, "#2fb3a3");
      break;
    }
    case "qa": {
      v.box(hx + 1, hy - 4, 2, hx + 2, hy + 3, 3, "#7a4a2a");
      for (let x = -5; x <= 5; x += 1)
        for (let y = -5; y <= 5; y += 1) {
          const r = Math.hypot(x, y);
          if (r > 5.2) continue;
          const color = r > 4 ? "#c9ced6" : (x === -1 && y === 1) || (x === -2 && y === 2) ? WHITE : "#bfe6f7";
          v.set(hx + 1 + x, hy + 9 + y, 3, color);
        }
      break;
    }
    case "reviewer": {
      v.box(hx + 1, hy - 3, 2, hx + 2, hy + 14, 3, "#e04f4f");
      v.box(hx + 1, hy - 5, 2, hx + 2, hy - 4, 3, "#2a2230");
      v.box(hx + 1, hy + 10, 4, hx + 2, hy + 14, 4, "#f4f4f4");
      break;
    }
    case "docs": {
      v.box(hx - 2, hy + 1, 1, hx + 10, hy + 3, 3, "#efe3c4");
      v.box(hx - 3, hy, 0, hx - 2, hy + 4, 4, "#a7794a");
      v.box(hx + 10, hy, 0, hx + 11, hy + 4, 4, "#a7794a");
      for (let x = hx; x <= hx + 8; x += 2) v.set(x, hy + 3, 4, "#9a8a6a");
      break;
    }
    case "design": {
      for (let x = -6; x <= 6; x += 1)
        for (let z = -4; z <= 4; z += 1)
          if ((x / 6.5) ** 2 + (z / 4.5) ** 2 <= 1 && !(x > 2 && x < 5 && z > -2 && z < 1)) v.set(hx + 3 + x, hy + 2, 2 + z, "#d9b98c");
      ["#e04f4f", "#4f7fe0", "#ffd23f", "#4fb85b", "#9a6cf0"].forEach((c, i) =>
        v.box(hx - 1 + i * 2, hy + 3, (i % 2) * 3, hx + i * 2, hy + 3, 1 + (i % 2) * 3, c),
      );
      break;
    }
    case "devops": {
      for (let a = 0; a < 32; a += 1) {
        const ang = (a / 32) * Math.PI * 2;
        const r = Math.floor(a / 2) % 2 === 0 ? 5.5 : 4;
        for (let rr = 2; rr <= r; rr += 1)
          v.set(hx + 2 + Math.round(Math.cos(ang) * rr), hy + 6 + Math.round(Math.sin(ang) * rr), 3, "#8d97a3");
      }
      v.set(hx + 2, hy + 6, 3, "#5b7fd6");
      break;
    }
    case "data": {
      v.box(hx - 1, hy - 3, 3, hx + 9, hy + 8, 3, WHITE);
      [4, 7, 5, 9].forEach((h, i) =>
        v.box(hx + i * 2, hy - 2, 4, hx + i * 2 + 1, hy - 3 + h, 4, ["#4fb85b", "#4f7fe0", "#f08a3c", "#4fb85b"][i]!),
      );
      break;
    }
    default: {
      // 组员：一杯咖啡
      v.box(hx, hy - 1, 2, hx + 4, hy + 4, 5, (x, y, z) =>
        x > hx && x < hx + 4 && z > 2 && z < 5 && y === hy + 4 ? "#6b4a2e" : y === hy + 3 ? "#8a93a3" : "#ffffff",
      );
      v.box(hx + 5, hy, 3, hx + 5, hy + 2, 3, "#ffffff");
      v.set(hx + 2, hy + 6, 3, "#e9eef2").set(hx + 3, hy + 7, 4, "#e9eef2");
      break;
    }
  }
  return v;
}

export function buildHalo(): Voxels {
  const v = new Voxels();
  const seg = (2 * Math.PI) / 5;
  for (let x = -7; x <= 7; x += 1)
    for (let y = -7; y <= 7; y += 1) {
      const ang = Math.atan2(y, x) - Math.PI / 2;
      const r = Math.hypot(x, y);
      const local = (((ang % seg) + seg) % seg) - seg / 2;
      const edge = 7 * (Math.cos(seg / 2) / Math.cos(local)) ** 3 * 0.55 + 7 * 0.45 * 0.6;
      if (r <= edge) {
        v.set(x, y, 0, r < 2.5 ? "#fff2b0" : GOLD);
        if (r < edge - 1.5) v.set(x, y, 1, r < 2.5 ? "#fff6c8" : shade(GOLD, 1.08));
      }
    }
  return v;
}

export function buildQuestion(): Voxels {
  const v = new Voxels();
  const pts: [number, number][] = [[-2, 4], [-1, 5], [0, 5], [1, 5], [2, 4], [2, 3], [1, 2], [0, 1], [0, 0], [0, -2]];
  for (const [x, y] of pts) v.set(x, y, 0, "#7ff0e4").set(x, y, 1, "#4fe0d0");
  return v;
}

export function buildSparkle(color: string): Voxels {
  const v = new Voxels();
  for (let k = -4; k <= 4; k += 1) {
    const c = Math.abs(k) <= 1 ? WHITE : mix(color, WHITE, 0.2);
    v.set(k, 0, 0, c).set(0, k, 0, c);
  }
  v.set(1, 1, 0, color).set(-1, 1, 0, color).set(1, -1, 0, color).set(-1, -1, 0, color);
  return v;
}

