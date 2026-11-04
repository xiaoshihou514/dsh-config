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
import { PROP_HAND, PROP_VOXEL, buildHalo, buildRoleProp, buildSparkle } from "./props.ts";
import { SPRITES, SPRITE_ALPHABET, type SpriteSheet } from "./sprites.generated.ts";
import { Voxels, voxelMaterial } from "./voxel.ts";

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
  readonly cells: { head: Map<string, string>; upper: Map<string, string>; lower: Map<string, string>; legL: Map<string, string>; legR: Map<string, string> };
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
}

interface Model {
  readonly parts: { upper: Voxels; head: Voxels; lower: Voxels; legL: Voxels; legR: Voxels };
  readonly height: number;
  readonly neck: number;
  readonly hip: number;
  readonly hem: number;
  readonly legX: number;
  readonly hand: [number, number, number];
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

  const cells = { head: new Map<string, string>(), upper: new Map<string, string>(), lower: new Map<string, string>(), legL: new Map<string, string>(), legR: new Map<string, string>() };
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
        part.set(`${x},${y},${z}`, colorAt(x, y, z));
      }

  const legCols = F[H - 1]!.flatMap((c, i) => (c === null ? [] : [Math.abs(i - cxF)]));
  const legX = legCols.length === 0 ? 2 : Math.max(1, Math.round(Math.max(...legCols) / 2));
  const base: Base = { cells, height: H, width: W, neck, hip, hem, legX, frontZ, front: F, cxF };
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
  const toVoxels = (m: Map<string, string>) => {
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

  // 手：正视图中段 +x 侧最外的皮肤像素。
  let hand: [number, number, number] = [Math.round(W * 0.3), Math.round(H * 0.38), 1];
  let best = -Infinity;
  for (let row = Math.round(H * 0.4); row < Math.round(H * 0.78); row += 1)
    F[row]!.forEach((color, c) => {
      const x = c - cxF;
      if (color !== null && x > 0 && isSkin(color) && x > best) {
        best = x;
        hand = [x, H - 1 - row, Math.max(0, frontAt(x, H - 1 - row))];
      }
    });

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

  const model: Model = { parts, height: H, neck: base.neck, hip: base.hip, hem: base.hem, legX: base.legX, hand };
  modelCache.set(key, model);
  return model;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();
function geometry(
  key: string,
  voxels: Voxels,
  pivot: readonly [number, number, number],
  size = VOXEL,
  flat = true,
): THREE.BufferGeometry {
  let g = geometryCache.get(key);
  if (g === undefined) {
    g = voxels.geometry(size, pivot, flat);
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

  const hipAt: [number, number, number] = [0, model.hip, 0];
  const lower = joint(body, hipAt, origin);
  lower.add(mesh(geometry(`${key}:lower`, model.parts.lower, hipAt), meshes));
  const upper = joint(body, hipAt, origin);
  upper.add(mesh(geometry(`${key}:upper`, model.parts.upper, hipAt), meshes));

  const neckAt: [number, number, number] = [0, model.neck, 0];
  const head = joint(upper, neckAt, hipAt);
  head.add(mesh(geometry(`${key}:head`, model.parts.head, neckAt), meshes));

  const legs = ([-1, 1] as const).map((s) => {
    const at: [number, number, number] = [s * model.legX, model.hem, 0];
    const leg = joint(lower, at, hipAt);
    const voxels = s < 0 ? model.parts.legL : model.parts.legR;
    if (voxels.size > 0) leg.add(mesh(geometry(`${key}:leg${s}`, voxels, at), meshes));
    return leg;
  });

  // 岗位道具：握持点对准右手
  const prop = mesh(geometry(`prop:${role}`, buildRoleProp(role), PROP_HAND, PROP_VOXEL, false), meshes, voxelMaterial());
  prop.position.set(model.hand[0] * VOXEL, (model.hand[1] - model.hip) * VOXEL, (model.hand[2] + 1) * VOXEL);
  prop.scale.setScalar(0.85);
  upper.add(prop);

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
    armL: empty(),
    armR: empty(),
    legL: legs[0]!,
    legR: legs[1]!,
    heldR: prop,
    halo,
    sparkles,
    upper,
    lower,
    meshes,
    height: height * scale,
    hipHeight: model.hip * VOXEL * scale,
    tier,
  };
}
