/**
 * 房间外的环境：办公室是一栋写字楼里的一层。房间外一圈走廊（地毯砖）、电梯间、
 * 后侧和左侧是落地玻璃幕墙，朝镜头的两侧按剖面图只留矮墙；楼板以下是大楼外立面，
 * 四周是一片城市楼群，越往下越隐进雾气（雾色与天空底色一致）。
 *
 * 按本地时间分早晨 / 正午 / 傍晚 / 夜晚四档：天空渐变（容器背景，夜里加星星）、
 * 阳光（月光）方向与颜色、半球光、玻璃颜色、楼群亮灯比例，夜里室内点灯。
 * 每分钟检查一次时间。
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { canvasTexture, plant, type WallSide } from "./furniture.ts";

export type DayPhase = "morning" | "noon" | "dusk" | "night";

interface PhaseLook {
  readonly sky: string;
  /** 远处雾气，取天空渐变最下面的颜色，楼群往下渐隐到这个颜色。 */
  readonly haze: string;
  readonly hemiSky: string;
  readonly hemiGround: string;
  readonly hemi: number;
  readonly sunColor: string;
  readonly sun: number;
  readonly sunPos: readonly [number, number, number];
  /** 房间内墙窗户的颜色。 */
  readonly glass: string;
  /** 幕墙玻璃。 */
  readonly curtain: string;
  /** 楼群：环境光、阳光、玻璃颜色、亮灯比例。 */
  readonly cityAmb: number;
  readonly citySun: number;
  readonly cityGlass: string;
  readonly cityLit: number;
  readonly lamp: number;
}

const STARS = Array.from({ length: 36 }, (_, i) => {
  const x = (i * 37) % 100;
  const y = (i * 53) % 46;
  const r = i % 5 === 0 ? 1.6 : 1;
  return `radial-gradient(${r}px ${r}px at ${x}% ${y}%, rgba(255,255,255,${i % 3 === 0 ? 0.95 : 0.6}), transparent)`;
}).join(", ");

const LOOK: Record<DayPhase, PhaseLook> = {
  morning: {
    sky: "linear-gradient(180deg, #8ec5f0 0%, #cfe6f7 45%, #fde7cc 100%)",
    haze: "#fde7cc",
    hemiSky: "#f2f6ff",
    hemiGround: "#b49a7a",
    hemi: 1.45,
    sunColor: "#ffe2b8",
    sun: 1.9,
    sunPos: [16, 11, 7],
    glass: "#cfe8ff",
    curtain: "#bfe0ff",
    cityAmb: 0.62,
    citySun: 0.5,
    cityGlass: "#9fc3e6",
    cityLit: 0,
    lamp: 0,
  },
  noon: {
    sky: "linear-gradient(180deg, #5fa8ec 0%, #a9d3f5 50%, #e9f3fb 100%)",
    haze: "#e9f3fb",
    hemiSky: "#eef3ff",
    hemiGround: "#b49a7a",
    hemi: 1.6,
    sunColor: "#fff4e0",
    sun: 2.2,
    sunPos: [9, 18, 10],
    glass: "#bfe3ff",
    curtain: "#b6dcff",
    cityAmb: 0.68,
    citySun: 0.45,
    cityGlass: "#a6cdf0",
    cityLit: 0,
    lamp: 0,
  },
  dusk: {
    sky: "linear-gradient(180deg, #3d4f98 0%, #9b6aa8 35%, #f2946a 72%, #ffd29a 100%)",
    haze: "#ffd29a",
    hemiSky: "#ffd2b4",
    hemiGround: "#6a4a5a",
    hemi: 1.15,
    sunColor: "#ff9d5c",
    sun: 1.7,
    sunPos: [-16, 6, 5],
    glass: "#ffc489",
    curtain: "#ffb27a",
    cityAmb: 0.5,
    citySun: 0.45,
    cityGlass: "#d99a86",
    cityLit: 0.28,
    lamp: 1.2,
  },
  night: {
    sky: `${STARS}, linear-gradient(180deg, #070d24 0%, #14204a 55%, #263465 100%)`,
    haze: "#263465",
    hemiSky: "#7d8cc4",
    hemiGround: "#251d30",
    hemi: 0.75,
    sunColor: "#a9bcff",
    sun: 0.55,
    sunPos: [-7, 16, -9],
    glass: "#2c3a6c",
    curtain: "#2a3870",
    cityAmb: 0.32,
    citySun: 0.12,
    cityGlass: "#1d2752",
    cityLit: 0.42,
    lamp: 3.2,
  },
};

export function phaseAt(date: Date): DayPhase {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 10) return "morning";
  if (h >= 10 && h < 16.5) return "noon";
  if (h >= 16.5 && h < 19.5) return "dusk";
  return "night";
}

export const PHASE_LABEL: Record<DayPhase, string> = { morning: "早晨", noon: "正午", dusk: "傍晚", night: "夜晚" };

// ---------------------------------------------------------------- 楼群着色器

/**
 * 楼群（含本楼楼板以下的外立面）共用一个着色器：窗格按世界坐标程序生成，
 * 每个格子按哈希决定夜里亮不亮灯；越往下、越远越混进雾色。
 * 每栋楼的墙色、屋顶色、窗格尺寸放在顶点属性里，全部合并成一次绘制。
 */
const CITY_VERT = /* glsl */ `
attribute vec3 aBase;
attribute vec3 aRoof;
attribute vec4 aWin;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vBase;
varying vec3 vRoof;
varying vec4 vWin;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vBase = aBase;
  vRoof = aRoof;
  vWin = aWin;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const CITY_FRAG = /* glsl */ `
uniform vec3 uGlass;
uniform vec3 uLit;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform float uAmb;
uniform float uSun;
uniform float uLitFrac;
uniform vec2 uHazeY;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vBase;
varying vec3 vRoof;
varying vec4 vWin;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(vNormal);
  float shade = uAmb + uSun * max(dot(n, uSunDir), 0.0);
  vec3 col;
  if (n.y > 0.5) {
    col = vRoof * shade;
  } else if (n.y < -0.5) {
    col = vBase * uAmb * 0.6;
  } else {
    // vWin: 窗格宽、窗格高、窗框占比、是否有窗
    float u = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
    vec2 c = vec2(u / vWin.x, vWorld.y / vWin.y);
    vec2 f = fract(c);
    bool win = vWin.w > 0.5 && f.x > vWin.z && f.x < 1.0 - vWin.z && f.y > 0.24 && f.y < 0.84;
    // 侧面的边角和每层之间的楼板线略深
    float band = f.y < 0.1 ? 0.88 : 1.0;
    if (win) {
      vec2 cell = floor(c) + vec2(n.x * 13.0, n.z * 7.0);
      if (hash(cell) < uLitFrac) col = uLit * (0.7 + 0.25 * hash(cell + 3.1));
      else col = uGlass * (0.55 + 0.45 * shade) * (0.85 + 0.3 * f.y);
    } else {
      col = vBase * shade * band;
    }
  }
  float h = clamp((uHazeY.x - vWorld.y) / (uHazeY.x - uHazeY.y), 0.0, 1.0);
  float d = clamp((length(vWorld.xz) - 35.0) / 50.0, 0.0, 1.0);
  float t = max(h * h * (3.0 - 2.0 * h), d * 0.85);
  gl_FragColor = vec4(mix(col, uHaze, t), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 一个带楼群属性的盒子（底面中心在 x, y0, z）。 */
function block(
  x: number,
  z: number,
  w: number,
  d: number,
  y0: number,
  y1: number,
  base: string,
  roof: string,
  win: readonly [number, number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, y1 - y0, d);
  g.translate(x, (y0 + y1) / 2, z);
  const count = g.attributes.position!.count;
  const fill = (values: readonly number[]) => {
    const out = new Float32Array(count * values.length);
    for (let i = 0; i < count; i += 1) out.set(values, i * values.length);
    return new THREE.BufferAttribute(out, values.length);
  };
  const b = new THREE.Color(base);
  const r = new THREE.Color(roof);
  g.setAttribute("aBase", fill([b.r, b.g, b.b]));
  g.setAttribute("aRoof", fill([r.r, r.g, r.b]));
  g.setAttribute("aWin", fill(win));
  g.deleteAttribute("uv");
  return g;
}

const TOWER_COLORS: readonly (readonly [string, string])[] = [
  ["#d9d4cb", "#9a958d"],
  ["#b9c2cc", "#7f8893"],
  ["#c8b9a6", "#8f8172"],
  ["#9aa6b4", "#6c7682"],
  ["#e2dfd8", "#a6a39c"],
  ["#c3cbc4", "#86908a"],
];

/** 一圈城市楼群：朝镜头一侧的楼顶都低于本层楼板，不会挡住办公室。 */
function cityGeometry(foot: { x0: number; x1: number; z0: number; z1: number }): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rand = rng(20261104);
  const step = 14;
  const bx = (foot.x0 + foot.x1) / 2;
  const bz = (foot.z0 + foot.z1) / 2;
  const hw = (foot.x1 - foot.x0) / 2;
  const hd = (foot.z1 - foot.z0) / 2;
  for (let gx = -6; gx <= 6; gx += 1)
    for (let gz = -6; gz <= 6; gz += 1) {
      const w = 6 + rand() * 5;
      const d = 6 + rand() * 5;
      const x = bx + gx * step + (rand() - 0.5) * 3;
      const z = bz + gz * step + (rand() - 0.5) * 3;
      const skip = rand();
      if (Math.abs(x - bx) < hw + 6 + w / 2 && Math.abs(z - bz) < hd + 6 + d / 2) continue;
      if (Math.hypot(x - bx, z - bz) > 88 || skip < 0.12) continue;
      // 俯视正交镜头下越远的楼在画面里越靠上，所以楼顶随距离降低，
      // 整圈楼群在画面里连成一条天际线、上方露出天空；近处的楼都比本层矮。
      const dist = Math.hypot(x - bx, z - bz);
      const top = Math.min(6 - 0.61 * dist + (rand() - 0.5) * 8, -7 - rand() * 4);
      const [base, roof] = TOWER_COLORS[Math.floor(rand() * TOWER_COLORS.length)]!;
      const cellW = 1.2 + rand() * 1.2;
      const cellH = 2.6 + rand() * 1.4;
      const frame = 0.12 + rand() * 0.18;
      parts.push(block(x, z, w, d, -110, top, base, roof, [cellW, cellH, frame, 1]));
      // 楼顶的机房 / 水箱
      if (rand() < 0.7) {
        const mw = 1.5 + rand() * 2;
        const md = 1.5 + rand() * 2;
        parts.push(
          block(x + (rand() - 0.5) * (w - mw), z + (rand() - 0.5) * (d - md), mw, md, top, top + 0.8 + rand() * 1.4, "#a7abb2", "#8d9198", [1, 1, 0, 0]),
        );
      }
    }
  // 本楼楼板以下的外立面（每层 4.4 高，与本层对齐）
  parts.push(
    block(bx, bz, foot.x1 - foot.x0, foot.z1 - foot.z0, -110, -0.7, "#d5d8de", "#d5d8de", [1.65, 4.4, 0.06, 1]),
  );
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

// ---------------------------------------------------------------- 本层

/** 走廊的地毯砖。 */
function carpetTexture(w: number, d: number): THREE.CanvasTexture {
  const texture = canvasTexture(128, 128, (g) => {
    const tones = ["#c3c7cf", "#b9bdc6", "#bfc3cc", "#b5bac3"];
    for (let i = 0; i < 4; i += 1) {
      g.fillStyle = tones[i]!;
      g.fillRect((i % 2) * 64, Math.floor(i / 2) * 64, 64, 64);
      g.strokeStyle = "rgba(0,0,0,0.05)";
      for (let k = 6; k < 64; k += 6) {
        g.beginPath();
        if (i % 3 === 0) {
          g.moveTo((i % 2) * 64 + k, Math.floor(i / 2) * 64);
          g.lineTo((i % 2) * 64 + k, Math.floor(i / 2) * 64 + 64);
        } else {
          g.moveTo((i % 2) * 64, Math.floor(i / 2) * 64 + k);
          g.lineTo((i % 2) * 64 + 64, Math.floor(i / 2) * 64 + k);
        }
        g.stroke();
      }
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(w / 2, d / 2);
  return texture;
}

/** 电梯厅：靠左侧幕墙的一块核心筒，两部电梯门朝房间方向，门上有楼层显示。 */
function elevatorCore(x0: number, x1: number, z0: number, z1: number, height: number): THREE.Group {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(x1 - x0, height, z1 - z0),
    new THREE.MeshLambertMaterial({ color: "#d9d3c9" }),
  );
  core.position.set((x0 + x1) / 2, height / 2, (z0 + z1) / 2);
  core.castShadow = true;
  core.receiveShadow = true;
  group.add(core);
  const metal = new THREE.MeshLambertMaterial({ color: "#a9b2bc" });
  const frameMat = new THREE.MeshLambertMaterial({ color: "#6d7480" });
  const display = canvasTexture(64, 32, (g) => {
    g.fillStyle = "#14161b";
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = "#ff9b3d";
    g.font = "bold 22px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("▲18", 32, 17);
  });
  const span = z1 - z0;
  for (const t of [0.28, 0.72]) {
    const z = z0 + span * t;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.65, 1.6), frameMat);
    frame.position.set(x1 + 0.03, 1.325, z);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.45, 1.36), metal);
    door.position.set(x1 + 0.06, 1.225, z);
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.02, 2.45, 0.03), frameMat);
    seam.position.set(x1 + 0.1, 1.225, z);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), new THREE.MeshBasicMaterial({ map: display }));
    screen.rotation.y = Math.PI / 2;
    screen.position.set(x1 + 0.02, 2.95, z);
    group.add(frame, door, seam, screen);
  }
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.36, 0.18), frameMat);
  panel.position.set(x1 + 0.03, 1.25, (z0 + z1) / 2);
  const button = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: "#ffcf6a" }));
  button.position.set(x1 + 0.06, 1.3, (z0 + z1) / 2);
  group.add(panel, button);
  return group;
}

type Side = WallSide;
const SIDES: readonly Side[] = ["back", "front", "left", "right"];
const OUTWARD: Record<Side, readonly [number, number]> = { back: [0, -1], front: [0, 1], left: [-1, 0], right: [1, 0] };

/** 一组会随镜头方向淡化的材质。 */
interface Fader {
  readonly mats: THREE.Material[];
  readonly meshes: THREE.Object3D[];
  readonly sides: readonly Side[];
  /** 不朝镜头时的不透明度。 */
  readonly base: number;
  readonly glass: boolean;
  /** 楼上的楼层：只在缩放到最远时出现。 */
  readonly upper: boolean;
  readonly room: boolean;
}

export interface Environment {
  /** 房间重搭（如改名）后重新给窗玻璃上色、登记要随视角淡化的墙。 */
  applyRoom(room: THREE.Object3D): void;
  /** 每帧调用：按镜头方向淡化朝镜头的墙；缩放到最远时显示楼上各层。 */
  update(camera: THREE.OrthographicCamera, target: THREE.Vector3, minZoom: number, dt: number): void;
  /** 当前是否在看整栋楼（楼上各层已显示）。 */
  readonly building: boolean;
  readonly phase: DayPhase;
  dispose(): void;
}

export function createEnvironment(
  scene: THREE.Scene,
  container: HTMLElement,
  lights: { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight },
  center: readonly [number, number],
  room: { x0: number; x1: number; z0: number; z1: number },
): Environment {
  const group = new THREE.Group();
  scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // 本层楼板：后侧、左侧留出走廊和电梯厅，朝镜头的两侧窄一些
  const foot = { x0: room.x0 - 6, x1: room.x1 + 3, z0: room.z0 - 4.5, z1: room.z1 + 3 };
  const fw = foot.x1 - foot.x0;
  const fd = foot.z1 - foot.z0;
  const fx = (foot.x0 + foot.x1) / 2;
  const fz = (foot.z0 + foot.z1) / 2;
  const H = 4.6;
  const FLOOR = 4.4;
  const UPPER = 7;
  const top = H + UPPER * FLOOR;

  const carpet = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(fw, fd)),
    keep(new THREE.MeshLambertMaterial({ map: keep(carpetTexture(fw, fd)) })),
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(fx, -0.01, fz);
  carpet.receiveShadow = true;
  group.add(carpet);
  const slab = new THREE.Mesh(keep(new THREE.BoxGeometry(fw, 0.7, fd)), keep(new THREE.MeshLambertMaterial({ color: "#e2e0db" })));
  slab.position.set(fx, -0.37, fz);
  group.add(slab);

  // ---- 大楼外壳：按（材质种类、所属外墙、是否楼上）分桶合并，每桶一份材质单独淡化
  type Kind = "concrete" | "mullion" | "glass" | "floor";
  const buckets = new Map<string, { kind: Kind; sides: Side[]; upper: boolean; geos: THREE.BufferGeometry[] }>();
  const put = (kind: Kind, sides: Side[], upper: boolean, g: THREE.BufferGeometry) => {
    const key = `${kind}|${sides.join(",")}|${upper ? 1 : 0}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { kind, sides, upper, geos: [] };
      buckets.set(key, bucket);
    }
    bucket.geos.push(g);
  };
  const box = (kind: Kind, sides: Side[], upper: boolean, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    put(kind, sides, upper, g);
  };
  const sidesAt = (x: number, z: number): Side[] => {
    const out: Side[] = [];
    if (z < foot.z0 + 1) out.push("back");
    if (z > foot.z1 - 1) out.push("front");
    if (x < foot.x0 + 1) out.push("left");
    if (x > foot.x1 - 1) out.push("right");
    return out;
  };
  /** 一段楼层高的外墙：玻璃 + 竖梃 + 底梁、顶梁。 */
  const facade = (side: Side, y0: number, h: number, upper: boolean) => {
    const alongX = side === "back" || side === "front";
    const a = alongX ? foot.x0 : foot.z0;
    const b = alongX ? foot.x1 : foot.z1;
    const at = side === "back" ? foot.z0 + 0.05 : side === "front" ? foot.z1 - 0.05 : side === "left" ? foot.x0 + 0.05 : foot.x1 - 0.05;
    const len = b - a;
    const glass = new THREE.PlaneGeometry(len, h);
    if (!alongX) glass.rotateY(Math.PI / 2);
    if (alongX) glass.translate((a + b) / 2, y0 + h / 2, at);
    else glass.translate(at, y0 + h / 2, (a + b) / 2);
    put("glass", [side], upper, glass);
    const n = Math.round(len / 1.6);
    for (let i = 0; i <= n; i += 1) {
      const p = a + (len * i) / n;
      if (alongX) box("mullion", [side], upper, 0.08, h, 0.08, p, y0 + h / 2, at);
      else box("mullion", [side], upper, 0.08, h, 0.08, at, y0 + h / 2, p);
    }
    for (const [y, t] of [
      [y0 + 0.06, 0.12],
      [y0 + h - 0.12, 0.24],
    ] as const) {
      if (alongX) box("mullion", [side], upper, len, t, 0.14, (a + b) / 2, y, at);
      else box("mullion", [side], upper, 0.14, t, len, at, y, (a + b) / 2);
    }
  };
  const along = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const pillarSpots: [number, number][] = [];
  for (const x of along(foot.x0 + 0.4, foot.x1 - 0.4, 4)) pillarSpots.push([x, foot.z0 + 0.4], [x, foot.z1 - 0.4]);
  for (const z of along(foot.z0 + 0.4, foot.z1 - 0.4, 3).slice(1, -1)) pillarSpots.push([foot.x0 + 0.4, z], [foot.x1 - 0.4, z]);
  const pillars = (y0: number, h: number, upper: boolean) => {
    for (const [x, z] of pillarSpots) box("concrete", sidesAt(x, z), upper, 0.8, h, 0.8, x, y0 + h / 2, z);
  };
  // 电梯核心筒（本层的门在 elevatorCore 里，楼上只是一根实心筒）
  const core = { x0: foot.x0 + 0.5, x1: foot.x0 + 2.6, z0: room.z0 + 5, z1: room.z0 + 12.5 };

  // 本层：四面幕墙、柱子
  for (const side of SIDES) facade(side, 0, H, false);
  pillars(0, H, false);
  // 楼上各层：整块楼板（第一块就是本层的天花板）、四面幕墙、柱子、核心筒，顶上女儿墙
  for (let k = 0; k < UPPER; k += 1) {
    const y = H + k * FLOOR;
    box("floor", [], true, fw, 0.45, fd, fx, y + 0.225 - 0.45, fz);
    for (const side of SIDES) facade(side, y, FLOOR, true);
    pillars(y, FLOOR, true);
    box("concrete", ["left"], true, core.x1 - core.x0, FLOOR, core.z1 - core.z0, (core.x0 + core.x1) / 2, y + FLOOR / 2, (core.z0 + core.z1) / 2);
  }
  box("floor", [], true, fw, 0.6, fd, fx, top + 0.3 - 0.45, fz);
  box("concrete", ["back"], true, fw, 1, 0.4, fx, top + 0.6, foot.z0 + 0.2);
  box("concrete", ["front"], true, fw, 1, 0.4, fx, top + 0.6, foot.z1 - 0.2);
  box("concrete", ["left"], true, 0.4, 1, fd, foot.x0 + 0.2, top + 0.6, fz);
  box("concrete", ["right"], true, 0.4, 1, fd, foot.x1 - 0.2, top + 0.6, fz);
  box("concrete", [], true, 4, 1.6, 3, fx + 4, top + 0.95, fz - 2);

  const faders: Fader[] = [];
  const glassMats: THREE.MeshBasicMaterial[] = [];
  for (const bucket of buckets.values()) {
    const glass = bucket.kind === "glass";
    const mat: THREE.Material = glass
      ? new THREE.MeshBasicMaterial({ color: "#b6dcff", transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })
      : new THREE.MeshLambertMaterial({
          color: bucket.kind === "mullion" ? "#4d5562" : bucket.kind === "floor" ? "#d9d6d0" : "#e2e0db",
          transparent: true,
        });
    keep(mat);
    if (glass) glassMats.push(mat as THREE.MeshBasicMaterial);
    const m = new THREE.Mesh(keep(mergeGeometries(bucket.geos)), mat);
    m.receiveShadow = !glass;
    for (const g of bucket.geos) g.dispose();
    group.add(m);
    faders.push({
      mats: [mat],
      meshes: [m],
      sides: bucket.sides,
      base: glass ? (bucket.upper ? 0.72 : 0.3) : 1,
      glass,
      upper: bucket.upper,
      room: false,
    });
  }

  // 电梯厅（随左侧外墙淡化）与走廊绿植
  const elevators = elevatorCore(core.x0, core.x1, core.z0, core.z1, H);
  elevators.userData.side = "left";
  group.add(elevators);
  group.add(plant(foot.x0 + 1.3, foot.z0 + 1.4, 1.3), plant(foot.x1 - 1.4, foot.z0 + 1.4, 1.2), plant(foot.x0 + 1.3, foot.z1 - 1.3, 1.1));

  /** 把带 userData.side 的子树材质换成独立副本并登记淡化。 */
  const adopt = (root: THREE.Object3D, isRoom: boolean) => {
    // 同一份材质可能被几面墙共用，按（墙、材质）各复制一份
    const clones = new Map<string, THREE.Material>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      let side: Side | undefined;
      for (let p: THREE.Object3D | null = mesh; p !== null && side === undefined; p = p === root ? null : p.parent)
        side = p.userData.side as Side | undefined;
      if (side === undefined) return;
      const orig = mesh.material as THREE.Material;
      const key = `${side}|${orig.uuid}`;
      let clone = clones.get(key);
      if (clone === undefined) {
        clone = orig.clone();
        clone.transparent = true;
        clones.set(key, clone);
        faders.push({ mats: [clone], meshes: [], sides: [side], base: orig.opacity, glass: false, upper: false, room: isRoom });
      }
      mesh.material = clone;
      faders.find((f) => f.mats[0] === clone)!.meshes.push(mesh);
    });
    return [...clones.values()];
  };
  for (const m of adopt(elevators, false)) keep(m);
  let roomClones: THREE.Material[] = [];

  // 城市楼群
  const cityMat = keep(
    new THREE.ShaderMaterial({
      vertexShader: CITY_VERT,
      fragmentShader: CITY_FRAG,
      uniforms: {
        uGlass: { value: new THREE.Color("#a6cdf0") },
        uLit: { value: new THREE.Color("#ffd98a") },
        uHaze: { value: new THREE.Color("#e9f3fb") },
        uSunDir: { value: new THREE.Vector3(9, 18, 10).normalize() },
        uAmb: { value: 0.68 },
        uSun: { value: 0.45 },
        uLitFrac: { value: 0 },
        uHazeY: { value: new THREE.Vector2(-4, -42) },
      },
    }),
  );
  const city = new THREE.Mesh(keep(cityGeometry(foot)), cityMat);
  city.frustumCulled = false;
  group.add(city);

  // 夜里室内的暖灯
  const lamp = new THREE.PointLight("#ffcf8a", 0, 22, 1.6);
  lamp.position.set(center[0], 3.4, center[1]);
  scene.add(lamp);
  const lamp2 = new THREE.PointLight("#ffcf8a", 0, 16, 1.6);
  lamp2.position.set(8, 3.2, 6);
  scene.add(lamp2);

  let current: DayPhase | null = null;
  let roomRef: THREE.Object3D | undefined;

  const paintGlass = (target: THREE.Object3D, color: string) => {
    target.traverse((obj) => {
      if (obj.userData.glass === true) ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
    });
  };

  const apply = (phase: DayPhase) => {
    if (phase === current) return;
    current = phase;
    const look = LOOK[phase];
    container.style.background = look.sky;
    lights.hemi.color.set(look.hemiSky);
    lights.hemi.groundColor.set(look.hemiGround);
    lights.hemi.intensity = look.hemi;
    lights.sun.color.set(look.sunColor);
    lights.sun.intensity = look.sun;
    lights.sun.position.set(...look.sunPos);
    lamp.intensity = look.lamp;
    lamp2.intensity = look.lamp * 0.7;
    for (const m of glassMats) m.color.set(look.curtain);
    const u = cityMat.uniforms;
    (u.uGlass!.value as THREE.Color).set(look.cityGlass);
    (u.uHaze!.value as THREE.Color).set(look.haze);
    (u.uSunDir!.value as THREE.Vector3).set(...look.sunPos).normalize();
    u.uAmb!.value = look.cityAmb;
    u.uSun!.value = look.citySun;
    u.uLitFrac!.value = look.cityLit;
    if (roomRef) paintGlass(roomRef, look.glass);
  };

  const check = () => apply(phaseAt(new Date()));
  check();
  const timer = setInterval(check, 60_000);

  // ---- 视角相关的淡化
  const facing: Record<Side, number> = { back: 0, front: 0, left: 0, right: 0 };
  let upperShown = 0;
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  return {
    applyRoom(target) {
      for (let i = faders.length - 1; i >= 0; i -= 1) if (faders[i]!.room) faders.splice(i, 1);
      for (const m of roomClones) m.dispose();
      roomRef = target;
      roomClones = adopt(target, true);
      if (current !== null) paintGlass(target, LOOK[current].glass);
    },
    update(camera, target, minZoom, dt) {
      let dx = camera.position.x - target.x;
      let dz = camera.position.z - target.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const k = Math.min(1, dt * 8);
      for (const side of SIDES) {
        const [nx, nz] = OUTWARD[side];
        facing[side] += (smooth(0.2, 0.55, nx * dx + nz * dz) - facing[side]) * k;
      }
      // 缩放到最远（再往外滚一点就到底）时显示整栋楼
      const want = camera.zoom <= minZoom * 1.12 ? 1 : 0;
      upperShown += (want - upperShown) * Math.min(1, dt * 6);
      if (Math.abs(want - upperShown) < 0.002) upperShown = want;
      const b = upperShown;
      for (const f of faders) {
        let face = 0;
        for (const side of f.sides) face = Math.max(face, facing[side]);
        // 朝镜头的墙：看整栋楼时半透明，能隐约看到里面；拉近时几乎透明
        const faced = f.glass ? 0.04 + 0.2 * b : 0.06 + 0.3 * b;
        let alpha = f.base + (faced - f.base) * face;
        if (f.upper) alpha *= b;
        const visible = alpha > 0.01;
        for (const m of f.meshes) m.visible = visible;
        for (const mat of f.mats) {
          mat.opacity = alpha;
          if (!f.glass) mat.depthWrite = alpha > 0.95;
        }
      }
    },
    get building() {
      return upperShown > 0.5;
    },
    get phase() {
      return current ?? phaseAt(new Date());
    },
    dispose() {
      clearInterval(timer);
      for (const d of disposables) d.dispose();
      for (const m of roomClones) m.dispose();
      group.removeFromParent();
      lamp.removeFromParent();
      lamp2.removeFromParent();
      container.style.removeProperty("background");
    },
  };
}
