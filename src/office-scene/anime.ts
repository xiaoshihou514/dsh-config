/**
 * 网格版角色：依据人设立绘手工还原的二头身手办风格。
 *
 * - 头：下巴收窄的圆头 + 贴在脸前的动漫五官贴图（canvas 绘制）。
 * - 头发：发顶罩 + 后脑罩 + 一缕缕尖刘海与鬓发 + 挂在身上的长发束（扫掠体）。
 * - 身体：旋转体躯干与钟形裙（径向褶皱、荷叶边衬裙、前片 / 侧片按角度着色），
 *   胶囊四肢、泡泡袖、鞋子；耳 / 角 / 尾 / 翼 / 头饰按人设单独建模。
 * - 材质：三阶卡通着色 + 背面外扩描边。
 *
 * 关节：body ⊃ torso ⊃ head / armL / armR，body ⊃ skirt / legL / legR / tail / wings。
 * 角色面朝 +z，+x 为右手侧（岗位道具），-x 侧拿人设物品、戴袖章。
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ROLE_COLOR } from "../office/classify.ts";
import type { RoleKind, Tier, Vendor } from "../office/types.ts";
import { PERSONAS, type Persona } from "./personas.ts";
import { PROP_HAND, PROP_VOXEL, buildHalo, buildQuestion, buildRoleProp, buildSparkle } from "./props.ts";

export interface CharacterRig {
  readonly root: THREE.Group;
  readonly body: THREE.Group;
  readonly head: THREE.Object3D;
  readonly armL: THREE.Group;
  readonly armR: THREE.Group;
  readonly legL: THREE.Group;
  readonly legR: THREE.Group;
  readonly skirt?: THREE.Group | undefined;
  readonly tail?: THREE.Group | undefined;
  readonly wings?: THREE.Group | undefined;
  readonly heldL?: THREE.Object3D | undefined;
  readonly heldR?: THREE.Object3D | undefined;
  readonly halo?: THREE.Object3D | undefined;
  readonly sparkles?: THREE.Group | undefined;
  /** 像素画体素角色：髋以上 / 以下两段（手臂不单独拆分，动作靠上身摆动）。 */
  readonly upper?: THREE.Object3D | undefined;
  readonly lower?: THREE.Object3D | undefined;
  /** 切换表情（眼睛 / 嘴）；不支持的角色缺省。 */
  readonly setFace?: ((eyes: "open" | "closed" | "happy" | "half", mouth: "none" | "open" | "smile" | "small") => void) | undefined;
  /** 可点选、可整体置灰的网格（不含描边）。 */
  readonly meshes: THREE.Mesh[];
  readonly height: number;
  readonly hipHeight: number;
  readonly tier: Tier;
}

// ---------------------------------------------------------------- 尺寸（旗舰，世界单位）

const HIP = 0.92;
const WAIST = 1.12;
const SHOULDER_Y = 1.4;
const SHOULDER_X = 0.235;
const NECK = 1.46;
const R = 0.56; // 头半径
const HEAD_C = new THREE.Vector3(0, 1.98, 0);
const HEAD_SCALE = new THREE.Vector3(1.05, 0.97, 0.95);
const VOXEL_TO_WORLD = 0.0425; // personas.hairLength 用的是旧体素 y

const WHITE = "#ffffff";
const GOLD = "#e3b546";
const OUTLINE = "#2b2233";

// ---------------------------------------------------------------- 材质

let gradient: THREE.DataTexture | undefined;
function gradientMap(): THREE.DataTexture {
  if (gradient === undefined) {
    gradient = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return gradient;
}

const materials = new Map<string, THREE.Material>();
function toon(double = false): THREE.MeshToonMaterial {
  const key = `toon:${double}`;
  let m = materials.get(key) as THREE.MeshToonMaterial | undefined;
  if (m === undefined) {
    m = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: gradientMap(),
      side: double ? THREE.DoubleSide : THREE.FrontSide,
    });
    materials.set(key, m);
  }
  return m;
}

function outlineMaterial(width: number): THREE.MeshBasicMaterial {
  const key = `outline:${width}`;
  let m = materials.get(key) as THREE.MeshBasicMaterial | undefined;
  if (m === undefined) {
    m = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `vec3 transformed = vec3(position) + normalize(normal) * ${width.toFixed(4)};`,
      );
    };
    m.customProgramCacheKey = () => `outline-${width}`;
    materials.set(key, m);
  }
  return m;
}

function emissive(color: string, glow: string): THREE.MeshToonMaterial {
  const key = `emissive:${color}:${glow}`;
  let m = materials.get(key) as THREE.MeshToonMaterial | undefined;
  if (m === undefined) {
    m = new THREE.MeshToonMaterial({ color, emissive: new THREE.Color(glow), gradientMap: gradientMap() });
    materials.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------- 几何工具

type ColorFn = (p: THREE.Vector3, i: number) => string;

const colorCache = new Map<string, THREE.Color>();
function rgb(hex: string): THREE.Color {
  let c = colorCache.get(hex);
  if (c === undefined) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

function mix(a: string, b: string, t: number): string {
  return `#${rgb(a).clone().lerp(rgb(b), Math.min(1, Math.max(0, t))).getHexString()}`;
}

function shade(color: string, f: number): string {
  const c = rgb(color);
  return `#${new THREE.Color(Math.min(1, c.r * f), Math.min(1, c.g * f), Math.min(1, c.b * f)).getHexString()}`;
}

/** 给几何体写顶点色（按位置计算）。 */
function paint(geometry: THREE.BufferGeometry, color: string | ColorFn): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    p.fromBufferAttribute(pos, i);
    const c = rgb(typeof color === "string" ? color : color(p, i));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function ellipsoid(rx: number, ry: number, rz: number, at: THREE.Vector3, color: string | ColorFn, seg = 16): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.75)));
  g.scale(rx, ry, rz);
  g.translate(at.x, at.y, at.z);
  return paint(g, color);
}

/**
 * 扫掠体：沿曲线放椭圆截面（宽 × 厚），端部收尖。宽度方向与 `outward` 垂直，
 * 厚度方向朝外——用于发片、发束、尾巴、角。
 */
function sweep(
  points: readonly THREE.Vector3[],
  opts: {
    width: (t: number) => number;
    thick: (t: number) => number;
    outward: (p: THREE.Vector3, t: number) => THREE.Vector3;
    color: (t: number, k: number) => string;
    steps?: number;
    sides?: number;
  },
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points as THREE.Vector3[], false, "centripetal");
  const steps = opts.steps ?? 20;
  const sides = opts.sides ?? 8;
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const W = new THREE.Vector3();
  const N = new THREE.Vector3();
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = curve.getPointAt(t);
    const T = curve.getTangentAt(t);
    const O = opts.outward(p, t).normalize();
    W.crossVectors(T, O);
    if (W.lengthSq() < 1e-6) W.set(1, 0, 0);
    W.normalize();
    N.crossVectors(W, T).normalize();
    const w = Math.max(0.0005, opts.width(t));
    const h = Math.max(0.0005, opts.thick(t));
    for (let k = 0; k < sides; k += 1) {
      const a = (k / sides) * Math.PI * 2;
      const x = p.x + W.x * Math.cos(a) * w + N.x * Math.sin(a) * h;
      const y = p.y + W.y * Math.cos(a) * w + N.y * Math.sin(a) * h;
      const z = p.z + W.z * Math.cos(a) * w + N.z * Math.sin(a) * h;
      positions.push(x, y, z);
      const c = rgb(opts.color(t, k));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < steps; i += 1)
    for (let k = 0; k < sides; k += 1) {
      const a = i * sides + k;
      const b = i * sides + ((k + 1) % sides);
      const c = (i + 1) * sides + k;
      const d = (i + 1) * sides + ((k + 1) % sides);
      index.push(a, c, b, b, c, d);
    }
  // 两端封口
  for (const [ring, flip] of [
    [0, true],
    [steps, false],
  ] as const) {
    const center = positions.length / 3;
    const p = curve.getPointAt(ring / steps);
    positions.push(p.x, p.y, p.z);
    const c = rgb(opts.color(ring / steps, 0));
    colors.push(c.r, c.g, c.b);
    for (let k = 0; k < sides; k += 1) {
      const a = ring * sides + k;
      const b = ring * sides + ((k + 1) % sides);
      if (flip) index.push(center, a, b);
      else index.push(center, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** 旋转体（绕 y 轴），profile 为 [半径, y]；可按角度裁掉前方开口、加径向褶皱、压扁 z。 */
function lathe(
  profile: readonly [number, number][],
  opts: {
    segments?: number;
    zScale?: number;
    open?: number; // 前方开口半角（弧度）
    folds?: { count: number; amp: (t: number) => number };
    color: (angle: number, t: number, y: number) => string;
  },
): THREE.BufferGeometry {
  const segments = opts.segments ?? 48;
  const open = opts.open ?? 0;
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const rows = profile.length;
  const cols = segments + 1;
  const y0 = profile[0]![1];
  const y1 = profile[rows - 1]![1];
  for (let r = 0; r < rows; r += 1) {
    const [radius, y] = profile[r]!;
    const t = (y - y0) / (y1 - y0 || 1);
    for (let s = 0; s < cols; s += 1) {
      // angle 0 = 正前方（+z），开口时从 open 扫到 2π - open
      const angle = open + (s / segments) * (Math.PI * 2 - open * 2);
      const fold = opts.folds ? 1 + Math.sin(angle * opts.folds.count) * opts.folds.amp(t) : 1;
      const rr = radius * fold;
      positions.push(Math.sin(angle) * rr, y, Math.cos(angle) * rr * (opts.zScale ?? 1));
      const c = rgb(opts.color(angle > Math.PI ? angle - Math.PI * 2 : angle, t, y));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let r = 0; r < rows - 1; r += 1)
    for (let s = 0; s < segments; s += 1) {
      const a = r * cols + s;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function deformHead(g: THREE.BufferGeometry, radius: number, chin = true): THREE.BufferGeometry {
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i) * HEAD_SCALE.x;
    const y = pos.getY(i) * HEAD_SCALE.y;
    let z = pos.getZ(i) * HEAD_SCALE.z;
    if (chin && y < 0) {
      const s = Math.min(1, -y / radius) ** 1.6;
      x *= 1 - 0.3 * s;
      z *= 1 - 0.12 * s;
    }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/** 头部局部坐标（以头心为原点、未缩放）上的球面点。phi：0 = 正前方，+ 为角色左侧（+x）。 */
function onHead(phi: number, theta: number, radius: number): THREE.Vector3 {
  const v = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(theta), Math.cos(phi) * Math.sin(theta)).multiplyScalar(radius);
  v.x *= HEAD_SCALE.x;
  v.y *= HEAD_SCALE.y;
  v.z *= HEAD_SCALE.z;
  return v.add(HEAD_C);
}

const fromHead = (p: THREE.Vector3) => p.clone().sub(HEAD_C);
const fromAxis = (p: THREE.Vector3) => new THREE.Vector3(p.x, 0, p.z).lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(p.x, 0, p.z);

// ---------------------------------------------------------------- 脸

type Expression = "smile" | "open" | "grin" | "calm" | "o" | "sleepy";
const EXPRESSION: Record<Vendor, Expression> = {
  claude: "smile",
  gpt: "calm",
  deepseek: "open",
  gemini: "smile",
  glm: "sleepy",
  grok: "grin",
  kimi: "o",
  qwen: "smile",
  other: "calm",
};

const faceCache = new Map<string, THREE.CanvasTexture>();
function faceTexture(vendor: Vendor, p: Persona): THREE.CanvasTexture {
  const hit = faceCache.get(vendor);
  if (hit !== undefined) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const g = canvas.getContext("2d")!;
  const expr = EXPRESSION[vendor];
  const eyeY = 274;
  const eyeW = 47;
  const eyeH = 63;
  const lash = "#2a1f2e";
  for (const [cx, iris] of [
    [150, p.eyeL],
    [362, p.eyeR],
  ] as const) {
    const outward = cx < 256 ? -1 : 1;
    g.save();
    // 眼白
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.ellipse(cx, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
    g.fill();
    // 虹膜：上深下浅
    const grad = g.createLinearGradient(0, eyeY - eyeH, 0, eyeY + eyeH);
    grad.addColorStop(0, shade(iris, 0.45));
    grad.addColorStop(0.45, iris);
    grad.addColorStop(1, mix(iris, WHITE, 0.55));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(cx, eyeY + 4, eyeW * 0.86, eyeH * 0.92, 0, 0, Math.PI * 2);
    g.fill();
    // 瞳孔
    g.fillStyle = shade(iris, 0.3);
    g.beginPath();
    g.ellipse(cx, eyeY - 2, eyeW * 0.36, eyeH * 0.42, 0, 0, Math.PI * 2);
    g.fill();
    // 高光
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.ellipse(cx - outward * 12 - 4, eyeY - 18, 13, 16, 0.3, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(cx + outward * 10, eyeY + 22, 6, 5, 0, 0, Math.PI * 2);
    g.fill();
    if (expr === "sleepy") {
      // 半垂的眼皮
      g.fillStyle = p.skin;
      g.beginPath();
      g.ellipse(cx, eyeY - eyeH * 0.55, eyeW * 1.15, eyeH * 0.62, 0, 0, Math.PI * 2);
      g.fill();
    }
    // 上睫毛：粗弧 + 外眼角上挑
    g.strokeStyle = lash;
    g.lineCap = "round";
    g.lineWidth = 11;
    const lidY = expr === "sleepy" ? eyeY - eyeH * 0.08 : eyeY - eyeH * 0.92;
    g.beginPath();
    g.moveTo(cx - outward * eyeW * 0.95, lidY + 16);
    g.quadraticCurveTo(cx, lidY - 12, cx + outward * eyeW * 1.05, lidY + 6);
    g.lineTo(cx + outward * eyeW * 1.35, lidY - 4);
    g.stroke();
    // 下睫毛
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - eyeW * 0.4, eyeY + eyeH * 0.98);
    g.lineTo(cx + eyeW * 0.4, eyeY + eyeH * 0.98);
    g.stroke();
    // 眉毛
    g.strokeStyle = shade(p.hairShade, 0.8);
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(cx - eyeW * 0.8, eyeY - eyeH - 34);
    g.quadraticCurveTo(cx, eyeY - eyeH - 44, cx + eyeW * 0.8, eyeY - eyeH - 36);
    g.stroke();
    // 腮红
    g.fillStyle = "rgba(255,140,150,0.35)";
    g.beginPath();
    g.ellipse(cx + outward * 22, eyeY + eyeH + 34, 38, 16, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(240,110,125,0.55)";
    g.lineWidth = 3;
    for (let k = -1; k <= 1; k += 1) {
      g.beginPath();
      g.moveTo(cx + outward * 22 + k * 12 - 4, eyeY + eyeH + 40);
      g.lineTo(cx + outward * 22 + k * 12 + 4, eyeY + eyeH + 28);
      g.stroke();
    }
    g.restore();
  }
  // 嘴：很小，按人设表情
  const my = 432;
  g.lineCap = "round";
  g.strokeStyle = "#8a3a46";
  g.fillStyle = "#b8485a";
  g.lineWidth = 4;
  switch (expr) {
    case "open":
    case "grin":
      g.beginPath();
      g.moveTo(240, my - 6);
      g.quadraticCurveTo(256, my - 2, 272, my - 6);
      g.quadraticCurveTo(268, my + 18, 256, my + 20);
      g.quadraticCurveTo(244, my + 18, 240, my - 6);
      g.fill();
      g.fillStyle = "#f08a9a";
      g.beginPath();
      g.ellipse(256, my + 12, 9, 5, 0, 0, Math.PI * 2);
      g.fill();
      if (expr === "grin") {
        g.fillStyle = "#ffffff";
        g.beginPath();
        g.moveTo(262, my - 5);
        g.lineTo(270, my - 6);
        g.lineTo(266, my + 4);
        g.fill();
      }
      break;
    case "o":
      g.beginPath();
      g.ellipse(256, my + 4, 6, 7, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case "smile":
      g.beginPath();
      g.moveTo(244, my);
      g.quadraticCurveTo(256, my + 10, 268, my);
      g.stroke();
      break;
    default:
      g.beginPath();
      g.moveTo(249, my + 2);
      g.lineTo(263, my + 2);
      g.stroke();
      break;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  faceCache.set(vendor, texture);
  return texture;
}

// ---------------------------------------------------------------- 构建

interface Builder {
  readonly p: Persona;
  readonly vendor: Vendor;
  readonly fast: boolean;
  readonly meshes: THREE.Mesh[];
}

function addMesh(
  b: Builder,
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  pivot: THREE.Vector3,
  opts: { outline?: number; double?: boolean; material?: THREE.Material; pick?: boolean } = {},
): THREE.Mesh {
  const g = geometry.clone();
  g.translate(-pivot.x, -pivot.y, -pivot.z);
  const mesh = new THREE.Mesh(g, opts.material ?? toon(opts.double ?? false));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.material = mesh.material;
  parent.add(mesh);
  if (opts.pick !== false) b.meshes.push(mesh);
  if ((opts.outline ?? 0.012) > 0) {
    const line = new THREE.Mesh(g, outlineMaterial(opts.outline ?? 0.012));
    line.userData.outline = true;
    parent.add(line);
  }
  return mesh;
}

/** 合并多个部件：统一成非索引、只保留位置 / 法线 / 顶点色。 */
function merged(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    if (g.getAttribute("normal") === undefined) g.computeVertexNormals();
    const n = g.index === null ? g : g.toNonIndexed();
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", n.getAttribute("position"));
    out.setAttribute("normal", n.getAttribute("normal"));
    out.setAttribute("color", n.getAttribute("color"));
    return out;
  });
  return mergeGeometries(clean, false)!;
}

// ---- 头

function buildHead(b: Builder, head: THREE.Group, pivot: THREE.Vector3): void {
  const { p } = b;
  // 头
  const skull = deformHead(new THREE.SphereGeometry(R, 40, 32), R);
  skull.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  addMesh(b, head, paint(skull, p.skin), pivot);
  // 脸贴图
  const faceGeo = deformHead(new THREE.SphereGeometry(R * 1.008, 32, 24, Math.PI / 2 - 0.9, 1.8, 0.75, 1.5), R);
  // SphereGeometry 的 phi 从 -x 起算：贴图左侧落在 -x（观者左侧）。
  faceGeo.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  const faceMat = new THREE.MeshToonMaterial({
    map: faceTexture(b.vendor, p),
    transparent: true,
    gradientMap: gradientMap(),
    depthWrite: false,
  });
  const face = addMesh(b, head, faceGeo, pivot, { outline: 0, material: faceMat });
  face.renderOrder = 1;
  // 脖子
  const neck = new THREE.CylinderGeometry(0.06, 0.07, 0.14, 12);
  neck.translate(0, NECK + 0.02, 0);
  addMesh(b, head, paint(neck, p.skin), pivot, { outline: 0 });

  buildHair(b, head, pivot);
  buildEars(b, head, pivot);
  buildHeadwear(b, head, pivot);
}

function hairColor(p: Persona, t: number, i: number): string {
  let c = mix(p.hair, p.hairTip ?? p.hair, Math.min(1, t ** 1.3));
  if (i % 2 === 1) c = shade(c, 0.93);
  if (p.hairStreak !== undefined && i % 3 === 0 && t > 0.3) c = mix(p.hairStreak, p.hairTip ?? p.hairStreak, t);
  return c;
}

function buildHair(b: Builder, head: THREE.Group, pivot: THREE.Vector3): void {
  const { p } = b;
  const shell = R * 1.09;
  const parts: THREE.BufferGeometry[] = [];
  // 发顶罩
  const crown = deformHead(new THREE.SphereGeometry(shell, 40, 18, 0, Math.PI * 2, 0, 1.12), shell, false);
  crown.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  parts.push(paint(crown, p.hair));
  // 后脑罩（前方留出脸）
  const back = deformHead(new THREE.SphereGeometry(shell, 40, 20, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 1.0, 1.6), shell);
  back.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  parts.push(paint(back, shade(p.hair, 0.95)));

  // 尖刘海：一缕缕从头顶贴着额头垂下
  const bangs = 9;
  for (let i = 0; i < bangs; i += 1) {
    const u = -1 + (2 * i) / (bangs - 1);
    const phi = u * 0.88;
    const tipTheta = 1.32 + 0.12 * Math.cos(u * Math.PI * 1.5) - 0.08 * Math.abs(u);
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 6; k += 1) {
      const t = k / 6;
      const theta = 0.35 + (tipTheta - 0.35) * t;
      const ph = phi * (1 - 0.25 * t * t);
      pts.push(onHead(ph, theta, R * (1.1 + 0.02 * Math.sin(t * Math.PI))));
    }
    parts.push(
      sweep(pts, {
        width: (t) => R * 0.2 * (1 - t) ** 0.65 + R * 0.01,
        thick: (t) => R * 0.06 * (1 - t * 0.6),
        outward: (q) => fromHead(q),
        color: (t) => hairColor(p, t * 0.15, i),
        steps: 12,
      }),
    );
  }
  // 鬓发：脸侧垂到肩前
  for (const s of [-1, 1] as const) {
    const pts = [
      onHead(s * 0.92, 0.75, R * 1.08),
      onHead(s * 1.0, 1.35, R * 1.08),
      onHead(s * 1.02, 1.85, R * 1.06),
      new THREE.Vector3(s * R * 0.72, NECK - (b.fast ? 0.02 : 0.1), R * 0.35),
      new THREE.Vector3(s * R * 0.7, NECK - (b.fast ? 0.12 : 0.3), R * 0.32),
    ];
    parts.push(
      sweep(pts, {
        width: (t) => R * (0.17 - 0.1 * t),
        thick: (t) => R * (0.07 - 0.03 * t),
        outward: (q) => (q.y > NECK ? fromHead(q) : fromAxis(q)),
        color: (t) => hairColor(p, t * 0.6, 1),
      }),
    );
  }
  // 呆毛
  if (p.ahoge === true) {
    const top = onHead(0, 0.05, R * 1.08);
    parts.push(
      sweep(
        [top, top.clone().add(new THREE.Vector3(0.02, 0.1, 0.05)), top.clone().add(new THREE.Vector3(0.09, 0.16, 0.0)), top.clone().add(new THREE.Vector3(0.08, 0.1, -0.06))],
        { width: (t) => 0.035 * (1 - t) + 0.004, thick: () => 0.015, outward: () => new THREE.Vector3(0, 0, 1), color: () => p.hair, steps: 10 },
      ),
    );
  }
  if (p.style === "buns")
    for (const s of [-1, 1] as const) parts.push(ellipsoid(0.17, 0.16, 0.16, onHead(s * 1.55, 0.6, R * 1.05), p.hair));
  if (p.style === "braid") {
    // 侧前麻花辫（角色右侧 = -x）
    const start = onHead(-0.95, 1.4, R * 1.1);
    const end = new THREE.Vector3(-R * 0.62, b.fast ? NECK - 0.15 : WAIST + 0.05, R * 0.42);
    for (let k = 0; k < 9; k += 1) {
      const t = k / 8;
      const at = start.clone().lerp(end, t);
      at.x += (k % 2 === 0 ? 1 : -1) * 0.015;
      parts.push(ellipsoid(0.055 * (1 - t * 0.3), 0.05, 0.05, at, k % 2 === 0 ? p.hair : p.hairShade, 10));
    }
    parts.push(ellipsoid(0.04, 0.03, 0.04, end.clone().add(new THREE.Vector3(0, -0.05, 0)), p.accent, 8));
  }
  if (b.fast) {
    // 快速档：刘海上的黄色闪电发夹
    const at = onHead(-0.55, 0.85, R * 1.17);
    const zig = new THREE.Shape();
    zig.moveTo(0, 0.07).lineTo(0.035, 0.07).lineTo(0.01, 0.02).lineTo(0.04, 0.02).lineTo(-0.02, -0.07).lineTo(0.0, -0.01).lineTo(-0.03, -0.01).closePath();
    const zg = new THREE.ExtrudeGeometry(zig, { depth: 0.015, bevelEnabled: false });
    zg.rotateY(-0.5);
    zg.translate(at.x, at.y, at.z);
    parts.push(paint(zg, "#ffd23f"));
  }
  addMesh(b, head, merged(parts), pivot, { outline: 0.01, double: true });
}

function buildLongHair(b: Builder, torso: THREE.Group, pivot: THREE.Vector3): void {
  const { p } = b;
  const parts: THREE.BufferGeometry[] = [];
  const bottomY = b.fast
    ? WAIST + 0.08
    : p.style === "twintails"
      ? NECK - 0.15
      : Math.max(0.12, (p.hairLength ?? 14) * VOXEL_TO_WORLD + 0.05);
  const amp = (p.wave ?? 1.6) * 0.04;
  const curly = (p.wave ?? 1.6) > 1;
  const spread = b.fast ? 0.07 : curly ? 0.32 : 0.18;
  // 背后的底层发片，填补发束之间的空隙
  parts.push(
    lathe(
      [
        [R * 0.9, Math.max(bottomY + 0.1, 0.2)],
        [R * 0.9, (HEAD_C.y + bottomY) / 2],
        [R * 0.92, HEAD_C.y - R * 0.2],
      ] as [number, number][],
      { segments: 32, open: 1.4, zScale: 0.75, color: (_a, t) => shade(mix(p.hair, p.hairTip ?? p.hair, 1 - t), 0.82) },
    ),
  );
  if (p.style === "twintails") {
    for (const s of [-1, 1] as const)
      for (let j = 0; j < 3; j += 1) {
        const pts: THREE.Vector3[] = [];
        const tailBottom = b.fast ? WAIST : 0.42;
        for (let k = 0; k <= 10; k += 1) {
          const t = k / 10;
          const swirl = t * Math.PI * 3 + (j * Math.PI * 2) / 3;
          pts.push(
            new THREE.Vector3(
              s * (R * 1.05 + 0.04 + Math.sin(t * Math.PI) * (b.fast ? 0.06 : 0.16)) + Math.cos(swirl) * 0.06,
              HEAD_C.y + R * 0.45 - t * (HEAD_C.y + R * 0.45 - tailBottom),
              -0.12 + Math.sin(swirl) * 0.06,
            ),
          );
        }
        parts.push(
          sweep(pts, {
            width: (t) => (b.fast ? 0.07 : 0.11) * (1 - t * 0.5),
            thick: (t) => (b.fast ? 0.05 : 0.08) * (1 - t * 0.4),
            outward: (q) => new THREE.Vector3(q.x, 0, q.z + 0.12),
            color: (t) => hairColor(p, t, j),
          }),
        );
      }
    addMesh(b, torso, merged(parts), pivot, { outline: 0.01, double: true });
    return;
  }
  // 一束束长发：从头后半圈与两侧垂下，向外散开、波浪、发梢内卷
  const locks = b.fast ? 11 : 16;
  const reach = 1.85;
  for (let i = 0; i < locks; i += 1) {
    const a = (-1 + (2 * i) / (locks - 1)) * reach;
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const tangent = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const rootY = HEAD_C.y - R * 0.15 - Math.abs(a) * R * 0.12;
    const lockBottom = bottomY + ((i * 7) % 3) * 0.04 + (Math.abs(a) > 1.4 ? 0.08 : 0);
    const pts: THREE.Vector3[] = [];
    const n = 8;
    for (let k = 0; k <= n; k += 1) {
      const t = k / n;
      const radial = R * (Math.abs(a) > 1.3 ? 0.98 : 0.92) + spread * t ** 1.1;
      // 波浪卷：切向摆动 + 径向起伏，越往下越明显
      const w = amp * Math.sin(t * Math.PI * 3.2 + i * 1.3) * (0.3 + t);
      const bulge = curly ? amp * 0.8 * Math.cos(t * Math.PI * 3.2 + i * 1.3) * t : 0;
      const y = rootY - t * (rootY - lockBottom);
      pts.push(dir.clone().multiplyScalar(radial + bulge).add(tangent.clone().multiplyScalar(w)).setY(y));
    }
    const last = pts[n]!;
    // 发梢内卷
    pts.push(last.clone().add(dir.clone().multiplyScalar(curly ? -0.06 : -0.03)).add(new THREE.Vector3(0, curly ? 0.07 : 0.03, 0)));
    parts.push(
      sweep(pts, {
        width: (t) => R * (b.fast ? 0.24 : curly ? 0.34 : 0.3) * (1 - t * 0.5),
        thick: (t) => R * (b.fast ? 0.1 : curly ? 0.16 : 0.12) * (1 - t * 0.4),
        outward: (q) => fromAxis(q),
        color: (t) => hairColor(p, t, i),
        steps: 18,
      }),
    );
  }
  addMesh(b, torso, merged(parts), pivot, { outline: 0.01, double: true });
}

function cone(radius: number, height: number, color: string, inner?: string): THREE.BufferGeometry {
  const outer = paint(new THREE.ConeGeometry(radius, height, 4, 1), color);
  outer.scale(1, 1, 0.45);
  if (inner === undefined) return outer;
  const inn = paint(new THREE.ConeGeometry(radius * 0.6, height * 0.75, 4, 1), inner);
  inn.scale(1, 1, 0.3);
  inn.translate(0, -height * 0.08, radius * 0.18);
  return merged([outer.toNonIndexed(), inn.toNonIndexed()]);
}

function placed(g: THREE.BufferGeometry, at: THREE.Vector3, rot: THREE.Euler): THREE.BufferGeometry {
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(at.x, at.y, at.z);
  return g;
}

function buildEars(b: Builder, head: THREE.Group, pivot: THREE.Vector3): void {
  const { p } = b;
  const parts: THREE.BufferGeometry[] = [];
  const ear = p.earColor ?? p.hair;
  const inner = p.earInner ?? p.skin;
  for (const s of [-1, 1] as const) {
    switch (p.ears) {
      case "cat":
        parts.push(placed(cone(0.12, 0.24, ear, inner), onHead(s * 0.62, 0.42, R * 1.12), new THREE.Euler(0, 0, -s * 0.35)));
        break;
      case "fox":
        parts.push(placed(cone(0.15, 0.32, ear, inner), onHead(s * 0.6, 0.45, R * 1.12), new THREE.Euler(0, 0, -s * 0.4)));
        break;
      case "foxSide":
        parts.push(placed(cone(0.21, 0.5, ear, inner), onHead(s * 1.05, 0.55, R * 1.18), new THREE.Euler(0, 0, -s * 1.2)));
        break;
      case "fin":
        parts.push(placed(cone(0.11, 0.3, ear, inner), onHead(s * 1.45, 1.45, R * 1.08), new THREE.Euler(0.1, 0, -s * 2.0)));
        break;
      case "elf":
        parts.push(placed(paint(new THREE.ConeGeometry(0.045, 0.2, 6), p.skin), onHead(s * 1.5, 1.55, R * 1.02), new THREE.Euler(0, 0, -s * 1.25)));
        break;
      default:
        break;
    }
    if (p.horns !== undefined) {
      const base = onHead(s * 0.55, 0.38, R * 1.05);
      const k = b.fast ? 0.6 : 1;
      const pts = [
        base,
        base.clone().add(new THREE.Vector3(s * 0.1 * k, 0.1 * k, -0.04)),
        base.clone().add(new THREE.Vector3(s * 0.24 * k, 0.16 * k, -0.08)),
        base.clone().add(new THREE.Vector3(s * 0.34 * k, 0.3 * k, -0.07)),
        base.clone().add(new THREE.Vector3(s * 0.3 * k, 0.44 * k, -0.02)),
      ];
      parts.push(
        sweep(pts, {
          width: (t) => 0.1 * k * (1 - t * 0.85),
          thick: (t) => 0.1 * k * (1 - t * 0.85),
          outward: (q) => fromHead(q),
          color: (t, kk) => (t > 0.8 ? shade(p.horns!, 0.85) : Math.floor(t * 9) % 2 === 0 && kk % 2 === 0 ? shade(p.horns!, 0.92) : p.horns!),
          sides: 10,
        }),
      );
    }
  }
  if (parts.length > 0) addMesh(b, head, merged(parts), pivot, { outline: 0.008 });
}

function bow(at: THREE.Vector3, size: number, color: string, facing: THREE.Euler = new THREE.Euler()): THREE.BufferGeometry {
  const parts = [
    ellipsoid(size, size * 0.65, size * 0.35, new THREE.Vector3(-size * 0.85, 0, 0), color, 12),
    ellipsoid(size, size * 0.65, size * 0.35, new THREE.Vector3(size * 0.85, 0, 0), color, 12),
    ellipsoid(size * 0.32, size * 0.32, size * 0.3, new THREE.Vector3(0, 0, size * 0.05), shade(color, 0.75), 10),
  ];
  return placed(merged(parts), at, facing);
}

function buildHeadwear(b: Builder, head: THREE.Group, pivot: THREE.Vector3): void {
  const { p } = b;
  const parts: THREE.BufferGeometry[] = [];
  const color = p.headwearColor ?? WHITE;
  const maidBand = (big: boolean) => {
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k += 1) pts.push(onHead(-1.25 + k * 0.25, 0.62, R * 1.14));
    parts.push(
      sweep(pts, {
        width: () => R * 0.05,
        thick: () => R * (big ? 0.12 : 0.09),
        outward: () => new THREE.Vector3(0, 1, 0),
        color: () => color,
      }),
    );
    for (let k = 0; k <= 12; k += 1)
      parts.push(ellipsoid(R * (big ? 0.1 : 0.08), R * (big ? 0.1 : 0.08), R * 0.05, onHead(-1.2 + k * 0.2, 0.5, R * 1.16), k % 2 ? shade(color, 0.92) : color, 8));
  };
  switch (p.headwear) {
    case "maid":
      maidBand(false);
      parts.push(bow(onHead(1.1, 0.95, R * 1.15), 0.08, p.ornament ?? p.accent, new THREE.Euler(0, 1.1, 0.2)));
      break;
    case "prism": {
      maidBand(true);
      const at = onHead(1.0, 0.75, R * 1.2);
      const tri = new THREE.Shape();
      tri.moveTo(0, 0.09).lineTo(0.08, -0.05).lineTo(-0.08, -0.05).closePath();
      const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.03, bevelEnabled: false });
      tg.rotateY(1.0);
      tg.translate(at.x, at.y, at.z);
      parts.push(paint(tg, "#16161e"));
      ["#e8584f", "#f2b13c", "#4fb86b", "#4f7fe0", "#9a6cf0"].forEach((c, i) => {
        const bar = new THREE.BoxGeometry(0.16, 0.012, 0.012);
        bar.translate(at.x + 0.11, at.y + 0.01 - i * 0.012, at.z - 0.04);
        parts.push(paint(bar, c));
      });
      parts.push(bow(onHead(1.15, 1.15, R * 1.14), 0.08, p.ornament ?? p.accent, new THREE.Euler(0, 1.1, 0)));
      break;
    }
    case "crown": {
      const ring = new THREE.CylinderGeometry(0.15, 0.17, 0.06, 20, 1, true);
      ring.translate(0, HEAD_C.y + R * 0.98, -0.02);
      parts.push(paint(ring, color));
      for (let k = 0; k < 5; k += 1) {
        const a = -0.9 + k * 0.45;
        const spike = new THREE.ConeGeometry(0.025, 0.07, 4);
        spike.translate(Math.sin(a) * 0.16, HEAD_C.y + R * 0.98 + 0.06, Math.cos(a) * 0.16 - 0.02);
        parts.push(paint(spike, color));
      }
      parts.push(ellipsoid(0.03, 0.035, 0.02, new THREE.Vector3(0, HEAD_C.y + R * 0.98 + 0.01, 0.15), "#c4283c", 10));
      break;
    }
    case "beret": {
      const top = HEAD_C.y + R * 0.92;
      parts.push(ellipsoid(R * 1.05, R * 0.32, R * 0.95, new THREE.Vector3(-0.03, top, -0.04), color, 24));
      const fur = new THREE.TorusGeometry(R * 0.92, R * 0.09, 8, 32);
      fur.rotateX(Math.PI / 2);
      fur.scale(1.05, 1, 0.95);
      fur.translate(-0.03, top - R * 0.1, -0.04);
      parts.push(paint(fur, (q) => ((Math.round(q.x * 80) + Math.round(q.z * 80)) % 3 === 0 ? "#e6eaf6" : WHITE)));
      const at = onHead(-0.55, 0.45, R * 1.25);
      const badge = new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16);
      badge.rotateX(Math.PI / 2 - 0.5);
      badge.translate(at.x, at.y, at.z);
      parts.push(paint(badge, (q) => (q.distanceTo(at) > 0.045 ? GOLD : WHITE)));
      const tassel = new THREE.CylinderGeometry(0.012, 0.02, 0.16, 6);
      tassel.translate(at.x - 0.03, at.y - 0.12, at.z);
      parts.push(paint(tassel, "#7ea8f0"));
      break;
    }
    case "flower": {
      const at = onHead(1.05, 0.62, R * 1.16);
      for (let k = 0; k < 8; k += 1) {
        const a = (k / 8) * Math.PI * 2;
        parts.push(
          placed(
            ellipsoid(0.045, 0.02, 0.012, new THREE.Vector3(0.05, 0, 0), k % 2 ? shade(color, 0.85) : color, 8),
            at,
            new THREE.Euler(0, 1.05, a),
          ),
        );
      }
      parts.push(ellipsoid(0.025, 0.025, 0.02, at, "#7a3a14", 8));
      parts.push(bow(at.clone().add(new THREE.Vector3(0.02, -0.12, -0.02)), 0.06, "#2a2326", new THREE.Euler(0, 1.1, 0)));
      const tassel = new THREE.CylinderGeometry(0.012, 0.022, 0.14, 6);
      tassel.translate(at.x + 0.02, at.y - 0.24, at.z - 0.02);
      parts.push(paint(tassel, "#f2e6c8"));
      break;
    }
    case "mask": {
      maidBand(false);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k += 1) pts.push(onHead(-0.75 + k * 0.1875, 0.42, R * 1.2));
      parts.push(
        sweep(pts, {
          width: () => R * 0.03,
          thick: () => R * 0.14,
          outward: () => new THREE.Vector3(0, 1, 0.4),
          color: () => color,
        }),
      );
      for (const s of [-1, 1] as const) {
        const arc: THREE.Vector3[] = [];
        for (let k = 0; k <= 4; k += 1) arc.push(onHead(s * (0.18 + k * 0.08), 0.38 + Math.sin((k / 4) * Math.PI) * 0.04, R * 1.25));
        parts.push(sweep(arc, { width: () => 0.006, thick: () => 0.006, outward: (q) => fromHead(q), color: () => WHITE, steps: 8, sides: 4 }));
      }
      const clip = new THREE.BoxGeometry(0.03, 0.08, 0.08);
      const at = onHead(1.2, 0.9, R * 1.16);
      clip.translate(at.x, at.y, at.z);
      parts.push(paint(clip, "#1a1a22"));
      for (const dz of [-0.03, 0.03]) parts.push(ellipsoid(0.025, 0.025, 0.025, at.clone().add(new THREE.Vector3(0.01, -0.1, dz)), "#c9ced6", 8));
      break;
    }
    case "hood": {
      const hood = deformHead(new THREE.SphereGeometry(R * 1.22, 32, 20, Math.PI / 2 + 0.85, Math.PI * 2 - 1.7, 0, 2.3), R * 1.22, false);
      hood.translate(HEAD_C.x, HEAD_C.y + 0.03, HEAD_C.z - 0.03);
      parts.push(paint(hood, (q) => (q.z > 0.15 ? p.accent : color)));
      const top = onHead(0, 0.3, R * 1.2);
      parts.push(
        sweep([top, top.clone().add(new THREE.Vector3(0, 0.05, -0.2)), top.clone().add(new THREE.Vector3(0, -0.1, -0.38))], {
          width: (t) => 0.1 * (1 - t) + 0.01,
          thick: (t) => 0.1 * (1 - t) + 0.01,
          outward: () => new THREE.Vector3(0, 1, 0),
          color: (t) => (t > 0.85 ? p.accent : color),
        }),
      );
      break;
    }
    default:
      break;
  }
  if (p.headwear === null && p.ornament !== undefined) {
    // gpt：白玫瑰 + 流苏
    const at = onHead(1.05, 0.75, R * 1.16);
    parts.push(ellipsoid(0.06, 0.06, 0.04, at, p.ornament, 12));
    const tassel = new THREE.CylinderGeometry(0.012, 0.02, 0.18, 6);
    tassel.translate(at.x, at.y - 0.14, at.z);
    parts.push(paint(tassel, "#e6e2f2"));
  }
  if (p.batBows === true)
    for (const s of [-1, 1] as const) {
      const at = new THREE.Vector3(s * (R * 1.05 + 0.04), HEAD_C.y + R * 0.5, -0.12);
      parts.push(bow(at, 0.1, "#1a1416", new THREE.Euler(0, s * 1.3, 0)));
      const wing = new THREE.Shape();
      wing.moveTo(0, 0).lineTo(0.12, 0.1).lineTo(0.2, 0.05).lineTo(0.17, 0.0).lineTo(0.22, -0.04).lineTo(0.13, -0.03).lineTo(0.1, -0.08).closePath();
      const wg = new THREE.ExtrudeGeometry(wing, { depth: 0.01, bevelEnabled: false });
      if (s < 0) wg.scale(-1, 1, 1);
      wg.translate(at.x + s * 0.08, at.y + 0.04, at.z - 0.02);
      parts.push(paint(wg, "#5a1e2a"));
    }
  if (p.sparkles === true) {
    const at = onHead(1.05, 0.7, R * 1.18);
    const star = new THREE.Shape();
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      const r = k % 2 === 0 ? 0.07 : 0.02;
      if (k === 0) star.moveTo(Math.sin(a) * r, Math.cos(a) * r);
      else star.lineTo(Math.sin(a) * r, Math.cos(a) * r);
    }
    const sg = new THREE.ExtrudeGeometry(star, { depth: 0.015, bevelEnabled: false });
    sg.rotateY(1.0);
    sg.translate(at.x, at.y, at.z);
    parts.push(paint(sg, "#cfe8ff"));
  }
  if (parts.length > 0) addMesh(b, head, merged(parts), pivot, { outline: 0.006, double: true });
}

// ---- 身体

function buildTorso(b: Builder, torso: THREE.Group, pivot: THREE.Vector3, role: RoleKind): void {
  const { p, fast } = b;
  const top = fast ? p.fastTop : p.top;
  const corset = !fast && p.cape === undefined;
  const g = lathe(
    [
      [0.16, HIP + 0.04],
      [0.165, WAIST - 0.04],
      [0.15, WAIST + 0.04],
      [0.19, 1.24],
      [0.205, 1.32],
      [0.19, 1.39],
      [0.12, 1.45],
      [0.07, 1.47],
    ],
    {
      segments: 32,
      zScale: 0.78,
      color: (angle, _t, y) => {
        if (p.apronFull === true && !fast && Math.abs(angle) < 0.5 && y < 1.3) return p.apron ?? WHITE;
        if (Math.abs(angle) < 0.12 && y > 1.2) return p.headwear === "crown" ? "#c9a24a" : WHITE; // 前襟
        if (corset && y < WAIST + 0.1) return Math.abs(angle) < 0.08 ? GOLD : p.accent;
        if (fast && y < WAIST) return shade(top, 0.8);
        if (p.sparkles === true && !fast && y < 1.2) return p.skin; // gemini 露腰
        return top;
      },
    },
  );
  addMesh(b, torso, g, pivot);
  // 领结
  addMesh(b, torso, bow(new THREE.Vector3(0, 1.4, 0.16), 0.045, p.accent), pivot, { outline: 0.004 });
  // 岗位胸章
  addMesh(b, torso, ellipsoid(0.03, 0.03, 0.012, new THREE.Vector3(-0.1, 1.31, 0.15), ROLE_COLOR[role], 10), pivot, { outline: 0.004 });
  if (role === "devops") {
    const vest = lathe(
      [
        [0.2, WAIST],
        [0.215, 1.25],
        [0.2, 1.36],
      ],
      { segments: 32, zScale: 0.82, open: 0.35, color: (_a, t) => (t > 0.3 && t < 0.42 ? "#e9eef2" : "#f2a33a") },
    );
    addMesh(b, torso, vest, pivot, { double: true });
  }
  // 披肩 / 长袍 / 斗篷
  if (p.cape !== undefined && !fast) {
    const long = p.headwear !== "prism";
    const bottom = p.headwear === "beret" ? 0.2 : p.headwear === "hood" ? 0.15 : WAIST + 0.05;
    const profile: [number, number][] = long
      ? [
          [0.62, bottom],
          [0.5, 0.6],
          [0.32, 1.05],
          [0.26, 1.3],
          [0.21, 1.43],
          [0.12, 1.47],
        ]
      : [
          [0.33, bottom],
          [0.29, 1.3],
          [0.22, 1.43],
          [0.12, 1.47],
        ];
    const cape = lathe(profile, {
      segments: 48,
      zScale: 0.85,
      open: p.headwear === "hood" ? 0.3 : 0.5,
      ...(long ? { folds: { count: 7, amp: (t: number) => 0.05 * (1 - t) } } : {}),
      color: (angle, t) => {
        if (Math.abs(Math.abs(angle) - (p.headwear === "hood" ? 0.3 : 0.5)) < 0.06) return p.headwear === "hood" ? p.accent : GOLD;
        if (p.headwear === "prism" && (Math.round(angle * 9) + Math.round(t * 7)) % 9 === 0) return "#efe6b8";
        if (t < 0.05) return shade(p.cape!, 1.2);
        return p.cape!;
      },
    });
    addMesh(b, torso, cape, pivot, { double: true });
  }
}

function buildSkirt(b: Builder, skirt: THREE.Group, pivot: THREE.Vector3): void {
  const { p, fast } = b;
  const mini = fast || p.sparkles === true;
  const hem = mini ? (fast ? 0.62 : 0.66) : 0.2;
  const rTop = 0.17;
  const rHem = mini ? 0.4 : 0.6;
  const base = fast ? p.fastSkirt : p.skirt;
  const rows = 14;
  const profile: [number, number][] = [];
  for (let i = 0; i <= rows; i += 1) {
    const t = i / rows; // 0 = 下摆，1 = 腰
    const r = rTop + (rHem - rTop) * (1 - t ** 0.55);
    profile.push([r * (1 - 0.04 * Math.sin(t * Math.PI)), hem + (WAIST - hem) * t]);
  }
  const folds = { count: fast ? 8 : 10, amp: (t: number) => 0.07 * (1 - t) };
  const g = lathe(profile, {
    segments: 64,
    zScale: 0.85,
    folds,
    color: (angle, t, _y) => {
      const wave = Math.sin(angle * folds.count);
      let c = base;
      if (wave < -0.45 && t < 0.8) c = shade(base, 0.86);
      if (!fast) {
        if (t < 0.07) c = p.hem;
        if (p.skirtSide !== undefined && t > 0.07 && Math.abs(angle) > 0.62 + t * 0.2 && Math.abs(angle) < 1.35)
          c = wave < -0.45 ? shade(p.skirtSide, 0.8) : p.skirtSide;
        if (p.apron !== undefined && t > 0.07) {
          const half = p.apronFull === true ? 0.55 - t * 0.2 : 0.16;
          if (Math.abs(angle) < half) c = Math.abs(angle) > half - 0.05 ? shade(p.apron, 0.88) : p.apron;
        }
        if (p.skirtInner !== undefined && t > 0.0) {
          const open = 0.12 + (1 - t) * 0.45;
          if (Math.abs(angle) < open) c = wave < -0.45 ? shade(p.skirtInner, 0.92) : p.skirtInner;
          else if (Math.abs(angle) < open + 0.05) c = GOLD;
        }
      }
      return c;
    },
  });
  addMesh(b, skirt, g, pivot, { double: true });
  // 荷叶边衬裙
  const frillColor = fast ? WHITE : (p.skirtInner ?? WHITE);
  const frill = lathe(
    [
      [rHem * 1.04, hem - 0.05],
      [rHem * 1.0, hem + 0.02],
    ],
    {
      segments: 96,
      zScale: 0.85,
      folds: { count: 26, amp: () => 0.04 },
      color: (angle) => (Math.sin(angle * 26) > 0.4 ? shade(frillColor, 0.92) : frillColor),
    },
  );
  addMesh(b, skirt, frill, pivot, { double: true, outline: 0.006 });
  // 围裙上的小鲸鱼
  if (!fast && p.apronFull === true) {
    const whale = new THREE.Shape();
    whale.ellipse(0, 0, 0.045, 0.025, 0, Math.PI * 2, false, 0);
    const wg = new THREE.ExtrudeGeometry(whale, { depth: 0.005, bevelEnabled: false });
    wg.translate(0, hem + 0.2, rHem * 0.85 * 0.72 + 0.05);
    addMesh(b, skirt, paint(wg, "#2c4f9e"), pivot, { outline: 0 });
  }
}

function buildArm(b: Builder, arm: THREE.Group, side: -1 | 1, pivot: THREE.Vector3, role: RoleKind): void {
  const { p, fast } = b;
  const sleeve = fast ? p.fastTop : p.sleeve;
  const wide = !fast && p.headwear === "beret";
  const parts: THREE.BufferGeometry[] = [];
  const x = pivot.x;
  parts.push(ellipsoid(0.1, 0.1, 0.095, new THREE.Vector3(x, SHOULDER_Y - 0.03, 0), sleeve, 16));
  const upper = new THREE.CylinderGeometry(wide ? 0.08 : 0.058, wide ? 0.11 : 0.055, 0.28, 12);
  upper.translate(x, SHOULDER_Y - 0.18, 0);
  parts.push(
    paint(upper, (q) => {
      if (side === -1 && q.y > SHOULDER_Y - 0.17 && q.y < SHOULDER_Y - 0.12) return ROLE_COLOR[role]; // 袖章
      return sleeve;
    }),
  );
  const cuff = new THREE.TorusGeometry(wide ? 0.1 : 0.06, 0.018, 6, 16);
  cuff.rotateX(Math.PI / 2);
  cuff.translate(x, SHOULDER_Y - 0.32, 0);
  parts.push(paint(cuff, fast ? shade(sleeve, 0.85) : WHITE));
  parts.push(ellipsoid(0.05, 0.055, 0.05, new THREE.Vector3(x, SHOULDER_Y - 0.38, 0.01), p.skin, 12));
  addMesh(b, arm, merged(parts), pivot);
}

function buildLeg(b: Builder, leg: THREE.Group, side: -1 | 1, pivot: THREE.Vector3): void {
  const { p, fast } = b;
  const parts: THREE.BufferGeometry[] = [];
  const x = pivot.x;
  const len = HIP - 0.08;
  const shin = new THREE.CapsuleGeometry(0.06, len - 0.12, 4, 10);
  shin.translate(x, HIP - len / 2, 0);
  const warmers = p.sparkles === true;
  parts.push(paint(shin, (q) => (warmers && !fast && q.y > 0.45 ? p.skin : p.legwear)));
  if (warmers) {
    const fluff = new THREE.CylinderGeometry(0.09, 0.1, 0.2, 12);
    fluff.translate(x, 0.2, 0);
    parts.push(paint(fluff, (q) => (Math.round(q.y * 60) % 2 === 0 ? WHITE : "#eef0f6")));
  }
  parts.push(ellipsoid(0.075, 0.055, 0.11, new THREE.Vector3(x, 0.05, 0.03), p.shoes, 14));
  if (!fast && warmers) parts.push(ellipsoid(0.08, 0.03, 0.12, new THREE.Vector3(x, 0.015, 0.03), "#b8c4f0", 12));
  addMesh(b, leg, merged(parts), pivot);
  void side;
}

function buildTail(b: Builder, group: THREE.Group, pivot: THREE.Vector3): boolean {
  const { p } = b;
  if (p.tail === null) return false;
  const color = p.tailColor ?? p.hair;
  const tip = p.tailTip ?? color;
  const k = b.fast ? 0.65 : 1;
  const o = pivot;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(o.x + x * k, o.y + y * k, o.z + z * k);
  let g: THREE.BufferGeometry;
  switch (p.tail) {
    case "dragon": {
      const pts = [V(0, 0, 0), V(0.05, -0.25, -0.15), V(0.12, -0.6, -0.2), V(0.3, -0.78, -0.12), V(0.5, -0.74, 0.02), V(0.58, -0.58, 0.1), V(0.52, -0.48, 0.12)];
      g = sweep(pts, {
        width: (t) => 0.13 * k * (1 - t * 0.85),
        thick: (t) => 0.11 * k * (1 - t * 0.85),
        outward: () => new THREE.Vector3(0, 1, 0),
        color: (t, kk) => (t > 0.88 ? tip : (Math.floor(t * 16) + kk) % 3 === 0 ? shade(color, 0.9) : color),
        sides: 10,
        steps: 28,
      });
      break;
    }
    case "cat": {
      const pts = [V(0, 0, 0), V(0.05, -0.15, -0.15), V(0.12, -0.2, -0.3), V(0.16, -0.05, -0.42), V(0.12, 0.15, -0.45), V(0.05, 0.25, -0.38)];
      g = sweep(pts, { width: () => 0.035 * k + 0.01, thick: () => 0.035 * k + 0.01, outward: () => new THREE.Vector3(0, 1, 0), color: (t) => mix(color, tip, t), sides: 8 });
      break;
    }
    case "fox": {
      const pts = [V(0, 0, 0), V(0.08, -0.15, -0.18), V(0.2, -0.3, -0.3), V(0.36, -0.32, -0.32), V(0.48, -0.2, -0.28)];
      g = sweep(pts, {
        width: (t) => k * (0.05 + Math.sin(t * Math.PI) * 0.15),
        thick: (t) => k * (0.05 + Math.sin(t * Math.PI) * 0.13),
        outward: () => new THREE.Vector3(0, 1, 0),
        color: (t, kk) => (t > 0.75 ? tip : kk % 3 === 0 ? shade(color, 1.18) : color),
        sides: 10,
      });
      break;
    }
    case "whale": {
      const pts = [V(0, 0, 0), V(0, -0.15, -0.15), V(0, -0.3, -0.32), V(0, -0.38, -0.45)];
      const body = sweep(pts, { width: (t) => 0.08 * k * (1 - t * 0.6), thick: (t) => 0.07 * k * (1 - t * 0.6), outward: () => new THREE.Vector3(0, 1, 0), color: () => color });
      const fluke = new THREE.Shape();
      fluke.moveTo(0, 0).quadraticCurveTo(0.12, 0.02, 0.2, 0.1).quadraticCurveTo(0.12, -0.04, 0, -0.06).quadraticCurveTo(-0.12, -0.04, -0.2, 0.1).quadraticCurveTo(-0.12, 0.02, 0, 0);
      const fg = new THREE.ExtrudeGeometry(fluke, { depth: 0.025, bevelEnabled: false });
      fg.scale(k, k, k);
      fg.rotateX(-Math.PI / 2 + 0.3);
      const end = pts[pts.length - 1]!;
      fg.translate(end.x, end.y, end.z - 0.03);
      g = merged([body.toNonIndexed(), paint(fg, tip).toNonIndexed()]);
      break;
    }
  }
  addMesh(b, group, g, pivot, { outline: 0.008, double: true });
  return true;
}

function buildWings(b: Builder, group: THREE.Group, pivot: THREE.Vector3): boolean {
  const { p } = b;
  if (p.wings === undefined) return false;
  const k = b.fast ? 0.5 : 1;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1] as const) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.18, 0.22);
    shape.lineTo(0.42, 0.3);
    shape.lineTo(0.62, 0.22);
    shape.quadraticCurveTo(0.56, 0.12, 0.6, 0.02);
    shape.quadraticCurveTo(0.48, 0.06, 0.44, -0.06);
    shape.quadraticCurveTo(0.34, 0.0, 0.28, -0.1);
    shape.quadraticCurveTo(0.18, -0.02, 0.08, -0.08);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.015, bevelEnabled: false });
    g.scale(s * k, k, 1);
    g.rotateY(-s * 0.35);
    g.translate(pivot.x + s * 0.08, pivot.y, pivot.z);
    parts.push(paint(g, (q) => (q.y - pivot.y > 0.2 * k ? (p.tailTip ?? "#c9c0e0") : (p.tailColor ?? WHITE))));
  }
  addMesh(b, group, merged(parts), pivot, { outline: 0.006, double: true });
  return true;
}

function buildHeld(b: Builder, arm: THREE.Group, pivot: THREE.Vector3): THREE.Object3D | undefined {
  const { p } = b;
  const hand = new THREE.Vector3(pivot.x, SHOULDER_Y - 0.38, 0.01);
  if (p.held === "book") {
    const cover = new THREE.BoxGeometry(0.05, 0.24, 0.17);
    cover.translate(hand.x - 0.02, hand.y + 0.08, hand.z + 0.12);
    const pages = new THREE.BoxGeometry(0.052, 0.22, 0.15);
    pages.translate(hand.x - 0.015, hand.y + 0.08, hand.z + 0.125);
    const g = merged([paint(cover, "#6a2c1c").toNonIndexed(), paint(pages, "#f4ecd8").toNonIndexed()]);
    return addMesh(b, arm, g, pivot, { outline: 0.005 });
  }
  if (p.held === "lantern") {
    const frame = new THREE.BoxGeometry(0.1, 0.14, 0.1);
    frame.translate(hand.x, hand.y - 0.14, hand.z + 0.02);
    const lantern = addMesh(b, arm, paint(frame, GOLD), pivot, { outline: 0.004 });
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.11, 0.104), emissive("#4fe0d0", "#2fb0a0"));
    glow.position.set(hand.x - pivot.x, hand.y - 0.14 - pivot.y, hand.z + 0.02 - pivot.z);
    lantern.add(glow);
    return lantern;
  }
  return undefined;
}

// ---------------------------------------------------------------- 小部件（体素）

const voxelGeometry = new Map<string, THREE.BufferGeometry>();
function propGeometry(key: string, make: () => { geometry(scale: number, pivot: readonly [number, number, number]): THREE.BufferGeometry }, pivot: readonly [number, number, number]): THREE.BufferGeometry {
  let g = voxelGeometry.get(key);
  if (g === undefined) {
    g = make().geometry(PROP_VOXEL, pivot);
    voxelGeometry.set(key, g);
  }
  return g;
}

const propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

// ---------------------------------------------------------------- 组装

export function buildCharacter(vendor: Vendor, tier: Tier, role: RoleKind): CharacterRig {
  const p = PERSONAS[vendor];
  const fast = tier === "fast";
  const b: Builder = { p, vendor, fast, meshes: [] };
  const root = new THREE.Group();
  const body = new THREE.Group();
  const scale = fast ? 0.8 : 1;
  body.scale.setScalar(scale);
  root.add(body);

  const hipPivot = new THREE.Vector3(0, HIP, 0);
  const torso = new THREE.Group();
  torso.position.copy(hipPivot);
  body.add(torso);
  buildTorso(b, torso, hipPivot, role);
  buildLongHair(b, torso, hipPivot);

  const neckPivot = new THREE.Vector3(0, NECK, 0);
  const head = new THREE.Group();
  head.position.copy(neckPivot).sub(hipPivot);
  torso.add(head);
  buildHead(b, head, neckPivot);

  const skirt = new THREE.Group();
  skirt.position.copy(hipPivot);
  body.add(skirt);
  buildSkirt(b, skirt, hipPivot);

  const legs: THREE.Group[] = [];
  for (const s of [-1, 1] as const) {
    const pivot = new THREE.Vector3(s * 0.085, HIP, 0);
    const leg = new THREE.Group();
    leg.position.copy(pivot);
    body.add(leg);
    buildLeg(b, leg, s, pivot);
    legs.push(leg);
  }

  const arms: THREE.Group[] = [];
  for (const s of [-1, 1] as const) {
    const pivot = new THREE.Vector3(s * SHOULDER_X, SHOULDER_Y, 0);
    const arm = new THREE.Group();
    arm.position.copy(pivot).sub(hipPivot);
    torso.add(arm);
    buildArm(b, arm, s, pivot, role);
    arms.push(arm);
  }
  const [armL, armR] = arms as [THREE.Group, THREE.Group];

  const heldL = fast ? undefined : buildHeld(b, armL, new THREE.Vector3(-SHOULDER_X, SHOULDER_Y, 0));
  // 岗位道具：体素小件，握持点对准右手
  const prop = new THREE.Mesh(propGeometry(`prop:${role}`, () => buildRoleProp(role), PROP_HAND), propMaterial);
  prop.castShadow = true;
  prop.userData.material = propMaterial;
  prop.position.set(0, -0.38, 0.03);
  prop.scale.setScalar(0.85);
  armR.add(prop);
  b.meshes.push(prop);

  const tailPivot = new THREE.Vector3(0, HIP - 0.05, -0.2);
  const tail = new THREE.Group();
  tail.position.copy(tailPivot);
  const hasTail = buildTail(b, tail, tailPivot);
  if (hasTail) body.add(tail);

  const wingPivot = new THREE.Vector3(0, WAIST + 0.08, -0.17);
  const wings = new THREE.Group();
  wings.position.copy(wingPivot);
  const hasWings = buildWings(b, wings, wingPivot);
  if (hasWings) body.add(wings);

  const height = HEAD_C.y + R * HEAD_SCALE.y + 0.08;
  let halo: THREE.Object3D | undefined;
  if (role === "lead") {
    const m = new THREE.Mesh(
      propGeometry("halo", buildHalo, [0, 0, 0]),
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#6a4a08") }),
    );
    m.position.set(0, height + 0.32, 0);
    m.userData.baseY = m.position.y;
    body.add(m);
    halo = m;
  }

  let sparkles: THREE.Group | undefined;
  if (p.sparkles === true || p.question === true) {
    sparkles = new THREE.Group();
    const colors = ["#8fd3ff", "#f3a6ff", "#ffe08a"];
    for (let i = 0; i < 3; i += 1) {
      const geometry =
        p.question === true
          ? propGeometry("question", buildQuestion, [0, 0, 0])
          : propGeometry(`sparkle:${i}`, () => buildSparkle(colors[i]!), [0, 0, 0]);
      const m = new THREE.Mesh(
        geometry,
        new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(p.question === true ? "#1f7a72" : "#404070") }),
      );
      m.userData.phase = (i / 3) * Math.PI * 2;
      sparkles.add(m);
    }
    sparkles.position.y = height * 0.72;
    body.add(sparkles);
  }

  return {
    root,
    body,
    head,
    armL,
    armR,
    legL: legs[0]!,
    legR: legs[1]!,
    skirt,
    tail: hasTail ? tail : undefined,
    wings: hasWings ? wings : undefined,
    heldL,
    heldR: prop,
    halo,
    sparkles,
    meshes: b.meshes,
    height: height * scale,
    hipHeight: HIP * scale,
    tier,
  };
}
