/**
 * 由三视图像素画（sprites.generated.ts）生成体素角色，力求各个角度看都自然。
 *
 * 形状：逐行推算截面。正视图每一段连续像素（头、身体、手臂、发束……）在侧视图
 * 该行的前沿 / 后沿之间做一个超椭圆截面——宽取正视图、深取侧视图；窄段的深度
 * 再按自身宽度收住，手臂、发束不会被撑成厚板。之后按侧视图挖掉镂空，侧面轮廓
 * 与参考图一致。
 *
 * 颜色按区域取：对每个表面体素估算平滑法线，朝前的整块取正视图、朝后取背视图
 * （左右镜像）、朝侧取侧视图。同一个体素各面同色，斜看时是连续色块在 45° 附近
 * 交界，而不是台阶上正 / 侧颜色交替的棋盘格。
 *
 * 侧视图只画了一侧：它的颜色只有在正 / 背视图同一行、同一半边出现过时才采用
 * （单侧发饰不会被复制到另一侧），否则沿用正 / 背视图该位置的颜色；头部前段的
 * 侧面也不用侧视图（那里是侧脸，会在脸颊旁多出眼睛）。
 *
 * 关节：body ⊃ lower（髋以下）⊃ legL / legR（裙摆下露出的腿），
 * body ⊃ upper（髋以上）⊃ head（脖子以上，含头发）。
 */

import * as THREE from "three";
import { ROLE_COLOR } from "../office/classify.ts";
import type { RoleKind, Tier, Vendor } from "../office/types.ts";
import { buildCharacter as buildMeshCharacter, type CharacterRig } from "./anime.ts";
import { PROP_HAND, PROP_VOXEL, buildHalo, buildQuestion, buildRoleProp, buildSparkle } from "./props.ts";
import { SPRITES, SPRITE_ALPHABET, type SpriteSheet } from "./sprites.generated.ts";
import { Voxels, unpackKey, voxelKey, voxelMaterial } from "./voxel.ts";

export const VOXEL = 0.0425;

type Grid = (string | null)[][];

function decode(sheet: SpriteSheet, rows: readonly string[]): Grid {
  return rows.map((row) => [...row].map((ch) => (ch === "." ? null : sheet.palette[SPRITE_ALPHABET.indexOf(ch)]!)));
}

/** 最底三行（脚）的列中心，用来对齐三视图。 */
function footCenter(grid: Grid): number {
  const cols: number[] = [];
  for (const row of grid.slice(-3)) row.forEach((c, i) => c !== null && cols.push(i));
  if (cols.length === 0) return (grid[0]!.length - 1) / 2;
  return (Math.min(...cols) + Math.max(...cols)) / 2;
}

function runs(row: readonly (string | null)[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  row.forEach((c, i) => {
    if (c !== null && start < 0) start = i;
    if (c === null && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, row.length - 1]);
  return out;
}

function isSkin(hex: string): boolean {
  const c = new THREE.Color(hex);
  return c.r > 0.88 && c.g > 0.7 && c.b > 0.62 && c.r - c.b > 0.08 && c.r >= c.g;
}

/** 某厂商的基础造型（与岗位、档位无关）：各关节部件的表面体素颜色。 */
interface Base {
  readonly cells: { head: Map<number, string>; upper: Map<number, string>; lower: Map<number, string>; legL: Map<number, string>; legR: Map<number, string> };
  readonly height: number;
  readonly width: number;
  readonly neck: number;
  readonly hip: number;
  readonly hem: number;
  readonly legX: number;
  /** 每个 (x, y) 最前方体素的 z。 */
  readonly frontZ: Map<string, number>;
  readonly front: Grid;
  readonly cxF: number;
  /** 侧视图该行的深度中心（相对脚中心，+z 朝前）。 */
  readonly zCenter: (y: number) => number;
}

interface Model {
  readonly parts: { upper: Voxels; head: Voxels; lower: Voxels; legL: Voxels; legR: Voxels };
  readonly height: number;
  readonly neck: number;
  readonly hip: number;
  readonly hem: number;
  readonly legX: number;
  /** 肩关节（体素坐标），左右对称取 ±x。 */
  readonly shoulder: [number, number, number];
  readonly armL: Voxels;
  readonly armR: Voxels;
  /** 躯干半宽（体素）：蒙皮权重里「身体两侧」从这里往外算。 */
  readonly torsoHalf: number;
  readonly zCenter: (y: number) => number;
  /** 手心（相对肩关节）。 */
  readonly hand: [number, number, number];
  readonly face: FaceDecals | undefined;
}

// ---------------------------------------------------------------- 表情

export type EyeState = "open" | "closed" | "happy" | "half";
export type MouthState = "none" | "open" | "smile" | "small";

/**
 * 每家正视图里眼睛与嘴的位置（行 / 列，按 sprites.generated.ts 的正视图网格，手工标注）：
 * L / R = [上行, 下行, 左列, 右列]；M = [行, 列]（嘴的左上角）。
 */
const FACE_SPEC: Record<string, { L: [number, number, number, number]; R: [number, number, number, number]; M: [number, number] }> = {
  deepseek: { L: [18, 20, 11, 14], R: [18, 20, 20, 24], M: [23, 17] },
  claude: { L: [15, 16, 13, 16], R: [14, 15, 21, 24], M: [19, 19] },
  grok: { L: [17, 18, 13, 16], R: [16, 18, 21, 25], M: [20, 19] },
  glm: { L: [15, 17, 12, 14], R: [15, 17, 19, 21], M: [20, 16] },
  kimi: { L: [17, 18, 14, 17], R: [16, 17, 22, 25], M: [20, 19] },
  gpt: { L: [18, 19, 15, 18], R: [18, 19, 24, 27], M: [21, 20] },
  gemini: { L: [17, 19, 13, 17], R: [17, 18, 22, 25], M: [21, 20] },
  qwen: { L: [16, 17, 15, 17], R: [16, 17, 22, 25], M: [21, 19] },
  other: { L: [17, 20, 11, 15], R: [17, 20, 21, 25], M: [24, 17] },
};

/** 手臂位置微调（体素）：dx 肩宽、dz 前后（负 = 往后）、dy 上下（正 = 往上）。按渲染结果逐家调。 */
const ARM_TWEAK: Partial<Record<string, { dx: number; dz: number; dy?: number }>> = {
  claude: { dx: 0, dz: -2, dy: 2 },
};

/** 一种表情 = 正脸上若干像素的覆盖色：[x, y, z(前表面), 颜色]。 */
type Decal = [number, number, number, string][];
interface FaceDecals {
  readonly eyes: Record<Exclude<EyeState, "open">, Decal>;
  readonly mouth: Record<Exclude<MouthState, "none">, Decal>;
}

function lum(hex: string): number {
  const c = new THREE.Color(hex);
  return (c.r + c.g + c.b) / 3;
}

function buildFace(vendor: string, base: Base): FaceDecals | undefined {
  const spec = FACE_SPEC[vendor];
  if (spec === undefined) return undefined;
  const { front: F, cxF, height: H } = base;
  const at = (row: number, col: number): [number, number, number] => {
    const x = col - cxF;
    const y = H - 1 - row;
    return [x, y, base.frontZ.get(`${x},${y}`) ?? 0];
  };
  // 肤色：两眼下方一行最常见的偏肤色像素；睫毛色：眼睛范围内最暗的像素（再压暗）。
  const counts = new Map<string, number>();
  for (let r = Math.min(spec.L[1], spec.R[1]) + 1; r <= Math.min(spec.L[1], spec.R[1]) + 3; r += 1)
    for (let c = spec.L[2]; c <= spec.R[3]; c += 1) {
      const k = F[r]?.[c];
      if (k != null && lum(k) > 0.72) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  const skin = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#f8e6de";
  let lash = "#2a2230";
  let darkest = Infinity;
  for (const e of [spec.L, spec.R])
    for (let r = e[0]; r <= e[1]; r += 1)
      for (let c = e[2]; c <= e[3]; c += 1) {
        const k = F[r]?.[c];
        if (k != null && lum(k) < darkest) {
          darkest = lum(k);
          lash = k;
        }
      }
  if (darkest > 0.35) lash = `#${new THREE.Color(lash).multiplyScalar(0.45).getHexString()}`;
  const eyeDecal = (draw: (e: [number, number, number, number], set: (r: number, c: number, color: string) => void) => void): Decal => {
    const map = new Map<string, [number, number, string]>();
    const set = (r: number, c: number, color: string) => map.set(`${r},${c}`, [r, c, color]);
    for (const e of [spec.L, spec.R]) {
      for (let r = e[0]; r <= e[1]; r += 1) for (let c = e[2]; c <= e[3]; c += 1) set(r, c, skin);
      draw(e, set);
    }
    return [...map.values()].map(([r, c, color]) => [...at(r, c), color]);
  };
  const [mr, mc] = spec.M;
  // 嘴色从肤色推算：暖褐粉（加深肤色、压低蓝绿），不用红紫色。
  const tone = (k: number, warm: number) => {
    const c = new THREE.Color(skin);
    return `#${new THREE.Color(Math.min(1, c.r * k * (1 + warm)), c.g * k * 0.92, c.b * k * 0.86).getHexString()}`;
  };
  const inner = tone(0.58, 0.08);
  const lower = tone(0.82, 0.06);
  const lip = tone(0.7, 0.05);
  const mouthDecal = (pixels: [number, number, string][]): Decal => pixels.map(([dr, dc, color]) => [...at(mr + dr, mc + dc), color]);
  return {
    eyes: {
      closed: eyeDecal((e, set) => {
        for (let c = e[2]; c <= e[3]; c += 1) set(e[1], c, lash);
      }),
      happy: eyeDecal((e, set) => {
        for (let c = e[2]; c <= e[3]; c += 1) set(c === e[2] || c === e[3] ? e[1] : e[1] - 1, c, lash);
      }),
      half: eyeDecal((e, set) => {
        // 只盖上半，留下眼睛下半
        const mid = Math.floor((e[0] + e[1]) / 2);
        for (let r = mid + 1; r <= e[1]; r += 1) for (let c = e[2]; c <= e[3]; c += 1) set(r, c, F[r]?.[c] ?? skin);
        for (let c = e[2]; c <= e[3]; c += 1) set(mid, c, lash);
      }),
    },
    mouth: {
      open: mouthDecal([
        [0, 0, inner],
        [0, 1, inner],
        [1, 0, lower],
        [1, 1, lower],
      ]),
      small: mouthDecal([
        [0, 0, lip],
        [0, 1, lip],
      ]),
      smile: mouthDecal([
        [0, -1, lip],
        [1, 0, lip],
        [0, 1, lip],
      ]),
    },
  };
}

function decalGeometry(decal: Decal, pivot: readonly [number, number, number]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  for (const [x, y, z, color] of decal) {
    c.set(color);
    const zf = (z + 0.5 - pivot[2]) * VOXEL + 0.0015;
    const x0 = (x - 0.5 - pivot[0]) * VOXEL;
    const x1 = (x + 0.5 - pivot[0]) * VOXEL;
    const y0 = (y - pivot[1]) * VOXEL;
    const y1 = (y + 1 - pivot[1]) * VOXEL;
    positions.push(x0, y0, zf, x1, y0, zf, x1, y1, zf, x0, y0, zf, x1, y1, zf, x0, y1, zf);
    for (let i = 0; i < 6; i += 1) colors.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

/**
 * 袖子颜色：立绘里肩膀到肘部一带（左右两侧）最常见的颜色，排除肤色与发色
 * （发色取头顶几行最常见的三种）；取不到时用脖子下方正中的上衣色。
 */
function sleeveColor(base: Base, shoulderX: number, shoulderY: number): string {
  const { front: F, cxF, height: H } = base;
  const hair = new Map<string, number>();
  for (let row = 0; row < 8; row += 1) for (const k of F[row] ?? []) if (k != null) hair.set(k, (hair.get(k) ?? 0) + 1);
  const hairSet = new Set([...hair].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k));
  const near = (a: string, b: string) => new THREE.Color(a).sub(new THREE.Color(b)).toArray().every((v) => Math.abs(v) < 0.12);
  const counts = new Map<string, number>();
  for (let y = shoulderY - 1; y >= shoulderY - 7; y -= 1)
    for (const sx of [-shoulderX, shoulderX])
      for (let dx = -1; dx <= 1; dx += 1) {
        const k = F[H - 1 - y]?.[sx + dx + cxF];
        if (k == null || isSkin(k) || [...hairSet].some((h) => near(h, k))) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (best !== undefined && best[1] >= 3) return best[0];
  const center = new Map<string, number>();
  for (let row = H - base.neck + 2; row <= H - base.neck + 8; row += 1)
    for (let c = cxF - 4; c <= cxF + 4; c += 1) {
      const k = F[row]?.[c];
      if (k != null && !isSkin(k)) center.set(k, (center.get(k) ?? 0) + 1);
    }
  return [...center].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#6a7080";
}

const baseCache = new Map<string, Base>();

function buildBase(vendor: string): Base {
  const hit = baseCache.get(vendor);
  if (hit !== undefined) return hit;
  const sheet = SPRITES[vendor]!;
  const F = decode(sheet, sheet.front);
  const S = decode(sheet, sheet.side);
  const B = decode(sheet, sheet.back);
  const H = F.length;
  const W = F[0]!.length;
  const cxF = Math.round(footCenter(F));
  const cxB = Math.round(footCenter(B));
  const czS = Math.round(footCenter(S));

  // 侧视图每行的前沿 / 后沿（相对脚的中心，+z 朝前）。
  const sideFront: number[] = [];
  const sideBack: number[] = [];
  S.forEach((row) => {
    const cols = row.flatMap((c, i) => (c === null ? [] : [i]));
    sideFront.push(cols.length === 0 ? 1 : czS - Math.min(...cols));
    sideBack.push(cols.length === 0 ? 1 : Math.max(...cols) - czS);
  });

  // 下摆：从脚往上，第一行宽度明显超过脚宽。
  const width = (row: number) => F[row]!.filter((c) => c !== null).length;
  const footWidth = Math.max(2, width(H - 1), width(H - 2));
  let hemRow = H - 1;
  while (hemRow > H * 0.4 && width(hemRow) < footWidth * 1.8) hemRow -= 1;
  const hem = H - 1 - hemRow;
  const neck = Math.round(H * 0.57);
  const hip = Math.max(hem + 2, Math.round(H * 0.33));

  // ---- 体素占据：三维数组
  const x0 = -cxF - 1;
  const nx = W + 2;
  const zMin = -Math.max(...sideBack, 1) - 1;
  const zMax = Math.max(...sideFront, 1) + 1;
  const nz = zMax - zMin + 1;
  const ny = H;
  const occ = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number) => (x - x0) + nx * (y + ny * (z - zMin));
  const inGrid = (x: number, y: number, z: number) => x >= x0 && x < x0 + nx && y >= 0 && y < ny && z >= zMin && z <= zMax;
  const solid = (x: number, y: number, z: number) => inGrid(x, y, z) && occ[idx(x, y, z)] === 1;

  const P = 2.4; // 截面超椭圆指数：>2 稍方，接近体素画的饱满感
  for (let row = 0; row < H; row += 1) {
    const y = H - 1 - row;
    const zf = sideFront[row]!;
    const zb = -sideBack[row]!;
    const zc = (zf + zb) / 2;
    const rzRow = Math.max(0.5, (zf - zb) / 2);
    for (const [a, b] of runs(F[row]!)) {
      const cx = (a + b) / 2;
      const hw = (b - a) / 2 + 0.5;
      // 窄段（手臂、发束、尾巴）：深度按自身宽度收住，中心仍在该行的深度中段。
      const rz = Math.min(rzRow, Math.max(1.2, hw * 1.6));
      for (let c = a; c <= b; c += 1) {
        const u = Math.min(1, Math.abs(c - cx) / hw);
        const half = rz * (1 - u ** P) ** (1 / P);
        const x = c - cxF;
        const lo = Math.round(zc - half);
        const hi = Math.round(zc + half);
        const all: number[] = [];
        for (let z = lo; z <= hi; z += 1) all.push(z);
        // 按侧视图挖空（整列都会被挖空时保留，免得正面破洞）。
        const kept = all.filter((z) => (S[row]?.[czS - z] ?? null) !== null);
        for (const z of kept.length > 0 ? kept : all) if (inGrid(x, y, z)) occ[idx(x, y, z)] = 1;
      }
    }
  }

  // ---- 侧视图颜色校正：只用正 / 背视图在该位置附近（左右 4 格、上下 2 行）出现过的颜色。
  // 侧视图颜色与其中某个足够接近就原样采用（保留侧面的明暗）；否则换成最接近的那个——
  // 侧视图的头发高光、只长在一侧的饰物不会被印到轮廓边缘或另一侧。
  const rgbCache = new Map<string, [number, number, number]>();
  const rgb = (hex: string) => {
    let v = rgbCache.get(hex);
    if (v === undefined) {
      const c = new THREE.Color(hex);
      v = [c.r * 255, c.g * 255, c.b * 255];
      rgbCache.set(hex, v);
    }
    return v;
  };
  const adjustSide = (color: string, x: number, row: number): string | null => {
    const target = rgb(color);
    let best: string | null = null;
    let bestD = Infinity;
    const consider = (c: string | null | undefined) => {
      if (c == null) return;
      const v = rgb(c);
      const d = (v[0] - target[0]) ** 2 + (v[1] - target[1]) ** 2 + (v[2] - target[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    };
    for (let r = Math.max(0, row - 2); r <= Math.min(H - 1, row + 2); r += 1)
      for (let dx = -4; dx <= 4; dx += 1) {
        consider(F[r]?.[x + dx + cxF]);
        consider(B[r]?.[cxB - x - dx]);
      }
    if (best === null) return null;
    return bestD < 45 * 45 ? color : best;
  };

  const FACE_DEPTH = 7;
  const frontColor = (x: number, row: number) => F[row]?.[x + cxF] ?? null;
  const backColor = (x: number, row: number) => B[row]?.[cxB - x] ?? null;
  const colorAt = (x: number, y: number, z: number): string => {
    const row = H - 1 - y;
    // 平滑法线：半径 2 内空位的方向之和。
    let gx = 0;
    let gz = 0;
    for (let dx = -2; dx <= 2; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dz = -2; dz <= 2; dz += 1) {
          if ((dx === 0 && dz === 0) || solid(x + dx, y + dy, z + dz)) continue;
          const d2 = dx * dx + dz * dz;
          gx += dx / d2;
          gz += dz / d2;
        }
    const zc = (sideFront[row]! - sideBack[row]!) / 2;
    const facesFront = Math.abs(gz) >= Math.abs(gx) * 0.95 || Math.hypot(gx, gz) < 0.4;
    const frontish = Math.abs(gz) > 0.4 ? gz > 0 : z >= zc;
    const fb = () => (frontish ? (frontColor(x, row) ?? backColor(x, row)) : (backColor(x, row) ?? frontColor(x, row)));
    if (facesFront) return fb() ?? S[row]?.[czS - z] ?? "#888888";
    // 侧面区域
    if (y >= neck && z > sideFront[row]! - FACE_DEPTH) {
      // 头部前段：沿用正视图朝外相邻列（通常是框住脸的鬓发）。
      const out = x + (gx < 0 ? -1 : 1);
      return frontColor(out, row) ?? fb() ?? "#888888";
    }
    const side = S[row]?.[czS - z] ?? null;
    const adjusted = side === null ? null : adjustSide(side, x, row);
    return adjusted ?? fb() ?? side ?? "#888888";
  };

  const cells = { head: new Map<number, string>(), upper: new Map<number, string>(), lower: new Map<number, string>(), legL: new Map<number, string>(), legR: new Map<number, string>() };
  const frontZ = new Map<string, number>();
  for (let z = zMin; z <= zMax; z += 1)
    for (let y = 0; y < ny; y += 1)
      for (let x = x0; x < x0 + nx; x += 1) {
        if (!solid(x, y, z)) continue;
        const k = `${x},${y}`;
        frontZ.set(k, Math.max(frontZ.get(k) ?? -Infinity, z));
        const surface =
          !solid(x + 1, y, z) || !solid(x - 1, y, z) || !solid(x, y + 1, z) || !solid(x, y - 1, z) || !solid(x, y, z + 1) || !solid(x, y, z - 1);
        if (!surface) continue;
        const part = y >= neck ? cells.head : y >= hip ? cells.upper : y < hem ? (x < 0 ? cells.legL : cells.legR) : cells.lower;
        part.set(voxelKey(x, y, z), colorAt(x, y, z));
      }

  const zCenter = (y: number) => {
    const row = Math.min(H - 1, Math.max(0, H - 1 - y));
    return (sideFront[row]! - sideBack[row]!) / 2;
  };
  const legCols = F[H - 1]!.flatMap((c, i) => (c === null ? [] : [Math.abs(i - cxF)]));
  const legX = legCols.length === 0 ? 2 : Math.max(1, Math.round(Math.max(...legCols) / 2));
  const base: Base = { cells, height: H, width: W, neck, hip, hem, legX, frontZ, front: F, cxF, zCenter };
  baseCache.set(vendor, base);
  return base;
}

const modelCache = new Map<string, Model>();

function buildModel(vendor: string, role: RoleKind, fast: boolean): Model {
  const key = `${vendor}:${role}:${fast}`;
  const hit = modelCache.get(key);
  if (hit !== undefined) return hit;
  const base = buildBase(vendor);
  const { height: H, width: W, front: F, cxF } = base;
  const toVoxels = (m: Map<number, string>) => {
    const v = new Voxels();
    for (const [k, c] of m) v.cells.set(k, c);
    return v;
  };
  const parts = {
    head: toVoxels(base.cells.head),
    upper: toVoxels(base.cells.upper),
    lower: toVoxels(base.cells.lower),
    legL: toVoxels(base.cells.legL),
    legR: toVoxels(base.cells.legR),
  };
  const frontAt = (x: number, y: number) => base.frontZ.get(`${x},${y}`) ?? -Infinity;

  // 岗位胸章
  const badgeY = Math.round(H * 0.47);
  for (let dy = 0; dy < 3; dy += 1)
    for (let dx = 0; dx < 2; dx += 1) {
      const x = -3 - dx;
      const zf = frontAt(x, badgeY + dy);
      if (Number.isFinite(zf)) parts.upper.set(x, badgeY + dy, zf + 1, dy === 2 ? "#ffffff" : ROLE_COLOR[role]);
    }
  // 快速档：刘海左上的黄色闪电发夹
  if (fast) {
    const zig: [number, number][] = [[0, 0], [1, -1], [0, -2], [1, -3], [2, -3], [1, -4], [2, -5]];
    const bx = -Math.round(W * 0.16);
    const by = Math.round(H * 0.86);
    let zf = -Infinity;
    for (let dy = -5; dy <= 0; dy += 1) for (let dx = 0; dx <= 2; dx += 1) zf = Math.max(zf, frontAt(bx + dx, by + dy));
    if (Number.isFinite(zf)) for (const [dx, dy] of zig) parts.head.set(bx + dx, by + dy, zf + 1, "#ffd23f");
  }

  // 手臂：从肩膀自然下垂，袖子取立绘上衣色，袖口提亮，手用脸部肤色。
  const shoulderY = base.neck - 3;
  const shoulderX = Math.max(4, Math.round(W * 0.17));
  const sleeve = sleeveColor(base, shoulderX, shoulderY);
  const face = buildFace(vendor, base);
  const skin = (FACE_SPEC[vendor] && face?.eyes.closed.find(([, , , c]) => lum(c) > 0.72)?.[3]) ?? "#f8e6de";
  const cuff = lum(sleeve) < 0.5 ? `#${new THREE.Color(sleeve).lerp(new THREE.Color("#ffffff"), 0.75).getHexString()}` : "#ffffff";
  const L = Math.max(9, Math.round(H * 0.2));
  // 肩宽：按脸宽（手工标注的两眼外沿）定——Q 版比例里肩宽约等于脸宽；各家可再微调。
  // 前后：只看肩膀那几行躯干的前沿（不取下面裙摆、蝴蝶结、发束的最前），往里 1.5 格。
  const spec = FACE_SPEC[vendor];
  const tweak = ARM_TWEAK[vendor] ?? { dx: 0, dz: 0 };
  const sy = shoulderY + (tweak.dy ?? 0);
  const faceHalf = spec !== undefined ? (spec.R[3] - spec.L[2] + 1) / 2 + 1 : Math.round(W * 0.17) + 1;
  const sx = Math.max(5, Math.round(faceHalf + tweak.dx));
  const torsoHalf = sx - 1;
  let zs = -Infinity;
  for (let y = sy - 2; y <= sy; y += 1)
    for (let dx = -2; dx <= 0; dx += 1) zs = Math.max(zs, frontAt(sx + dx, y));
  zs = Number.isFinite(zs) ? Math.round(zs - 1.5 + tweak.dz) : 0;
  /** 一侧手臂；inward = 指向身体中线的 x 方向（右臂 -1，左臂 +1）。 */
  const makeArm = (inward: 1 | -1) => {
    const arm = new Voxels();
    // 泡泡袖肩头 + 往身体里接的一段（读作肩膀）
    arm.box(-2, -3, -2, 2, 1, 2, (x, y, z) => (Math.abs(x) + Math.abs(z) + Math.max(0, y) > 4 ? null : sleeve));
    arm.box(inward * 1, -2, -1, inward * 4, 1, 1, (x, y) => (Math.abs(x) === 4 && y === 1 ? null : sleeve));
    arm.box(-1, -L + 4, -1, 1, -3, 1, sleeve);
    arm.box(-2, -L + 3, -2, 2, -L + 3, 2, (x, _y, z) => (Math.abs(x) === 2 && Math.abs(z) === 2 ? null : cuff));
    arm.box(-1, -L, -1, 1, -L + 2, 1, skin);
    arm.set(inward, -L + 1, 2, skin); // 拇指朝内
    return arm;
  };
  const shoulder: [number, number, number] = [sx, sy, zs];
  const model: Model = {
    parts,
    height: H,
    neck: base.neck,
    hip: base.hip,
    hem: base.hem,
    legX: base.legX,
    shoulder,
    armL: makeArm(1),
    armR: makeArm(-1),
    torsoHalf,
    zCenter: base.zCenter,
    hand: [0, -L + 1, 0],
    face,
  };
  modelCache.set(key, model);
  return model;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();
function geometry(
  key: string,
  voxels: Voxels | Decal,
  pivot: readonly [number, number, number],
  size = VOXEL,
  flat = true,
): THREE.BufferGeometry {
  let g = geometryCache.get(key);
  if (g === undefined) {
    g = Array.isArray(voxels) ? decalGeometry(voxels, pivot) : voxels.geometry(size, pivot, flat);
    geometryCache.set(key, g);
  }
  return g;
}

/** 像素画角色用平涂材质：颜色与参考图一致，明暗只来自体素面朝向。 */
const flatMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });

function mesh(g: THREE.BufferGeometry, meshes: THREE.Mesh[], material: THREE.Material = flatMaterial): THREE.Mesh {
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.material = material;
  meshes.push(m);
  return m;
}

function joint(parent: THREE.Object3D, at: readonly [number, number, number], parentAt: readonly [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.position.set((at[0] - parentAt[0]) * VOXEL, (at[1] - parentAt[1]) * VOXEL, (at[2] - parentAt[2]) * VOXEL);
  parent.add(g);
  return g;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 蒙皮权重（按顶点位置算，相邻体素共用的顶点权重一致，不会裂开）：
 * - 脖子以上：头。
 * - 脖子以下的背后与身体两侧（长发所在）：从髋到脖子逐渐过渡到头。
 * - 胸前衣服：上身；髋部上下 3 格内上身 / 下身平滑过渡。
 */
function skinnedGeometry(key: string, model: Model): THREE.BufferGeometry {
  const hit = geometryCache.get(key);
  if (hit !== undefined) return hit;
  const all = new Voxels();
  for (const part of [model.parts.head, model.parts.upper, model.parts.lower])
    for (const [k, c] of part.cells) all.cells.set(k, c);
  const g = all.geometry(VOXEL, [0, 0, 0], true);
  const pos = g.getAttribute("position");
  const indices = new Uint16Array(pos.count * 4);
  const weights = new Float32Array(pos.count * 4);
  const { hip, neck, torsoHalf, zCenter } = model;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i) / VOXEL;
    const y = pos.getY(i) / VOXEL;
    const z = pos.getZ(i) / VOXEL;
    const back = Math.min(1, Math.max(0, (zCenter(Math.floor(y)) - z + 1) / 3));
    const side = Math.min(1, Math.max(0, (Math.abs(x) - torsoHalf) / 3));
    const hairy = Math.max(back, side);
    const headW = Math.max(smooth(neck - 1.5, neck + 0.5, y), hairy * smooth(hip, neck, y));
    const s = smooth(hip - 3, hip + 3, y);
    indices.set([0, 1, 2, 0], i * 4);
    weights.set([(1 - headW) * (1 - s), (1 - headW) * s, headW, 0], i * 4);
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  geometryCache.set(key, g);
  return g;
}

export function hasSprite(vendor: Vendor): boolean {
  return SPRITES[vendor] !== undefined;
}

/** 有三视图用像素画体素；没有的（未知模型）回退到网格角色。 */
export function buildCharacter(vendor: Vendor, tier: Tier, role: RoleKind): CharacterRig {
  if (!hasSprite(vendor)) return buildMeshCharacter(vendor, tier, role);
  const fast = tier === "fast";
  const model = buildModel(vendor, role, fast);
  const key = `${vendor}:${role}:${fast}`;
  const scale = fast ? 0.76 : 1;
  const meshes: THREE.Mesh[] = [];
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(scale);
  root.add(body);
  const origin: [number, number, number] = [0, 0, 0];

  // 头 / 上身 / 下身合成一张蒙皮网格，三根骨骼驱动：长发顺着权重过渡跟头部走，任何角度都没有接缝。
  const hipAt: [number, number, number] = [0, model.hip, 0];
  const neckAt: [number, number, number] = [0, model.neck, 0];
  const lower = new THREE.Bone();
  lower.position.set(0, model.hip * VOXEL, 0);
  const upper = new THREE.Bone();
  upper.position.set(0, model.hip * VOXEL, 0);
  const head = new THREE.Bone();
  head.position.set(0, (model.neck - model.hip) * VOXEL, 0);
  upper.add(head);
  body.add(lower, upper);
  const skinned = new THREE.SkinnedMesh(skinnedGeometry(`${key}:body`, model), flatMaterial);
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  skinned.userData.material = flatMaterial;
  skinned.frustumCulled = false;
  body.add(skinned);
  root.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([lower, upper, head]));
  meshes.push(skinned);

  const legs = ([-1, 1] as const).map((s) => {
    const at: [number, number, number] = [s * model.legX, model.hem, 0];
    const leg = joint(lower, at, hipAt);
    const voxels = s < 0 ? model.parts.legL : model.parts.legR;
    if (voxels.size > 0) leg.add(mesh(geometry(`${key}:leg${s}`, voxels, at), meshes));
    return leg;
  });

  // 手臂：肩关节为枢轴，挂在上身下。
  const arms = ([-1, 1] as const).map((s) => {
    const at: [number, number, number] = [s * model.shoulder[0], model.shoulder[1], model.shoulder[2]];
    const arm = joint(upper, at, hipAt);
    arm.add(mesh(geometry(`${key}:arm${s}`, s < 0 ? model.armL : model.armR, [0, 0, 0]), meshes));
    return arm;
  });
  const [armL, armR] = arms as [THREE.Group, THREE.Group];

  // 岗位道具：握持点对准右手
  const prop = mesh(geometry(`prop:${role}`, buildRoleProp(role), PROP_HAND, PROP_VOXEL, false), meshes, voxelMaterial());
  prop.position.set(model.hand[0] * VOXEL, model.hand[1] * VOXEL, (model.hand[2] + 1.5) * VOXEL);
  prop.scale.setScalar(0.8);
  armR.add(prop);

  // 表情贴片：眼睛 / 嘴各一组，按状态切换显隐。
  let setFace: CharacterRig["setFace"];
  if (model.face !== undefined) {
    const face = model.face;
    const eyes = new Map<string, THREE.Mesh>();
    const mouths = new Map<string, THREE.Mesh>();
    const decalMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    for (const [name, decal] of Object.entries(face.eyes)) {
      const m = new THREE.Mesh(geometry(`${key}:eyes:${name}`, decal, neckAt), decalMaterial);
      m.visible = false;
      head.add(m);
      eyes.set(name, m);
    }
    for (const [name, decal] of Object.entries(face.mouth)) {
      const m = new THREE.Mesh(geometry(`${key}:mouth:${name}`, decal, neckAt), decalMaterial);
      m.visible = false;
      head.add(m);
      mouths.set(name, m);
    }
    setFace = (eyeState, mouthState) => {
      for (const [name, m] of eyes) m.visible = name === eyeState;
      for (const [name, m] of mouths) m.visible = name === mouthState;
    };
  }

  const height = (model.height + 1) * VOXEL;
  let halo: THREE.Object3D | undefined;
  if (role === "lead") {
    const m = new THREE.Mesh(
      geometry("halo", buildHalo(), [0, 0, 0], PROP_VOXEL),
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#6a4a08") }),
    );
    m.position.set(0, height + 0.32, 0);
    m.userData.baseY = m.position.y;
    body.add(m);
    halo = m;
  }

  let sparkles: THREE.Group | undefined;
  if (vendor === "other") {
    // 未知模型：身边漂浮的「？」
    sparkles = new THREE.Group();
    for (let i = 0; i < 3; i += 1) {
      const m = new THREE.Mesh(
        geometry("question", buildQuestion(), [0, 0, 0], PROP_VOXEL),
        new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#1f7a72") }),
      );
      m.userData.phase = (i / 3) * Math.PI * 2;
      m.scale.setScalar(0.8);
      sparkles.add(m);
    }
    sparkles.position.y = height * 0.72;
    body.add(sparkles);
  }
  if (vendor === "gemini") {
    sparkles = new THREE.Group();
    ["#8fd3ff", "#f3a6ff", "#ffe08a"].forEach((color, i) => {
      const m = new THREE.Mesh(
        geometry(`sparkle:${i}`, buildSparkle(color), [0, 0, 0], PROP_VOXEL),
        new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#404070") }),
      );
      m.userData.phase = (i / 3) * Math.PI * 2;
      sparkles!.add(m);
    });
    sparkles.position.y = height * 0.72;
    body.add(sparkles);
  }

  const empty = () => new THREE.Group();
  return {
    root,
    body,
    head,
    armL,
    armR,
    legL: legs[0]!,
    legR: legs[1]!,
    heldR: prop,
    halo,
    sparkles,
    upper,
    lower,
    setFace,
    meshes,
    height: height * scale,
    hipHeight: model.hip * VOXEL * scale,
    tier,
  };
}
