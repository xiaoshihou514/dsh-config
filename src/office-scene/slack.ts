/**
 * 摸鱼动画：空闲角色按人设轮换的小动作（工位 / 沙发 / 站立三种场合）。
 *
 * - 每家若干段专属动作 + 几段通用动作（伸懒腰、喝咖啡），按时间与成员种子轮换：
 *   每 {@link CYCLE} 秒一段，前 {@link ACTIVE} 秒做动作，余下回到休息姿势；
 *   进出时与休息姿势平滑混合，不会跳变。
 * - 手持小道具挂在左手，按手臂的旋转反向补偿，始终保持「正着拿」。
 * - 头顶可飘符号（Z、音符、泡泡、问号……），用画布贴图的精灵实现。
 *
 * 用法：调用方先摆好休息姿势，再调用 {@link slack}；它在其上叠加动作并返回气泡文字与表情。
 */

import * as THREE from "three";
import type { Vendor } from "../office/types.ts";
import type { CharacterRig } from "./anime.ts";
import { Voxels, voxelMaterial } from "./voxel.ts";

export type SlackWhere = "desk" | "sofa" | "stand";
/**
 * 所在的去处：工位、沙发、茶几旁、书架前、窗边、靠墙、空地、盆栽旁、组长休息点。
 * 带 place 的动作只在对应去处出现（书架前翻书、盆栽旁浇水……）。
 */
export type SlackPlace = "desk" | "sofa" | "lounge" | "shelf" | "window" | "wall" | "open" | "plant" | "lead";
type Eyes = "open" | "closed" | "happy" | "half";
type Mouth = "none" | "open" | "smile" | "small";

export interface SlackResult {
  readonly id: string;
  /** 头顶气泡文字。 */
  readonly label: string;
  readonly eyes?: Eyes | undefined;
  readonly mouth?: Mouth | undefined;
}

/** 一段动作的参数：k = 本段进度 0..1，s = 本段已进行秒数。 */
interface Ctx {
  readonly rig: CharacterRig;
  readonly t: number;
  readonly s: number;
  readonly k: number;
  readonly where: SlackWhere;
  /** 本段用到的道具（已挂在左手、已做旋转补偿），可再加偏移 / 自转。 */
  readonly prop: THREE.Object3D | undefined;
}

interface Routine {
  readonly id: string;
  readonly label: string;
  readonly where: readonly SlackWhere[];
  /** 只在这些去处出现；缺省 = 哪儿都行。 */
  readonly place?: readonly SlackPlace[];
  readonly prop?: PropKind;
  /** 头顶飘的符号与颜色。 */
  readonly fx?: readonly [string, string];
  run(c: Ctx): { eyes?: Eyes; mouth?: Mouth } | void;
}

export const CYCLE = 15;
export const ACTIVE = 11.5;
const FADE = 0.7;

// ---------------------------------------------------------------- 小工具

type R3 = readonly [number, number, number];
function arms(rig: CharacterRig, l: R3, r: R3): void {
  rig.armL.rotation.set(l[0], l[1], l[2]);
  rig.armR.rotation.set(r[0], r[1], r[2]);
}
/** 周期 period 秒内、前 len 秒返回 0..1 进度，否则 -1。 */
function every(t: number, period: number, len: number, offset = 0): number {
  const k = (((t + offset) % period) + period) % period;
  return k < len ? k / len : -1;
}
const bump = (p: number) => (p < 0 ? 0 : Math.sin(p * Math.PI));
const ALL: readonly SlackWhere[] = ["desk", "sofa", "stand"];
const SEATED: readonly SlackWhere[] = ["desk", "sofa"];
const STAND: readonly SlackWhere[] = ["stand"];

// ---------------------------------------------------------------- 道具

type PropKind =
  | "bowl"
  | "notebook"
  | "moonbook"
  | "flute"
  | "planet"
  | "clipboard"
  | "teacup"
  | "book"
  | "teaser"
  | "axe"
  | "juice"
  | "fan"
  | "crane"
  | "map"
  | "coffee"
  | "phone"
  | "console"
  | "can"
  | "cookie"
  | "shelfbook";

const PV = 0.032; // 道具体素尺寸

interface PropSpec {
  build(): Voxels;
  /** 道具相对手心的偏移（世界尺度，已补偿手臂旋转，即「正立」坐标）。 */
  readonly offset?: R3;
  readonly rotation?: R3;
}

const PROPS: Record<PropKind, PropSpec> = {
  bowl: {
    // 蓝边白瓷饭碗 + 冒尖的米饭 + 一双筷子
    build: () => {
      const v = new Voxels();
      v.box(-3, 0, -3, 3, 2, 3, (x, y, z) => {
        const r = x * x + z * z;
        if (r > 10) return null;
        if (y === 0 && r > 5) return null;
        return y === 1 ? "#5b8fd6" : "#f4f6f8";
      });
      v.box(-2, 3, -2, 2, 3, 2, (x, _y, z) => (x * x + z * z <= 5 ? "#fffdf5" : null));
      v.box(-1, 4, -1, 1, 4, 1, (x, _y, z) => (x * x + z * z <= 1 ? "#fffdf5" : null));
      v.box(2, 3, -1, 2, 9, -1, "#a0522d").box(3, 3, 0, 3, 9, 0, "#a0522d");
      return v;
    },
    offset: [0, 0.02, 0.05],
  },
  notebook: {
    // Z 标黑封笔记本
    build: () => {
      const v = new Voxels();
      v.box(-3, 0, 0, 3, 8, 1, "#1d1f24");
      v.box(-3, 0, 2, -3, 8, 2, "#f1ede4");
      for (const [x, y] of [[-2, 7], [-1, 7], [0, 7], [1, 7], [2, 7], [1, 6], [0, 5], [-1, 4], [-2, 3], [-1, 3], [0, 3], [1, 3], [2, 3]] as const)
        v.set(x, y, 2, "#e8eaee");
      return v;
    },
    offset: [0, 0.03, 0.06],
    rotation: [-0.5, 0, 0],
  },
  moonbook: {
    // 紫罗兰封面、金色新月的笔记本
    build: () => {
      const v = new Voxels();
      v.box(-3, 0, 0, 3, 8, 1, "#3b2f63");
      for (let x = -2; x <= 2; x += 1)
        for (let y = 2; y <= 7; y += 1) {
          const outer = (x * x) / 4 + ((y - 4.5) * (y - 4.5)) / 7 <= 1;
          const inner = ((x - 1) * (x - 1)) / 3 + ((y - 4.5) * (y - 4.5)) / 5 <= 1;
          if (outer && !inner) v.set(x, y, 2, "#ffd76a");
        }
      return v;
    },
    offset: [0, 0.03, 0.06],
    rotation: [-1.1, 0, 0],
  },
  flute: {
    // 银色长笛，往右手方向伸出
    build: () => {
      const v = new Voxels();
      v.box(-4, 0, 0, 11, 0, 0, "#dfe3ea");
      for (const x of [2, 4, 6, 8]) v.set(x, 1, 0, "#9aa3ad");
      v.set(-3, 1, 0, "#7d8794");
      return v;
    },
    offset: [0, 0.04, 0.06],
  },
  planet: {
    // 托在手心上方的小星球（紫色 + 光环）
    build: () => {
      const v = new Voxels();
      for (let x = -3; x <= 3; x += 1)
        for (let y = -3; y <= 3; y += 1)
          for (let z = -3; z <= 3; z += 1)
            if (x * x + y * y + z * z <= 10) v.set(x, y + 4, z, y === 0 || y === 1 ? "#b59cf0" : y > 1 ? "#8a6ad8" : "#6f52bf");
      for (let a = 0; a < 40; a += 1) {
        const ang = (a / 40) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * 5);
        const z = Math.round(Math.sin(ang) * 5);
        v.set(x, 4, z, "#ead9a6");
      }
      return v;
    },
    offset: [0, -0.02, 0.14],
  },
  clipboard: {
    // 会议纪要夹板
    build: () => {
      const v = new Voxels();
      v.box(-3, 0, 0, 3, 9, 0, "#a8774a");
      v.box(-2, 1, 1, 2, 8, 1, "#ffffff");
      for (const y of [3, 5, 7]) v.box(-1, y, 2, 1, y, 2, "#8a93a3");
      v.set(-2, 7, 2, "#4fb85b").set(-2, 5, 2, "#4fb85b");
      v.box(-1, 9, 1, 1, 10, 1, "#9aa3ad");
      return v;
    },
    offset: [0, 0.02, 0.06],
    rotation: [-0.55, 0, 0],
  },
  teacup: {
    // 金边白瓷茶杯 + 托碟
    build: () => {
      const v = new Voxels();
      v.box(-3, 0, -3, 3, 0, 3, (x, _y, z) => (x * x + z * z <= 9 ? (x * x + z * z > 6 ? "#e3b546" : "#ffffff") : null));
      v.box(-2, 1, -2, 2, 3, 2, (x, y, z) => {
        const r = x * x + z * z;
        if (r > 5) return null;
        if (y === 3 && r <= 2) return "#9a5a2a";
        return y === 3 ? "#e3b546" : "#ffffff";
      });
      v.box(3, 2, 0, 3, 3, 0, "#ffffff");
      return v;
    },
    offset: [0, 0.02, 0.05],
  },
  book: {
    // 摊开的精装书
    build: () => {
      const v = new Voxels();
      v.box(-5, 0, -1, 5, 7, -1, "#7a2e2e");
      v.box(-5, 0, 0, -1, 7, 0, "#f4ecd8").box(1, 0, 0, 5, 7, 0, "#f4ecd8");
      v.box(0, 0, 0, 0, 7, 0, "#e3b546");
      for (let y = 2; y <= 6; y += 2) v.box(-4, y, 1, -2, y, 1, "#b8ab8c").box(2, y, 1, 4, y, 1, "#b8ab8c");
      return v;
    },
    offset: [0.12, 0.02, 0.08],
    rotation: [-0.8, 0, 0],
  },
  teaser: {
    // 逗猫棒：木杆 + 线 + 粉色羽毛球
    build: () => {
      const v = new Voxels();
      v.box(0, 0, 0, 0, 12, 0, "#c9a36a");
      v.set(1, 12, 0, "#dddddd").set(2, 11, 0, "#dddddd").set(3, 10, 0, "#dddddd").set(3, 9, 0, "#dddddd");
      v.box(2, 6, -1, 4, 8, 1, (x, y) => (x === 3 && y === 8 ? "#ffd23f" : "#ff7eb6"));
      return v;
    },
  },
  axe: {
    // 黑金双刃战斧（缩小版），斧面金色 X 纹
    build: () => {
      const v = new Voxels();
      v.box(0, -5, 0, 0, 11, 0, "#2a2230");
      v.set(0, 4, 0, "#e3b546").set(0, -5, 0, "#e3b546");
      for (const s of [-1, 1])
        for (let dx = 1; dx <= 5; dx += 1)
          for (let dy = -4; dy <= 4; dy += 1) {
            if (Math.abs(dy) > 1 + dx * 0.7) continue;
            v.set(s * dx, 8 + dy, 0, dx === 5 || Math.abs(dy) > dx * 0.7 ? "#e3b546" : "#1d1d24");
          }
      for (const s of [-1, 1]) for (let d = -1; d <= 1; d += 1) v.set(s * 3 + d, 8 + d, 1, "#e3b546").set(s * 3 + d, 8 - d, 1, "#e3b546");
      return v;
    },
    rotation: [0, 0, Math.PI / 2],
    offset: [0.05, 0.02, 0.08],
  },
  juice: {
    // 「番茄汁」纸盒 + 吸管
    build: () => {
      const v = new Voxels();
      v.box(-1, 0, -1, 1, 4, 1, (_x, y) => (y === 2 ? "#ffffff" : "#c8323c"));
      v.box(0, 5, 0, 0, 7, 0, "#f4f4f4").set(-1, 7, 0, "#f4f4f4");
      return v;
    },
    offset: [0, 0.02, 0.04],
  },
  fan: {
    // 蓝白花鸟折扇（半圆）
    build: () => {
      const v = new Voxels();
      for (let x = -6; x <= 6; x += 1)
        for (let y = 0; y <= 6; y += 1) {
          const r = Math.hypot(x, y);
          if (r > 6.4) continue;
          const seg = Math.floor(((Math.atan2(y, x) / Math.PI) * 9 + 9) % 9);
          const color = r < 2 ? "#a7794a" : r > 5.6 ? "#e3b546" : seg % 2 === 0 ? "#4f7fe0" : "#eef3ff";
          v.set(x, y, 0, color);
        }
      v.set(-2, 4, 1, "#e04f7f").set(2, 3, 1, "#ffd23f");
      return v;
    },
    offset: [0, 0.04, 0.06],
  },
  crane: {
    // 白蓝千纸鹤
    build: () => {
      const v = new Voxels();
      v.box(-1, 0, -2, 1, 1, 2, "#f6f8ff");
      v.box(-4, 1, 0, -2, 1, 0, "#cfe0ff").box(2, 1, 0, 4, 1, 0, "#cfe0ff");
      v.set(-5, 2, 0, "#cfe0ff").set(5, 2, 0, "#cfe0ff");
      v.set(0, 2, 3, "#4f7fe0").set(0, 3, 3, "#4f7fe0").set(0, 2, -3, "#f6f8ff");
      return v;
    },
    offset: [0, 0.05, 0.06],
  },
  map: {
    // 羊皮纸地图，红叉标着「这儿？」
    build: () => {
      const v = new Voxels();
      v.box(-5, 0, 0, 5, 6, 0, "#e8d6a8");
      v.box(-5, 0, 1, -5, 6, 1, "#b8956a").box(5, 0, 1, 5, 6, 1, "#b8956a");
      for (const [x, y] of [[-3, 2], [-2, 3], [-1, 3], [0, 4], [1, 3]] as const) v.set(x, y, 1, "#8a6a4a");
      v.set(2, 4, 1, "#d23c3c").set(3, 5, 1, "#d23c3c").set(3, 3, 1, "#d23c3c").set(2, 2, 1, "#d23c3c").set(1, 5, 1, "#d23c3c");
      return v;
    },
    offset: [0.12, 0.02, 0.08],
    rotation: [-0.7, 0, 0],
  },
  phone: {
    // 手机：深色机身、亮屏
    build: () => {
      const v = new Voxels();
      v.box(-2, 0, 0, 2, 7, 0, "#23262e");
      v.box(-1, 1, 1, 1, 6, 1, (_x, y) => (y === 6 ? "#9fd8ff" : y % 2 === 0 ? "#dfefff" : "#7fbfff"));
      return v;
    },
    offset: [0, 0.02, 0.06],
    rotation: [-0.9, 0, 0],
  },
  console: {
    // 掌机：两侧手柄 + 屏幕
    build: () => {
      const v = new Voxels();
      v.box(-6, 0, 0, 6, 4, 0, "#e04f4f");
      v.box(-6, 0, 0, -4, 4, 0, "#4f7fe0");
      v.box(-3, 1, 1, 3, 4, 1, (x, y) => ((x + y) % 3 === 0 ? "#ffe08a" : "#2b3140"));
      v.set(5, 3, 1, "#ffffff").set(5, 1, 1, "#ffffff").set(-5, 2, 1, "#2a2230");
      return v;
    },
    offset: [0.14, 0.03, 0.08],
    rotation: [-0.8, 0, 0],
  },
  can: {
    // 绿色喷壶
    build: () => {
      const v = new Voxels();
      v.box(-2, 0, -2, 2, 4, 2, "#4fb85b");
      v.box(-2, 5, -1, -2, 7, 1, "#3a8f45").box(-1, 7, 0, 1, 7, 0, "#3a8f45");
      for (let i = 0; i < 5; i += 1) v.set(3 + i, 2 + i, 0, "#3a8f45");
      v.set(8, 7, 0, "#a8dcff").set(8, 8, 0, "#a8dcff");
      return v;
    },
    offset: [0, -0.04, 0.05],
  },
  cookie: {
    // 一块巧克力豆饼干
    build: () => {
      const v = new Voxels();
      v.box(-2, 0, -2, 2, 0, 2, (x, _y, z) => (x * x + z * z > 5 ? null : (x + z) % 3 === 0 ? "#5a3a22" : "#d9a35a"));
      return v;
    },
    offset: [0, 0.03, 0.05],
    rotation: [-1.2, 0, 0],
  },
  shelfbook: {
    // 刚从书架抽出的书
    build: () => {
      const v = new Voxels();
      v.box(-1, 0, -2, 1, 7, 2, (x) => (x === 1 ? "#efe3c4" : "#4f7fe0"));
      v.box(-1, 3, -2, -1, 3, 2, "#e3b546");
      return v;
    },
    offset: [0, 0.03, 0.04],
  },
  coffee: {
    build: () => {
      const v = new Voxels();
      v.box(-2, 0, -2, 2, 4, 2, (x, y, z) => (y === 4 && Math.abs(x) < 2 && Math.abs(z) < 2 ? "#6b4a2e" : "#ffffff"));
      v.box(3, 1, 0, 3, 3, 0, "#ffffff");
      v.box(-2, 2, -2, 2, 2, 2, (x, _y, z) => (Math.abs(x) === 2 || Math.abs(z) === 2 ? "#e07a5f" : null));
      return v;
    },
    offset: [0, 0.02, 0.05],
  },
};

const propGeometry = new Map<PropKind, THREE.BufferGeometry>();
function propMesh(kind: PropKind): THREE.Mesh {
  let g = propGeometry.get(kind);
  if (g === undefined) {
    g = PROPS[kind].build().geometry(PV);
    propGeometry.set(kind, g);
  }
  const m = new THREE.Mesh(g, voxelMaterial());
  m.castShadow = true;
  const spec = PROPS[kind];
  if (spec.offset) m.position.set(...spec.offset);
  if (spec.rotation) m.rotation.set(...spec.rotation);
  m.userData.basePos = m.position.clone();
  m.userData.baseRot = m.rotation.clone();
  return m;
}

// ---------------------------------------------------------------- 头顶飘的符号

const glyphTextures = new Map<string, THREE.Texture>();
function glyphTexture(glyph: string): THREE.Texture {
  let tex = glyphTextures.get(glyph);
  if (tex === undefined) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "bold 46px system-ui, 'Noto Sans CJK SC', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 6;
    g.strokeStyle = "rgba(30,34,44,0.85)";
    g.strokeText(glyph, 32, 34);
    g.fillStyle = "#ffffff";
    g.fillText(glyph, 32, 34);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    glyphTextures.set(glyph, tex);
  }
  return tex;
}

// ---------------------------------------------------------------- 每个角色的挂件状态

interface RigState {
  readonly holder: THREE.Group;
  readonly props: Map<PropKind, THREE.Mesh>;
  readonly fx: THREE.Sprite[];
  readonly fxGroup: THREE.Group;
  current: PropKind | undefined;
}
const states = new WeakMap<CharacterRig, RigState>();

function stateOf(rig: CharacterRig): RigState {
  let st = states.get(rig);
  if (st === undefined) {
    const holder = new THREE.Group();
    const hand = rig.hand ?? [0, -0.4, 0.03];
    holder.position.set(hand[0], hand[1], hand[2]);
    rig.armL.add(holder);
    const fxGroup = new THREE.Group();
    fxGroup.visible = false;
    rig.body.add(fxGroup);
    const fx: THREE.Sprite[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
      s.userData.phase = i / 3;
      fxGroup.add(s);
      fx.push(s);
    }
    st = { holder, props: new Map(), fx, fxGroup, current: undefined };
    states.set(rig, st);
  }
  return st;
}

function showProp(rig: CharacterRig, st: RigState, kind: PropKind | undefined): THREE.Mesh | undefined {
  if (st.current !== kind) {
    if (st.current !== undefined) st.props.get(st.current)!.visible = false;
    st.current = kind;
  }
  if (kind === undefined) return undefined;
  let m = st.props.get(kind);
  if (m === undefined) {
    m = propMesh(kind);
    // 道具算进角色网格（可点选、出错时一起置灰）
    m.userData.agentId = rig.meshes[0]?.userData.agentId;
    st.holder.add(m);
    st.props.set(kind, m);
  }
  m.visible = true;
  m.position.copy(m.userData.basePos as THREE.Vector3);
  m.rotation.copy(m.userData.baseRot as THREE.Euler);
  return m;
}

/** 隐藏摸鱼道具与符号（每帧摆姿势前调用）。 */
export function slackReset(rig: CharacterRig): void {
  const st = states.get(rig);
  if (st === undefined) return;
  showProp(rig, st, undefined);
  st.fxGroup.visible = false;
}

// ---------------------------------------------------------------- 动作表

/** 通用：所有人都会。 */
const COMMON: readonly Routine[] = [
  {
    id: "stretch",
    label: "🙆 伸个懒腰",
    where: ["desk", "stand"],
    run: ({ rig, s }) => {
      const p = Math.min(1, s / 1.2);
      arms(rig, [-3.0 * p, 0, -0.35 * p], [-3.0 * p, 0, 0.35 * p]);
      rig.head.rotation.x = -0.25 * p;
      if (rig.upper) rig.upper.rotation.x = -0.08 * p;
      return { eyes: "closed", mouth: s % 4 < 2 ? "open" : "none" };
    },
  },
  {
    id: "coffee",
    label: "☕ 喝咖啡",
    where: ["sofa", "stand"],
    prop: "coffee",
    run: ({ rig, t }) => {
      const sip = bump(every(t, 5, 1.6));
      arms(rig, [-1.25 - sip * 1.0, 0, 0.35 + sip * 0.2], [-0.85, 0, -0.25]);
      rig.head.rotation.x = -0.1 * sip;
      return { eyes: sip > 0.3 ? "happy" : "open", mouth: sip > 0.3 ? "small" : "none" };
    },
  },
];

/** 跟去处走的动作（谁都会）：让同一个人换个地方就换些事做。 */
const PLACES: readonly Routine[] = [
  {
    id: "shelf-hunt",
    label: "📚 在书架上找书",
    where: STAND,
    place: ["shelf"],
    run: ({ rig, t }) => {
      const reach = (Math.sin(t * 0.9) + 1) / 2;
      arms(rig, [-2.4 - reach * 0.5, 0, -0.2], [-0.2, 0, 0.3]);
      rig.head.rotation.x = -0.25 - reach * 0.15;
      rig.head.rotation.y = Math.sin(t * 0.6) * 0.3;
      return { eyes: "open" };
    },
  },
  {
    id: "shelf-browse",
    label: "📖 站着翻两页",
    where: STAND,
    place: ["shelf"],
    prop: "shelfbook",
    run: ({ rig, t }) => {
      const flip = bump(every(t, 3, 0.6));
      arms(rig, [-1.35, 0, 0.35], [-1.25 - flip * 0.3, 0, -0.3 - flip * 0.4]);
      rig.head.rotation.x = 0.28;
      return { eyes: "half" };
    },
  },
  {
    id: "window-gaze",
    label: "🌆 看看窗外",
    where: STAND,
    place: ["window"],
    run: ({ rig, t }) => {
      arms(rig, [0.35, 0, 0.25], [0.35, 0, -0.25]);
      rig.head.rotation.y = Math.sin(t * 0.35) * 0.45;
      rig.head.rotation.x = -0.12;
      rig.body.position.y += Math.sin(t * 1.2) * 0.01;
      return {};
    },
  },
  {
    id: "window-breath",
    label: "🌬️ 对着窗户哈气画画",
    where: STAND,
    place: ["window"],
    run: ({ rig, t }) => {
      arms(rig, [-1.9, 0, 0.35], [-1.6 + Math.sin(t * 4) * 0.15, 0, -0.2 + Math.cos(t * 4) * 0.15]);
      rig.head.rotation.x = 0.05;
      return { mouth: every(t, 4, 1.2) >= 0 ? "open" : "smile" };
    },
  },
  {
    id: "plant-water",
    label: "🪴 给盆栽浇水",
    where: STAND,
    place: ["plant"],
    prop: "can",
    run: ({ rig, t, prop }) => {
      const pour = (Math.sin(t * 0.8) + 1) / 2;
      arms(rig, [-1.25, 0, 0.35], [-0.2, 0, 0.3]);
      rig.head.rotation.x = 0.3;
      if (prop) prop.rotation.z = -0.2 - pour * 0.5;
      return { mouth: "smile" };
    },
  },
  {
    id: "plant-leaf",
    label: "🍃 数叶子",
    where: STAND,
    place: ["plant"],
    run: ({ rig, t }) => {
      const tap = bump(every(t, 1.4, 0.4));
      arms(rig, [-0.2, 0, -0.3], [-1.1 - tap * 0.2, 0, 0.1]);
      rig.head.rotation.x = 0.35;
      rig.head.rotation.z = Math.sin(t * 0.8) * 0.12;
      return { eyes: "half", mouth: "small" };
    },
  },
  {
    id: "wall-phone",
    label: "📱 靠墙刷手机",
    where: STAND,
    place: ["wall", "open", "lounge", "lead"],
    prop: "phone",
    run: ({ rig, t }) => {
      const swipe = bump(every(t, 1.8, 0.35));
      arms(rig, [-1.55, 0, 0.45], [-1.45 - swipe * 0.15, 0, -0.45]);
      rig.head.rotation.x = 0.32;
      return { eyes: every(t, 6, 1.6) >= 0 ? "happy" : "half", mouth: every(t, 6, 1.6) >= 0 ? "smile" : "none" };
    },
  },
  {
    id: "wall-doze",
    label: "💤 靠墙打个盹",
    where: STAND,
    place: ["wall"],
    fx: ["Z", "#c8ccd6"],
    run: ({ rig, t }) => {
      arms(rig, [-1.25, 0, 0.95], [-1.3, 0, -0.95]);
      rig.head.rotation.x = 0.35 + Math.sin(t * 0.9) * 0.05;
      rig.head.rotation.z = 0.15;
      return { eyes: "closed" };
    },
  },
  {
    id: "open-chat",
    label: "💬 闲聊几句",
    where: STAND,
    place: ["open", "lounge"],
    run: ({ rig, t }) => {
      arms(rig, [-0.3, 0, -0.3], [-1.5 + Math.sin(t * 4) * 0.35, 0, 0.2 + Math.sin(t * 2.5) * 0.15]);
      rig.head.rotation.y = Math.sin(t * 1.5) * 0.15;
      const laugh = every(t, 5, 1.2) >= 0;
      if (laugh) rig.body.position.y += Math.abs(Math.sin(t * 16)) * 0.012;
      return { eyes: laugh ? "happy" : "open", mouth: laugh ? "open" : Math.floor(t * 5) % 2 === 0 ? "small" : "none" };
    },
  },
  {
    id: "open-exercise",
    label: "🤸 活动活动筋骨",
    where: STAND,
    place: ["open", "plant", "lead"],
    run: ({ rig, t }) => {
      const side = Math.sin(t * 1.6);
      arms(rig, [-2.9, 0, 0.2 - side * 0.5], [-0.1, 0, 0.3 + side * 0.4]);
      if (rig.upper) rig.upper.rotation.z = side * 0.18;
      rig.head.rotation.z = side * 0.15;
      return { eyes: "closed", mouth: "small" };
    },
  },
  {
    id: "lounge-cookie",
    label: "🍪 顺一块饼干",
    where: ["stand", "sofa"],
    place: ["lounge", "sofa"],
    prop: "cookie",
    run: ({ rig, t }) => {
      const bite = bump(every(t, 3, 0.8));
      arms(rig, [-1.3 - bite * 0.9, 0, 0.4 + bite * 0.2], [-0.85, 0, -0.25]);
      return { eyes: "happy", mouth: bite > 0.4 ? "open" : "smile" };
    },
  },
  {
    id: "sofa-game",
    label: "🎮 窝着打游戏",
    where: ["sofa"],
    place: ["sofa"],
    prop: "console",
    run: ({ rig, t }) => {
      const mash = Math.sin(t * 18) * 0.05;
      arms(rig, [-1.3 + mash, 0, 0.3], [-1.3 - mash, 0, -0.3]);
      rig.head.rotation.x = 0.3;
      const win = every(t, 7, 1.2);
      if (win >= 0) rig.body.position.y += bump(win) * 0.03;
      return { eyes: win >= 0 ? "happy" : "open", mouth: win >= 0 ? "open" : "small" };
    },
  },
  {
    id: "sofa-sprawl",
    label: "😌 瘫在沙发上",
    where: ["sofa"],
    place: ["sofa"],
    run: ({ rig, t }) => {
      arms(rig, [-0.1, 0, 0.7], [-0.1, 0, -0.7]);
      if (rig.upper) rig.upper.rotation.x = -0.22;
      rig.head.rotation.x = -0.3;
      rig.head.rotation.z = Math.sin(t * 0.5) * 0.1;
      return { eyes: "closed", mouth: "smile" };
    },
  },
  {
    id: "desk-phone",
    label: "📱 桌子底下偷偷刷手机",
    where: ["desk"],
    place: ["desk"],
    prop: "phone",
    run: ({ rig, t }) => {
      const peek = every(t, 6, 0.8);
      arms(rig, [-1.0, 0, 0.45], [-0.95, 0, -0.45]);
      rig.head.rotation.x = peek >= 0 ? 0 : 0.45;
      rig.head.rotation.y = peek >= 0 ? Math.sin(peek * Math.PI * 2) * 0.5 : 0;
      return { eyes: peek >= 0 ? "open" : "half" };
    },
  },
  {
    id: "desk-music",
    label: "🎧 戴耳机听歌",
    where: ["desk"],
    place: ["desk"],
    fx: ["♪", "#ffd76a"],
    run: ({ rig, t }) => {
      const beat = Math.sin(t * 7);
      arms(rig, [-1.2, 0, 0.35 + beat * 0.05], [-1.25 + Math.max(0, beat) * 0.15, 0, -0.35]);
      rig.head.rotation.x = 0.05 + beat * 0.08;
      rig.head.rotation.z = Math.sin(t * 3.5) * 0.12;
      return { eyes: "closed", mouth: "smile" };
    },
  },
  {
    id: "desk-snack",
    label: "🍪 抽屉里摸零食",
    where: ["desk"],
    place: ["desk"],
    prop: "cookie",
    run: ({ rig, t }) => {
      const bite = bump(every(t, 2.5, 0.7));
      arms(rig, [-1.25 - bite * 0.95, 0, 0.4 + bite * 0.2], [-1.2, 0, -0.35]);
      rig.head.rotation.y = Math.sin(t * 0.7) * 0.25;
      return { eyes: bite > 0.4 ? "happy" : "open", mouth: bite > 0.4 ? "open" : "small" };
    },
  },
  {
    id: "desk-spin",
    label: "🌀 转椅子玩",
    where: ["desk"],
    place: ["desk"],
    run: ({ rig, t }) => {
      arms(rig, [-0.5, 0, 0.6], [-0.5, 0, -0.6]);
      rig.body.rotation.y = Math.sin(t * 1.3) * 0.7;
      rig.head.rotation.x = -0.15;
      return { eyes: "happy", mouth: "open" };
    },
  },
];

const ROUTINES: Record<Vendor, readonly Routine[]> = {
  // 🌊 鲸鱼娘：干饭积极、干活随缘；被说胖会立刻反驳
  deepseek: [
    {
      id: "ds-eat",
      label: "🍚 干饭中，勿扰",
      where: ALL,
      prop: "bowl",
      run: ({ rig, t }) => {
        const scoop = (Math.sin(t * 5.5) + 1) / 2;
        arms(rig, [-1.45, 0, 0.5], [-1.5 - scoop * 0.85, 0, -0.55]);
        rig.head.rotation.x = 0.18 - scoop * 0.12;
        rig.body.position.y += Math.abs(Math.sin(t * 5.5)) * 0.006;
        return { eyes: "happy", mouth: scoop > 0.6 ? "open" : "small" };
      },
    },
    {
      id: "ds-nap",
      label: "💤 吃饱了，趴一会儿",
      where: ["desk"],
      fx: ["Z", "#8fd3ff"],
      run: ({ rig, t }) => {
        arms(rig, [-1.45, 0, 0.75], [-1.45, 0, -0.75]);
        if (rig.upper) rig.upper.rotation.x = 0.42;
        rig.head.rotation.x = 0.55 + Math.sin(t * 1.4) * 0.03;
        rig.head.rotation.z = 0.25;
        return { eyes: "closed", mouth: "small" };
      },
    },
    {
      id: "ds-bubble",
      label: "🫧 吐泡泡",
      where: ["sofa", "stand"],
      fx: ["○", "#a8dcff"],
      run: ({ rig, t }) => {
        arms(rig, [0.3, 0, -0.15], [0.3, 0, 0.15]);
        rig.head.rotation.x = -0.3;
        rig.head.rotation.z = Math.sin(t * 1.2) * 0.1;
        return { eyes: "half", mouth: Math.sin(t * 4) > 0 ? "small" : "open" };
      },
    },
    {
      id: "ds-notfat",
      label: "😤 才、才不胖！鱼片你再说一遍？",
      where: ["stand", "sofa"],
      run: ({ rig, t, where }) => {
        arms(rig, [0.25, 0, -0.75], [0.25, 0, 0.75]);
        rig.head.rotation.y = 0.55;
        rig.head.rotation.x = -0.12;
        const stomp = bump(every(t, 1.6, 0.3));
        if (where === "stand") {
          rig.legR.rotation.x = -stomp * 0.35;
          rig.body.position.y += stomp * 0.03;
        }
        return { eyes: "half", mouth: "small" };
      },
    },
  ],
  // 🦊 Z 娘：图书管理员，秩序控，私下爱吐槽 DeepSeek
  glm: [
    {
      id: "glm-read",
      label: "📓 第三遍精读，标注第 47 条",
      where: ALL,
      prop: "notebook",
      run: ({ rig, t }) => {
        const flip = bump(every(t, 3.5, 0.7));
        arms(rig, [-1.3, 0, 0.45], [-1.2 - flip * 0.25, 0, -0.35 - flip * 0.45]);
        rig.head.rotation.x = 0.28;
        rig.head.rotation.y = Math.sin(t * 0.7) * 0.06;
        return { eyes: "half" };
      },
    },
    {
      id: "glm-file",
      label: "🗂️ 按索引重新归档",
      where: STAND,
      run: ({ rig, t }) => {
        const a = Math.sin(t * 1.6);
        arms(rig, [-2.2 + a * 0.3, 0, -0.3], [-2.2 - a * 0.3, 0, 0.3]);
        rig.head.rotation.x = -0.25;
        rig.head.rotation.y = a * 0.25;
        return {};
      },
    },
    {
      id: "glm-snark",
      label: "😏 （小声吐槽 DeepSeek）",
      where: ALL,
      run: ({ rig, t }) => {
        arms(rig, [-2.25, 0, 0.6], [-0.85, 0, -0.25]);
        rig.head.rotation.z = 0.18;
        rig.head.rotation.y = -0.3;
        const giggle = every(t, 2.2, 0.8) >= 0;
        if (rig.upper && giggle) rig.upper.rotation.z = Math.sin(t * 30) * 0.025;
        return { eyes: "happy", mouth: "smile" };
      },
    },
    {
      id: "glm-mask",
      label: "😴 拉下眼罩补觉",
      where: ["sofa"],
      fx: ["Z", "#c8ccd6"],
      run: ({ rig, t }) => {
        arms(rig, [-0.9, 0, 0.55], [-0.9, 0, -0.55]);
        rig.head.rotation.x = -0.28;
        rig.head.rotation.z = 0.12 + Math.sin(t * 0.8) * 0.03;
        if (rig.upper) rig.upper.rotation.x = -0.12;
        return { eyes: "closed" };
      },
    },
  ],
  // 🌙 月之暗面娘：安静、书卷气的耐心学姐
  kimi: [
    {
      id: "kimi-flute",
      label: "🎵 吹一段长笛",
      where: ALL,
      prop: "flute",
      fx: ["♪", "#d9c2ff"],
      run: ({ rig, t }) => {
        arms(rig, [-2.05, 0, 0.75], [-1.75, 0, -0.15 + Math.sin(t * 6) * 0.04]);
        rig.head.rotation.z = -0.15 + Math.sin(t * 1.3) * 0.08;
        rig.head.rotation.x = 0.05;
        if (rig.upper) rig.upper.rotation.z = Math.sin(t * 1.3) * 0.04;
        return { eyes: "closed", mouth: "small" };
      },
    },
    {
      id: "kimi-planet",
      label: "🪐 托着小星球发呆",
      where: ["sofa", "stand"],
      prop: "planet",
      run: ({ rig, t, prop }) => {
        arms(rig, [-1.1, 0, 0.35], [-0.85, 0, -0.25]);
        rig.head.rotation.x = 0.22;
        if (prop) {
          prop.position.y += Math.sin(t * 2) * 0.02;
          prop.rotation.y = t * 0.8;
        }
        return { eyes: "half", mouth: "smile" };
      },
    },
    {
      id: "kimi-notes",
      label: "🌙 写朔月笔记",
      where: SEATED,
      prop: "moonbook",
      run: ({ rig, t }) => {
        arms(rig, [-1.25, 0, 0.45], [-1.42 + Math.sin(t * 6) * 0.07, 0, -0.3 + Math.cos(t * 6) * 0.07]);
        rig.head.rotation.x = 0.25;
        rig.head.rotation.z = 0.08;
        return { eyes: "half" };
      },
    },
    {
      id: "kimi-moon",
      label: "🌌 抬头看月亮",
      where: ["stand", "sofa"],
      run: ({ rig, t }) => {
        arms(rig, [0.3, 0, -0.12], [0.3, 0, 0.12]);
        rig.head.rotation.x = -0.45;
        rig.head.rotation.y = Math.sin(t * 0.4) * 0.2;
        return { mouth: "smile" };
      },
    },
  ],
  // 🐉 GPT 小姐：会议书记官，认真得过分谨慎
  gpt: [
    {
      id: "gpt-minutes",
      label: "📋 整理会议纪要 v7",
      where: ALL,
      prop: "clipboard",
      run: ({ rig, t }) => {
        arms(rig, [-1.3, 0, 0.45], [-1.4 + Math.sin(t * 7) * 0.07, 0, -0.35 + Math.cos(t * 7) * 0.07]);
        rig.head.rotation.x = 0.22;
        return {};
      },
    },
    {
      id: "gpt-recheck",
      label: "🔍 再核对一遍……保险起见",
      where: ALL,
      prop: "clipboard",
      run: ({ rig, t }) => {
        arms(rig, [-1.95, 0, 0.5], [-0.85, 0, -0.25]);
        rig.head.rotation.x = 0.05;
        const shake = every(t, 3, 0.8) >= 0;
        rig.head.rotation.y = shake ? Math.sin(t * 14) * 0.15 : 0;
        return { eyes: shake ? "half" : "open", mouth: "small" };
      },
    },
    {
      id: "gpt-sigh",
      label: "😮‍💨 （没人看见时松一口气）",
      where: ["stand", "sofa"],
      run: ({ rig, t }) => {
        const breath = (Math.sin(t * 1.1) + 1) / 2;
        arms(rig, [0.05, 0, -0.1], [0.05, 0, 0.1]);
        rig.head.rotation.x = 0.1 + breath * 0.2;
        if (rig.upper) rig.upper.rotation.x = breath * 0.08;
        return { eyes: breath > 0.5 ? "closed" : "half", mouth: breath > 0.5 ? "small" : "none" };
      },
    },
  ],
  // 📖 小克：老派英伦大小姐，克制沉静，心里藏着事
  claude: [
    {
      id: "claude-tea",
      label: "🫖 下午茶时间",
      where: ALL,
      prop: "teacup",
      run: ({ rig, t }) => {
        const sip = bump(every(t, 6, 2));
        arms(rig, [-1.3 - sip * 0.9, 0, 0.4 + sip * 0.2], [-0.8, 0, -0.35]);
        rig.head.rotation.x = 0.08 - sip * 0.12;
        return { eyes: sip > 0.3 ? "closed" : "half", mouth: sip > 0.3 ? "small" : "none" };
      },
    },
    {
      id: "claude-novel",
      label: "📖 读一本旧小说",
      where: SEATED,
      prop: "book",
      run: ({ rig, t }) => {
        arms(rig, [-1.35, 0, 0.35], [-1.35, 0, -0.35]);
        rig.head.rotation.x = 0.25;
        rig.head.rotation.y = Math.sin(t * 0.5) * 0.08;
        return { eyes: "half" };
      },
    },
    {
      id: "claude-window",
      label: "……（望着窗外出神）",
      where: ["stand", "sofa"],
      run: ({ rig, t }) => {
        arms(rig, [-0.45, 0, 0.45], [-0.45, 0, -0.45]);
        rig.head.rotation.y = 0.75;
        rig.head.rotation.x = -0.08;
        const sigh = bump(every(t, 7, 1.6));
        if (rig.upper) rig.upper.rotation.x = sigh * 0.08;
        return { eyes: "half" };
      },
    },
    {
      id: "claude-curtsy",
      label: "（提裙行礼）",
      where: STAND,
      run: ({ rig, t }) => {
        const c = bump(every(t, 4, 1.8));
        arms(rig, [-0.2, 0, -0.25 - c * 0.35], [-0.2, 0, 0.25 + c * 0.35]);
        rig.body.position.y -= c * 0.08;
        rig.head.rotation.x = c * 0.35;
        if (rig.upper) rig.upper.rotation.x = c * 0.12;
        return { eyes: c > 0.2 ? "closed" : "open", mouth: "smile" };
      },
    },
  ],
  // 🐱 哈基米：慌乱、真诚、有点降智的元气猫娘
  gemini: [
    {
      id: "gem-teaser",
      label: "🐾 逗猫棒！逗猫棒！",
      where: ALL,
      prop: "teaser",
      run: ({ rig, t }) => {
        const swing = Math.sin(t * 3);
        arms(rig, [-2.3, 0, 0.25 + swing * 0.3], [-1.9 + Math.sin(t * 11) * 0.35, 0, -0.2]);
        rig.head.rotation.y = -swing * 0.35;
        rig.head.rotation.x = -0.2;
        return { eyes: "open", mouth: "open" };
      },
    },
    {
      id: "gem-panic",
      label: "（慌）好 AI 好 AI 好 AI……",
      where: ["stand", "desk"],
      fx: ["?", "#ffd76a"],
      run: ({ rig, t }) => {
        arms(rig, [-2.6 + Math.sin(t * 13) * 0.4, 0, -0.5], [-2.6 + Math.sin(t * 13 + Math.PI) * 0.4, 0, 0.5]);
        rig.head.rotation.y = Math.sin(t * 9) * 0.35;
        rig.body.position.y += Math.abs(Math.sin(t * 9)) * 0.02;
        return { eyes: Math.sin(t * 5) > 0 ? "closed" : "open", mouth: "open" };
      },
    },
    {
      id: "gem-wash",
      label: "😺 舔爪洗脸",
      where: SEATED,
      run: ({ rig, t }) => {
        arms(rig, [-2.35 + Math.sin(t * 8) * 0.1, 0, -0.65 + Math.cos(t * 8) * 0.1], [-0.85, 0, -0.25]);
        rig.head.rotation.z = -0.2;
        rig.head.rotation.x = 0.1;
        return { eyes: "closed", mouth: "small" };
      },
    },
    {
      id: "gem-catstretch",
      label: "喵～（猫式伸懒腰）",
      where: STAND,
      run: ({ rig, s }) => {
        const p = Math.min(1, s / 1.2);
        arms(rig, [-1.65 * p, 0, -0.12], [-1.65 * p, 0, 0.12]);
        if (rig.upper) rig.upper.rotation.x = 0.45 * p;
        rig.head.rotation.x = -0.45 * p;
        return { eyes: "closed", mouth: "open" };
      },
    },
  ],
  // 🪓 Grok：凶悍的哥特斧少女，内在有点傻气
  grok: [
    {
      id: "grok-polish",
      label: "🪓 擦亮我的斧头",
      where: SEATED,
      prop: "axe",
      run: ({ rig, t }) => {
        arms(rig, [-1.0, 0, 0.6], [-1.05, 0, -0.3 - (Math.sin(t * 5) + 1) * 0.25]);
        rig.head.rotation.x = 0.3;
        return { eyes: "half", mouth: "smile" };
      },
    },
    {
      id: "grok-spin",
      label: "🪓 抡一圈热热身！",
      where: STAND,
      prop: "axe",
      run: ({ rig, t }) => {
        const spin = every(t, 4, 1.2);
        arms(rig, [-2.9, 0, 0.3], [-2.6, 0, -0.3]);
        if (spin >= 0) rig.body.rotation.y = spin * Math.PI * 2;
        rig.body.position.y += bump(spin) * 0.06;
        return { eyes: "happy", mouth: "open" };
      },
    },
    {
      id: "grok-juice",
      label: "🍅 只是番茄汁啦，真的",
      where: ALL,
      prop: "juice",
      run: ({ rig, t }) => {
        const sip = bump(every(t, 4, 1.8));
        arms(rig, [-1.3 - sip * 1.0, 0, 0.45 + sip * 0.15], [-0.85, 0, -0.25]);
        rig.head.rotation.z = 0.12;
        return { eyes: sip > 0.3 ? "happy" : "half", mouth: "small" };
      },
    },
    {
      id: "grok-lazy",
      label: "嘿嘿～（翘着二郎腿）",
      where: ["sofa"],
      run: ({ rig, t }) => {
        arms(rig, [-2.7, 0, -0.85], [-2.7, 0, 0.85]);
        if (rig.upper) rig.upper.rotation.x = -0.18;
        rig.head.rotation.x = -0.15;
        rig.legR.rotation.set(-1.85, 0, 0.3);
        rig.legR.rotation.x += Math.max(0, Math.sin(t * 3)) * 0.12;
        return { eyes: "half", mouth: "smile" };
      },
    },
  ],
  // 📜 千问大小姐：安静、出神、书卷气
  qwen: [
    {
      id: "qwen-fan",
      label: "🪭 轻摇折扇",
      where: ALL,
      prop: "fan",
      run: ({ rig, t, prop }) => {
        arms(rig, [-1.95, 0, 0.5 + Math.sin(t * 5) * 0.08], [-0.6, 0, -0.4]);
        if (prop) prop.rotation.z = Math.sin(t * 5) * 0.25;
        rig.head.rotation.z = 0.1;
        return { eyes: "half", mouth: "smile" };
      },
    },
    {
      id: "qwen-crane",
      label: "📜 叠第 999 只千纸鹤",
      where: SEATED,
      prop: "crane",
      run: ({ rig, t }) => {
        const f = Math.sin(t * 6) * 0.06;
        arms(rig, [-1.3 + f, 0, 0.55], [-1.3 - f, 0, -0.6]);
        rig.head.rotation.x = 0.3;
        return { eyes: "half" };
      },
    },
    {
      id: "qwen-daze",
      label: "（出神）",
      where: ["stand", "sofa"],
      run: ({ rig, t }) => {
        arms(rig, [-0.5, 0, 0.45], [-0.5, 0, -0.45]);
        rig.head.rotation.z = 0.2;
        rig.head.rotation.x = -0.18;
        rig.head.rotation.y = -0.35 + Math.sin(t * 0.3) * 0.1;
        return { eyes: "half" };
      },
    },
  ],
  // 未知模型（兜帽旅人）：总在找路
  other: [
    {
      id: "other-map",
      label: "🗺️ 这是……哪儿？",
      where: ALL,
      prop: "map",
      fx: ["?", "#7ff0e4"],
      run: ({ rig, t }) => {
        arms(rig, [-1.4, 0, 0.35], [-1.4, 0, -0.35]);
        rig.head.rotation.y = Math.sin(t * 0.9) * 0.4;
        rig.head.rotation.x = 0.15;
        return { eyes: "open", mouth: "small" };
      },
    },
    {
      id: "other-scan",
      label: "👀 四处张望",
      where: STAND,
      run: ({ rig, t }) => {
        arms(rig, [-2.35, 0, 0.55], [-0.15, 0, 0.3]);
        rig.head.rotation.y = Math.sin(t * 0.8) * 0.6;
        return {};
      },
    },
  ],
};

/**
 * 某家在某场合、某去处可做的全部动作（专属在前，去处动作、通用在后）。
 * place 缺省时不按去处筛选（图鉴预览用，列出全部）。
 */
export function slackRoutines(vendor: Vendor, where: SlackWhere, place?: SlackPlace): readonly { id: string; label: string }[] {
  return pool(vendor, where, place);
}

const poolCache = new Map<string, readonly Routine[]>();
function pool(vendor: Vendor, where: SlackWhere, place: SlackPlace | undefined): readonly Routine[] {
  const key = `${vendor}:${where}:${place ?? "*"}`;
  let list = poolCache.get(key);
  if (list === undefined) {
    list = [...ROUTINES[vendor], ...PLACES, ...COMMON].filter(
      (r) => r.where.includes(where) && (place === undefined || r.place === undefined || r.place.includes(place)),
    );
    poolCache.set(key, list);
  }
  return list;
}

function hash(n: number, seed: number): number {
  const v = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

// ---------------------------------------------------------------- 混合

type Pose = number[];
function snapshot(rig: CharacterRig): Pose {
  const out: number[] = [];
  for (const o of joints(rig)) out.push(o.rotation.x, o.rotation.y, o.rotation.z);
  out.push(rig.body.position.y);
  return out;
}
function joints(rig: CharacterRig): THREE.Object3D[] {
  const list: THREE.Object3D[] = [rig.head, rig.armL, rig.armR, rig.legL, rig.legR, rig.body];
  if (rig.upper) list.push(rig.upper);
  if (rig.lower) list.push(rig.lower);
  return list;
}
function blend(rig: CharacterRig, from: Pose, e: number): void {
  let i = 0;
  for (const o of joints(rig)) {
    o.rotation.set(
      from[i]! + (o.rotation.x - from[i]!) * e,
      from[i + 1]! + (o.rotation.y - from[i + 1]!) * e,
      from[i + 2]! + (o.rotation.z - from[i + 2]!) * e,
    );
    i += 3;
  }
  rig.body.position.y = from[i]! + (rig.body.position.y - from[i]!) * e;
}

const tmpQ = new THREE.Quaternion();

/**
 * 在已摆好的休息姿势上叠加摸鱼动作。
 * @param pick - 指定动作 id（图鉴里预览用）；缺省按时间轮换。
 * @returns 正在做的动作；处于两段之间的休息时返回 undefined。
 */
export function slack(
  rig: CharacterRig,
  vendor: Vendor,
  where: SlackWhere,
  t: number,
  seed: number,
  pick?: string,
  place?: SlackPlace,
): SlackResult | undefined {
  const list = pool(vendor, where, place);
  if (list.length === 0) return undefined;
  let routine: Routine | undefined;
  let s: number;
  let e: number;
  if (pick !== undefined) {
    routine = list.find((r) => r.id === pick);
    s = t % ACTIVE;
    e = 1;
  } else {
    const shifted = t + seed * 7.3;
    const cycle = Math.floor(shifted / CYCLE);
    s = shifted - cycle * CYCLE;
    if (s >= ACTIVE) return undefined;
    // 不连着做同一个：和上一段撞了就换下一个
    let index = Math.floor(hash(cycle, seed) * list.length);
    if (list.length > 1 && index === Math.floor(hash(cycle - 1, seed) * list.length)) index = (index + 1) % list.length;
    routine = list[index];
    e = Math.min(1, s / FADE, (ACTIVE - s) / FADE);
    e = e * e * (3 - 2 * e);
  }
  if (routine === undefined) return undefined;
  const st = stateOf(rig);
  const rest = snapshot(rig);
  const prop = showProp(rig, st, routine.prop);
  const face = routine.run({ rig, t, s, k: s / ACTIVE, where, prop }) ?? {};
  if (e < 1) blend(rig, rest, e);
  // 道具始终「正着拿」：抵消手臂旋转；淡入淡出时缩放
  st.holder.quaternion.copy(tmpQ.setFromEuler(rig.armL.rotation).invert());
  st.holder.scale.setScalar(Math.max(0.001, e));
  // 摸鱼时收起岗位道具（右手）与人设手持物（左手），淡出过半再收、淡入过半再拿出
  if (e > 0.5) {
    if (rig.heldR) rig.heldR.visible = false;
    if (rig.heldL) rig.heldL.visible = false;
  }
  // 头顶符号：三个错开相位往上飘、渐隐
  if (routine.fx !== undefined && e > 0.5) {
    const [glyph, color] = routine.fx;
    const top = rig.height / rig.body.scale.y;
    st.fxGroup.visible = true;
    for (const sprite of st.fx) {
      const material = sprite.material;
      const map = glyphTexture(glyph);
      if (material.map !== map) {
        material.map = map;
        material.needsUpdate = true;
      }
      material.color.set(color);
      const p = (t * 0.45 + (sprite.userData.phase as number)) % 1;
      sprite.position.set(0.18 + Math.sin(p * 6 + (sprite.userData.phase as number) * 9) * 0.08, top * 0.92 + p * 0.55, 0.05);
      sprite.scale.setScalar(0.14 + p * 0.08);
      material.opacity = Math.min(1, p * 4) * (1 - p);
    }
  }
  return { id: routine.id, label: routine.label, eyes: face.eyes, mouth: face.mouth };
}
