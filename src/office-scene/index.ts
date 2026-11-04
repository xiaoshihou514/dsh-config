/**
 * 智能体办公室 3D 场景（浏览器 ESM，按需从 `/dsh-config/office/scene.js` 加载）。
 *
 * - 办公室模式：组长在玻璃办公室，组员按名册分配工位；运行中坐下干活（打字 /
 *   思考 / 等待 / 沟通），空闲一会儿后走去茶水区；新成员从门口走进来；
 *   成员间的消息以信封飞行动画呈现，头顶气泡显示当前动作。
 * - 图鉴模式：全部厂商 × 档位，以及各岗位造型的展台。
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ROLE_COLOR, ROLE_LABEL, TIER_LABEL, VENDOR_LABEL } from "../office/classify.ts";
import type {
  OfficeInteraction,
  OfficeMember,
  OfficeSnapshot,
  RoleKind,
  Tier,
  ToolCategory,
  Vendor,
} from "../office/types.ts";
import { USER_ID } from "../office/types.ts";
import type { CharacterRig } from "./anime.ts";
import { buildCharacter } from "./sprite-character.ts";
import {
  LOUNGE,
  ROOM,
  SEAT_HEIGHT,
  buildDesk,
  buildDecor,
  buildLounge,
  buildRoom,
  type DeskParts,
} from "./furniture.ts";
import { drawScreen, type ScreenMode } from "./screens.ts";
import { createEnvironment } from "./environment.ts";
import { Voxels, voxelMaterial } from "./voxel.ts";
import { buildRoleProp } from "./props.ts";

export interface SceneOptions {
  readonly onSelect: (id: string | null) => void;
}

export interface OfficeScene {
  update(snapshot: OfficeSnapshot, live: Readonly<Record<string, boolean>>): void;
  select(id: string | null): void;
  focus(id: string): void;
  setMode(mode: "office" | "gallery"): void;
  /** 暂停 / 恢复渲染循环（场景被隐藏时暂停，不跟原生界面抢主线程）。 */
  setPaused(paused: boolean): void;
  /**
   * 醒目提醒：某人（通常是组长）头顶浮一个大「!」、脚下光圈扩散，人站起来朝镜头挥手。
   * report = 汇报完毕等你回复（金色），error = 这一轮出错停下（红色）；null 取消。
   */
  setAttention(id: string | null, kind?: "report" | "error"): void;
  dispose(): void;
}

// ---------------------------------------------------------------- 头像

let portraitRenderer: THREE.WebGLRenderer | undefined;
const portraitCache = new Map<string, string>();

function snapshotRenderer(): THREE.WebGLRenderer {
  if (portraitRenderer === undefined) {
    portraitRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    portraitRenderer.setPixelRatio(1);
    portraitRenderer.outputColorSpace = THREE.SRGBColorSpace;
    portraitRenderer.setClearColor(0x000000, 0);
  }
  return portraitRenderer;
}

function lit(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight("#ffffff", "#c8bca8", 2.2));
  const sun = new THREE.DirectionalLight("#fff4e0", 1.6);
  sun.position.set(3, 5, 6);
  scene.add(sun);
}

/** 角色头像：头部特写，略侧 20°。返回 data URL（按人设 × 档位 × 岗位缓存）。 */
export function portrait(vendor: Vendor, tier: Tier, role: RoleKind, size = 160): string {
  const key = `${vendor}:${tier}:${role}:${size}`;
  const hit = portraitCache.get(key);
  if (hit !== undefined) return hit;
  const renderer = snapshotRenderer();
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  lit(scene);
  const rig = buildCharacter(vendor, tier, role);
  rig.setFace?.("open", "none");
  if (rig.halo) rig.halo.visible = false;
  if (rig.heldR) rig.heldR.visible = false;
  if (rig.sparkles) rig.sparkles.visible = false;
  rig.armL.rotation.z = -0.3;
  rig.armR.rotation.z = 0.3;
  rig.root.rotation.y = 0.35;
  scene.add(rig.root);
  const h = rig.height;
  const cy = h * 0.74;
  const half = h * 0.22;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 50);
  camera.position.set(0, cy + 1.2, 10);
  camera.lookAt(0, cy, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  portraitCache.set(key, url);
  return url;
}

/** 岗位道具小图标（右下角角标用）。 */
export function propIcon(role: RoleKind, size = 64): string {
  const key = `prop:${role}:${size}`;
  const hit = portraitCache.get(key);
  if (hit !== undefined) return hit;
  const renderer = snapshotRenderer();
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  lit(scene);
  const geometry = buildRoleProp(role).geometry(0.1);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 0.62;
  const prop = new THREE.Mesh(geometry, voxelMaterial());
  prop.position.copy(center).multiplyScalar(-1);
  const holder = new THREE.Group();
  holder.add(prop);
  holder.rotation.set(0.25, -0.5, 0);
  scene.add(holder);
  const camera = new THREE.OrthographicCamera(-span, span, span, -span, 0.1, 50);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  portraitCache.set(key, url);
  return url;
}

export const SCENE_VERSION = "2026-11-03-1";

// ---------------------------------------------------------------- 布局

type P2 = readonly [number, number];

interface Spot {
  readonly x: number;
  readonly z: number;
  /** 绕 y 轴朝向（0 = 面朝 +z）。 */
  readonly facing: number;
  /** 从主过道到该点的路径（最后一个点就是该点）。 */
  readonly approach: readonly P2[];
  readonly seat?: "chair" | "sofa";
}

/** 圆桌布局：组长坐圆心，组员面朝圆心围一圈；前方（+z）留出进出的缺口。 */
export const RING_CENTER: P2 = [-1.5, -2];
const AISLE = 4.6;
const R1 = 4.4; // 第一圈座位半径
const R2 = 7.6; // 第二圈（超过 8 人时）
const WALK = 5.6; // 两圈之间的走道半径
const GAP = (30 * Math.PI) / 180; // 前方缺口半角
const RING1_SLOTS = 8;
const RING2_SPAN = (100 * Math.PI) / 180; // 第二圈只铺前半圈，避免撞后墙

/** 圆上一点；angle 0 = 正前方（+z），顺时针看为 +x。 */
function onRing(r: number, angle: number): P2 {
  return [RING_CENTER[0] + Math.sin(angle) * r, RING_CENTER[1] + Math.cos(angle) * r];
}

/** 沿圆弧从 a 走到 b 的折线点（不含起点）。 */
function arc(r: number, a: number, b: number): P2[] {
  const steps = Math.max(1, Math.ceil(Math.abs(b - a) / 0.3));
  const out: P2[] = [];
  for (let i = 1; i <= steps; i += 1) out.push(onRing(r, a + ((b - a) * i) / steps));
  return out;
}

const ENTRY: P2[] = [
  [RING_CENTER[0], AISLE],
  onRing(WALK, 0),
];

function deskSpot(index: number): Spot {
  let angle: number;
  let r: number;
  if (index < RING1_SLOTS) {
    // 从后排（面朝镜头）往前排填：不挡住圆心的组长。
    const order = [3, 4, 2, 5, 1, 6, 0, 7];
    angle = GAP + ((Math.PI * 2 - GAP * 2) * order[index]!) / (RING1_SLOTS - 1);
    r = R1;
  } else {
    const k = index - RING1_SLOTS;
    const slots = 9;
    const j = k % slots;
    // 左右交替往外铺：GAP+、-GAP-、……
    const step = (RING2_SPAN - GAP) / Math.ceil(slots / 2);
    const n = Math.floor(j / 2);
    angle = (j % 2 === 0 ? 1 : -1) * (GAP + step * (n + 0.5));
    r = R2;
  }
  const [x, z] = onRing(r, angle);
  const facing = Math.atan2(RING_CENTER[0] - x, RING_CENTER[1] - z);
  const a = angle > Math.PI ? angle - Math.PI * 2 : angle;
  let approach: P2[];
  if (r === R1) {
    // 走道弧线 → 从椅背方向径向走到座位
    approach = [...ENTRY, ...arc(WALK, 0, a), [x, z]];
  } else {
    // 第二圈座位在桌子外侧：从桌子旁绕出去
    const side = Math.sign(a) * 0.32;
    approach = [...ENTRY, ...arc(WALK, 0, a + side), onRing(r + 0.9, a + side), ...arc(r + 0.9, a + side, a), [x, z]];
  }
  return { x, z, facing, seat: "chair", approach };
}

const LEAD_DESK: Spot = {
  x: RING_CENTER[0],
  z: RING_CENTER[1],
  facing: 0,
  seat: "chair",
  approach: [
    ...ENTRY,
    [RING_CENTER[0], RING_CENTER[1] + 2.6],
    [RING_CENTER[0] + 1.6, RING_CENTER[1] + 2.0],
    [RING_CENTER[0] + 1.6, RING_CENTER[1] - 0.3],
    RING_CENTER,
  ],
};

const LEAD_IDLE: Spot = {
  x: RING_CENTER[0] + 1.35,
  z: RING_CENTER[1] - 1.0,
  facing: 0.6,
  approach: [
    ...ENTRY,
    [RING_CENTER[0], RING_CENTER[1] + 2.6],
    [RING_CENTER[0] + 1.6, RING_CENTER[1] + 2.0],
    [RING_CENTER[0] + 1.35, RING_CENTER[1] - 1.0],
  ],
};

/** 组长有事找你时站到桌前、面朝镜头。 */
const LEAD_CALL: Spot = {
  x: RING_CENTER[0] + 0.95,
  z: RING_CENTER[1] + 2.25,
  facing: 0.62,
  approach: [...ENTRY, [RING_CENTER[0], RING_CENTER[1] + 2.6], [RING_CENTER[0] + 0.95, RING_CENTER[1] + 2.25]],
};

const DOOR: Spot = { x: ROOM.x0 + 0.6, z: 4.6, facing: Math.PI / 2, approach: [[ROOM.x0 + 1.5, AISLE], [ROOM.x0 + 0.6, 4.6]] };

const TABLE: P2 = [LOUNGE.table[0], LOUNGE.table[1]];
function faceTo(x: number, z: number, target: P2): number {
  return Math.atan2(target[0] - x, target[1] - z);
}

/**
 * 休息区在后墙右侧、离圆桌不远：从主过道沿 x=4.6 往里走。沙发背靠后墙，坐下的人面朝 +z（朝镜头）；
 * 茶几左右两侧站着喝咖啡的人面朝茶几。
 */
const LOUNGE_X = 4.6;
const SOFA_Z = LOUNGE.sofa[1] + 0.15;
const SOFA_PATH_Z = LOUNGE.table[1] - 0.95;
const LOUNGE_SPOTS: readonly Spot[] = [
  ...[5.65, 6.5, 7.35].map(
    (x): Spot => ({
      x,
      z: SOFA_Z,
      facing: 0,
      seat: "sofa",
      approach: [[LOUNGE_X, AISLE], [LOUNGE_X, SOFA_PATH_Z], [x, SOFA_PATH_Z], [x, SOFA_Z]],
    }),
  ),
  // 站着的人只在茶几左右两侧（侧身对镜头），不站在沙发前面挡人、也不背对镜头
  ...(
    [
      [5.0, -6.3],
      [8.0, -6.3],
      [4.95, -5.4],
      [8.05, -5.4],
    ] as const
  ).map(([x, z]): Spot => ({ x, z, facing: faceTo(x, z, TABLE), approach: [[LOUNGE_X, AISLE], [LOUNGE_X, -4.7], [x, -4.7], [x, z]] })),
];

/** 两条入场路径共用的前缀（逐点相同）长度。 */
function sharedPrefix(a: readonly P2[], b: readonly P2[]): number {
  let k = 0;
  while (k < a.length - 1 && k < b.length - 1 && a[k]![0] === b[k]![0] && a[k]![1] === b[k]![1]) k += 1;
  return k;
}

/** 从一个点位走到另一个：沿来路退回到两条路径的分岔点，再沿新路径走进去（不必绕回主过道）。 */
function route(from: Spot, to: Spot): P2[] {
  const k = sharedPrefix(from.approach, to.approach);
  if (k === 0) return [...from.approach.slice(0, -1).reverse(), ...to.approach];
  return [...from.approach.slice(k, -1).reverse(), from.approach[k - 1]!, ...to.approach.slice(k)];
}

// ---------------------------------------------------------------- 样式

const CSS = `
.dso-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif}
.dso-label{position:absolute;left:0;top:0;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:3px;will-change:transform;white-space:nowrap}
.dso-tag{pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:5px;padding:2px 7px 2px 3px;border-radius:999px;background:rgba(20,24,33,.78);color:#fff;font-size:11px;line-height:16px;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.dso-tag.sel{outline:2px solid #fff}
.dso-role{padding:0 5px;border-radius:999px;font-size:10px;font-weight:600;color:#1b1b1b}
.dso-sub{opacity:.7;font-size:10px}
.dso-bubble{max-width:200px;overflow:hidden;text-overflow:ellipsis;padding:3px 8px;border-radius:9px;background:#fff;color:#1d2330;font-size:11px;line-height:15px;box-shadow:0 2px 6px rgba(0,0,0,.18);position:relative}
.dso-bubble:after{content:'';position:absolute;left:50%;bottom:-4px;margin-left:-4px;border:4px solid transparent;border-bottom:0;border-top-color:#fff}
.dso-bubble.wait{background:#efe9ff}.dso-bubble.wait:after{border-top-color:#efe9ff}
.dso-bubble.fail{background:#ffe3e3;color:#9b1c1c}.dso-bubble.fail:after{border-top-color:#ffe3e3}
.dso-bubble.idle{background:rgba(255,255,255,.75);color:#5b6372}.dso-bubble.idle:after{border-top-color:rgba(255,255,255,.75)}
.dso-say{max-width:240px;white-space:normal;padding:5px 9px;border-radius:10px;background:#2b3a55;color:#fff;font-size:11px;line-height:15px;box-shadow:0 3px 10px rgba(0,0,0,.25);animation:dso-pop .25s ease-out}
.dso-say b{color:#ffd76a;font-weight:600}
@keyframes dso-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
.dso-gallery{padding:2px 8px;border-radius:8px;background:rgba(20,24,33,.8);color:#fff;font-size:11px;text-align:center;line-height:15px}
.dso-ghint{position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(20,24,33,.7);color:#fff;font:12px system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif;pointer-events:none}
.dso-inspect{position:absolute;left:14px;top:14px;width:228px;padding:12px;border-radius:12px;background:rgba(20,24,33,.82);color:#fff;font:12px/1.5 system-ui,'PingFang SC','Noto Sans CJK SC',sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);backdrop-filter:blur(6px)}
.dso-inspect h4{margin:0;font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px}
.dso-inspect .sub{opacity:.7;margin:2px 0 10px}
.dso-inspect .grp{margin-top:8px}
.dso-inspect .grp>span{display:block;opacity:.6;font-size:11px;margin-bottom:4px}
.dso-inspect .row{display:flex;flex-wrap:wrap;gap:4px}
.dso-inspect button{border:0;border-radius:7px;padding:4px 9px;background:rgba(255,255,255,.12);color:#fff;font:inherit;cursor:pointer}
.dso-inspect button:hover{background:rgba(255,255,255,.22)}
.dso-inspect button.on{background:#f2b632;color:#1b1b1b}
.dso-inspect .nav{display:flex;gap:4px;margin-top:12px}
.dso-inspect .nav button{flex:1}
`;

function ensureCss(): void {
  if (document.getElementById("dsh-office-scene-css") !== null) return;
  const style = document.createElement("style");
  style.id = "dsh-office-scene-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CATEGORY_ICON: Record<ToolCategory, string> = {
  shell: "⌨️",
  read: "📖",
  edit: "✏️",
  search: "🔍",
  web: "🌐",
  team: "💬",
  plan: "📋",
  wait: "⏳",
  other: "🔧",
};

// ---------------------------------------------------------------- 角色

type Status = "running" | "inactive" | "provisioning" | "failed";

const grayMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, color: new THREE.Color("#9aa0a8") });

class Agent {
  member: OfficeMember;
  readonly rig: CharacterRig;
  readonly desk: DeskParts;
  readonly deskAt: Spot;
  idleAt: Spot;
  at: Spot;
  path: P2[] = [];
  moving = false;
  status: Status = "inactive";
  inactiveSince = 0;
  heading = 0;
  jumpAt = -10;
  screenMode: ScreenMode = "off";
  screenLabel = "";
  screenTick = 0;
  readonly label: HTMLDivElement;
  readonly tag: HTMLDivElement;
  readonly bubble: HTMLDivElement;
  readonly say: HTMLDivElement;
  sayUntil = 0;
  gray = false;
  /** 鼠标在头顶信息上（保持显示，名牌可点）。 */
  labelHover = false;
  /** 固定表情（图鉴细看时用）；缺省按状态自动。 */
  face: [Eyes, Mouth] | undefined;
  /** 醒目提醒：站到空地上朝镜头挥手（report）或垂头丧气（error）。 */
  attention: "report" | "error" | null = null;
  /** 有提醒时站的位置（组长：桌前）。 */
  callAt: Spot | undefined;

  constructor(
    member: OfficeMember,
    deskAt: Spot,
    idleAt: Spot,
    start: Spot,
    parent: THREE.Object3D,
    labels: HTMLElement,
    onTagClick: (id: string) => void,
  ) {
    this.member = member;
    this.deskAt = deskAt;
    this.idleAt = idleAt;
    this.at = start;
    this.rig = buildCharacter(member.vendor, member.tier, member.roleKind);
    for (const mesh of this.rig.meshes) mesh.userData.agentId = member.id;
    this.rig.root.position.set(start.x, 0, start.z);
    this.heading = start.facing;
    parent.add(this.rig.root);

    this.desk = buildDesk(member.roleKind, member.role === "lead");
    this.desk.group.position.set(deskAt.x, 0, deskAt.z);
    this.desk.group.rotation.y = deskAt.facing;
    parent.add(this.desk.group);

    this.label = document.createElement("div");
    this.label.className = "dso-label";
    this.say = document.createElement("div");
    this.say.className = "dso-say";
    this.say.style.display = "none";
    this.bubble = document.createElement("div");
    this.bubble.className = "dso-bubble";
    this.tag = document.createElement("div");
    this.tag.className = "dso-tag";
    this.tag.addEventListener("click", (event) => {
      event.stopPropagation();
      onTagClick(this.member.id);
    });
    this.label.append(this.say, this.bubble, this.tag);
    this.label.addEventListener("pointerenter", () => (this.labelHover = true));
    this.label.addEventListener("pointerleave", () => (this.labelHover = false));
    labels.appendChild(this.label);
    this.renderTag();
  }

  renderTag(): void {
    const m = this.member;
    const color = ROLE_COLOR[m.roleKind];
    this.tag.innerHTML = "";
    const role = document.createElement("span");
    role.className = "dso-role";
    role.style.background = color;
    role.textContent = ROLE_LABEL[m.roleKind];
    const name = document.createElement("span");
    name.textContent = m.name;
    const sub = document.createElement("span");
    sub.className = "dso-sub";
    sub.textContent = `${VENDOR_LABEL[m.vendor]}·${TIER_LABEL[m.tier]}`;
    this.tag.append(role, name, sub);
  }

  /** 目标位置：工位或休息点。 */
  wanted(now: number): Spot {
    if (this.attention !== null && this.status !== "running") return this.callAt ?? this.idleAt;
    if (this.status === "inactive" && now - this.inactiveSince > 6) return this.idleAt;
    return this.deskAt;
  }

  dispose(): void {
    this.rig.root.removeFromParent();
    this.desk.group.removeFromParent();
    this.desk.screenTexture.dispose();
    this.label.remove();
  }
}

function setGray(agent: Agent, gray: boolean): void {
  if (agent.gray === gray) return;
  agent.gray = gray;
  for (const mesh of agent.rig.meshes)
    mesh.material = gray ? grayMaterial : ((mesh.userData.material as THREE.Material | undefined) ?? mesh.material);
}

type Eyes = "open" | "closed" | "happy" | "half";
type Mouth = "none" | "open" | "smile" | "small";

/** 周期 period 秒里、相位 offset 起的 len 秒为真（用于偶发动作：眨眼、喝水、挥手……）。 */
function every(t: number, period: number, len: number, offset: number): number {
  const k = (((t + offset) % period) + period) % period;
  return k < len ? k / len : -1;
}

/** 两只手臂（左手 x<0：向外为 -z 旋转；右手向外为 +z）。 */
function arms(rig: CharacterRig, l: [number, number, number], r: [number, number, number]): void {
  rig.armL.rotation.set(l[0], l[1], l[2]);
  rig.armR.rotation.set(r[0], r[1], r[2]);
}

/** 每帧重置关节后按状态摆姿势、换表情。 */
function pose(agent: Agent, t: number, dt: number): void {
  const rig = agent.rig;
  const flagship = rig.tier === "flagship";
  for (const part of [rig.head, rig.armL, rig.armR, rig.legL, rig.legR, rig.body]) part.rotation.set(0, 0, 0);
  rig.skirt?.rotation.set(0, 0, 0);
  rig.upper?.rotation.set(0, 0, 0);
  rig.lower?.rotation.set(0, 0, 0);
  rig.body.position.set(0, 0, 0);
  const seed = (agent.member.id.length * 1.37 + agent.member.id.charCodeAt(0) * 0.11) % 10;
  let eyes: Eyes = "open";
  let mouth: Mouth = "none";

  const seated = !agent.moving && agent.at.seat !== undefined;
  if (rig.heldL) rig.heldL.visible = !seated;
  if (rig.heldR) rig.heldR.visible = true;
  if (rig.lower) rig.lower.scale.y = seated ? 0.55 : 1;

  if (agent.moving) {
    const w = t * 10;
    rig.legL.rotation.x = Math.sin(w) * 0.6;
    rig.legR.rotation.x = -Math.sin(w) * 0.6;
    // 手臂略往后收、小幅摆动、稍外张：肩在身体前沿，以竖直为中心摆看起来手总在前面。
    arms(rig, [0.18 - Math.sin(w) * 0.32, 0, -0.26], [0.18 + Math.sin(w) * 0.32, 0, 0.26]);
    rig.body.position.y = Math.abs(Math.sin(w)) * 0.035;
    if (rig.upper) rig.upper.rotation.z = Math.sin(w) * 0.04;
    rig.head.rotation.y = Math.sin(t * 0.9 + seed) * 0.15;
  } else if (seated) {
    const lift = flagship ? 0 : 0.18;
    rig.body.position.y = SEAT_HEIGHT + lift - rig.hipHeight;
    rig.body.position.z = flagship ? 0 : 0.12;
    rig.legL.rotation.x = -Math.PI / 2;
    rig.legR.rotation.x = -Math.PI / 2;
    if (rig.skirt) rig.skirt.rotation.x = -0.3;
    const atDesk = agent.at === agent.deskAt;
    const current = agent.member.current;
    if (agent.status === "failed") {
      rig.head.rotation.x = 0.45;
      arms(rig, [-0.25, 0, 0.1], [-0.25, 0, -0.1]);
      if (rig.upper) rig.upper.rotation.x = 0.2;
      eyes = "half";
      mouth = "small";
    } else if (atDesk && agent.status === "running") {
      const kind = current?.kind ?? "thinking";
      const category = current?.category;
      if (kind === "waiting") {
        // 抱臂等待：偶尔低头看表、叹气
        const watch = every(t, 8, 1.4, seed);
        if (watch >= 0) {
          arms(rig, [-1.6, 0, 0.55], [-1.25, 0, -0.9]);
          rig.head.rotation.x = 0.3;
        } else {
          arms(rig, [-1.25, 0, 0.95], [-1.3, 0, -0.95]);
          rig.head.rotation.y = Math.sin(t * 0.8 + seed) * 0.4;
        }
        rig.body.rotation.x = -0.06;
        rig.legR.rotation.x = -Math.PI / 2 + Math.max(0, Math.sin(t * 6)) * 0.15;
        if (every(t, 7, 0.8, seed + 2) >= 0) eyes = "closed";
      } else if (kind === "thinking") {
        // 托腮思考
        arms(rig, [-1.25, 0, 0.6], [-2.35 + Math.sin(t * 1.2) * 0.05, 0, -0.7]);
        rig.head.rotation.z = 0.15 + Math.sin(t * 0.9 + seed) * 0.05;
        rig.head.rotation.x = -0.12;
        if (rig.upper) rig.upper.rotation.z = 0.05;
        eyes = "half";
        mouth = every(t, 5, 1.2, seed) >= 0 ? "small" : "none";
      } else if (category === "team") {
        // 边说边比划
        arms(rig, [-1.2, 0, 0.3], [-1.75 + Math.sin(t * 5) * 0.3, 0, 0.15 + Math.sin(t * 3 + seed) * 0.2]);
        rig.head.rotation.y = Math.sin(t * 2 + seed) * 0.2;
        rig.head.rotation.x = Math.sin(t * 4) * 0.04;
        mouth = Math.floor(t * 6 + seed) % 2 === 0 ? "open" : "small";
        if (every(t, 4, 1.5, seed) >= 0) eyes = "happy";
      } else if (category === "plan" || category === "edit") {
        // 写写画画：右手小幅打圈
        arms(rig, [-1.3, 0, 0.45], [-1.42 + Math.sin(t * 6) * 0.08, 0, -0.25 + Math.cos(t * 6) * 0.08]);
        rig.head.rotation.x = 0.15;
        if (rig.upper) rig.upper.rotation.x = 0.06;
        if (category === "plan") mouth = "smile";
      } else if (category === "read" || category === "search" || category === "web") {
        // 阅读：手扶桌面，右手偶尔滚动，缓慢点头
        arms(rig, [-1.1, 0, 0.35], [-1.15 + (every(t, 3, 0.4, seed) >= 0 ? 0.12 : 0), 0, -0.3]);
        rig.head.rotation.x = 0.12 + Math.sin(t * 0.7) * 0.05;
        rig.head.rotation.y = Math.sin(t * 0.5 + seed) * 0.08;
        if (every(t, 6, 2, seed) >= 0) eyes = "half";
      } else {
        // 打字（命令行更快）
        const speed = category === "shell" ? 22 : 16;
        arms(rig, [-1.35 + Math.sin(t * speed + seed) * 0.12, 0, 0.35], [-1.35 + Math.sin(t * speed + seed + Math.PI) * 0.12, 0, -0.35]);
        rig.head.rotation.x = 0.1 + Math.sin(t * 2.3) * 0.02;
        if (rig.upper) rig.upper.rotation.x = 0.07;
      }
    } else if (atDesk) {
      // 工位空闲：手放腿上，偶尔伸懒腰打哈欠
      const stretch = every(t, 14, 1.8, seed);
      if (stretch >= 0) {
        arms(rig, [-3.0, 0, -0.35], [-3.0, 0, 0.35]);
        rig.head.rotation.x = -0.25;
        eyes = "closed";
        mouth = "open";
      } else {
        arms(rig, [-0.85, 0, 0.25], [-0.85, 0, -0.25]);
        rig.head.rotation.z = Math.sin(t * 0.6 + seed) * 0.08;
      }
    } else {
      // 沙发 / 休息区：手放腿上，隔一会儿抿一口咖啡
      const sip = every(t, 9, 1.8, seed);
      if (sip >= 0) {
        arms(rig, [-0.85, 0, 0.25], [-2.3, 0, -0.55]);
        rig.head.rotation.x = -0.1;
        eyes = "happy";
      } else {
        arms(rig, [-0.85, 0, 0.25], [-0.95, 0, -0.2]);
        rig.head.rotation.z = Math.sin(t * 0.6 + seed) * 0.08;
        rig.head.rotation.y = Math.sin(t * 0.33 + seed) * 0.35;
        mouth = every(t, 6, 2.2, seed + 1) >= 0 ? "smile" : "none";
      }
      rig.body.position.y += Math.sin(t * 1.6 + seed) * 0.006;
    }
  } else {
    // 站立：轻晃、东张西望，偶尔挥手打招呼
    rig.body.position.y = Math.sin(t * 2 + seed) * 0.008;
    rig.head.rotation.z = Math.sin(t * 0.7 + seed) * 0.07;
    rig.head.rotation.y = Math.sin(t * 0.37 + seed) * 0.3;
    // 有提醒：汇报完毕时频繁挥手、蹦一下；出错时低头、手垂着
    const calling = agent.attention === "report";
    const wave = agent.status === "provisioning" ? 0 : calling ? every(t, 2.6, 1.7, seed) : every(t, 12, 1.6, seed);
    if (calling) {
      rig.head.rotation.y *= 0.3;
      const hop = every(t, 2.6, 0.35, seed + 1.9);
      if (hop >= 0) rig.body.position.y += Math.sin(hop * Math.PI) * 0.12;
    }
    if (agent.attention === "error") {
      rig.head.rotation.x = 0.32;
      rig.head.rotation.y = Math.sin(t * 0.8 + seed) * 0.12;
      arms(rig, [0.05, 0, -0.12], [0.05, 0, 0.12]);
      eyes = "half";
      mouth = "small";
    } else if (agent.status === "provisioning" || wave >= 0) {
      arms(rig, [-0.15, 0, -0.3], [-2.75 + Math.sin(t * 9) * 0.25, 0, 0.45 + Math.sin(t * 9) * 0.15]);
      eyes = "happy";
      mouth = "smile";
    } else {
      arms(rig, [-0.15 + Math.sin(t * 1.3 + seed) * 0.05, 0, -0.3], [-0.3 + Math.sin(t * 1.1 + seed) * 0.05, 0, 0.3]);
    }
  }

  // 收到消息：轻跳 + 惊讶
  const since = t - agent.jumpAt;
  if (since >= 0 && since < 0.5) rig.body.position.y += Math.sin((since / 0.5) * Math.PI) * 0.22;
  if (since >= 0 && since < 1.0) {
    eyes = "open";
    mouth = "open";
  }
  // 眨眼（睁眼时）
  if (eyes === "open" && every(t, 3.7 + (seed % 1.5), 0.13, seed) >= 0) eyes = "closed";
  // 像素画角色的长发跟头部一起动：转头幅度减半，免得发梢甩得太远。
  if (rig.upper !== undefined) {
    rig.head.rotation.x *= 0.5;
    rig.head.rotation.y *= 0.5;
    rig.head.rotation.z *= 0.5;
  }
  const override = agent.face;
  if (override !== undefined) [eyes, mouth] = override;
  rig.setFace?.(eyes, mouth);

  if (rig.tail) {
    rig.tail.rotation.y = Math.sin(t * 1.8 + seed) * 0.28;
    rig.tail.rotation.x = Math.sin(t * 1.1 + seed) * 0.08;
  }
  if (rig.wings) rig.wings.rotation.x = Math.sin(t * 1.5 + seed) * 0.08;
  if (rig.halo) {
    rig.halo.rotation.y = t * 1.6;
    rig.halo.position.y = (rig.halo.userData.baseY as number) + Math.sin(t * 2) * 0.04;
  }
  if (rig.sparkles)
    rig.sparkles.children.forEach((child) => {
      const phase = (child.userData.phase as number) + t * 0.9;
      child.position.set(Math.cos(phase) * 0.75, Math.sin(phase * 2) * 0.12 + 0.3, Math.sin(phase) * 0.6);
      child.rotation.z = t * 2 + phase;
    });
  void dt;
}

// ---------------------------------------------------------------- 信封

interface Flight {
  readonly mesh: THREE.Object3D;
  readonly from: THREE.Vector3;
  /** 收件人当前位置（每帧按收件人实际位置更新——人可能已经走开）。 */
  readonly to: THREE.Vector3;
  readonly toId: string;
  readonly start: number;
  readonly duration: number;
  readonly onArrive: () => void;
  arrived: boolean;
}

const envelopeGeometry = new Map<string, THREE.BufferGeometry>();
function envelope(kind: OfficeInteraction["kind"]): THREE.Mesh {
  let geometry = envelopeGeometry.get(kind);
  if (geometry === undefined) {
    const v = new Voxels();
    if (kind === "spawn") {
      for (let x = -4; x <= 4; x += 1)
        for (let y = -4; y <= 4; y += 1) if (Math.abs(x) + Math.abs(y) <= 4 && (x === 0 || y === 0 || Math.abs(x) === Math.abs(y))) v.set(x, y, 0, "#ffd23f");
      v.set(0, 0, 1, "#ffffff");
    } else {
      const paper = kind === "instruction" ? "#ffe8a3" : "#ffffff";
      const seal = kind === "report" ? "#4fb85b" : kind === "instruction" ? "#e3b546" : "#e04f4f";
      v.box(-5, -3, 0, 5, 3, 0, paper);
      for (let x = -5; x <= 5; x += 1) v.set(x, 3 - Math.round(Math.abs(x) * 0.6), 1, "#e3e6eb");
      v.box(-1, -1, 1, 1, 1, 1, seal);
    }
    geometry = v.geometry(0.045);
    envelopeGeometry.set(kind, geometry);
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color("#333333") }));
  return mesh;
}

// ---------------------------------------------------------------- 主体

export function createOfficeScene(container: HTMLElement, options: SceneOptions): OfficeScene {
  ensureCss();
  let disposed = false;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.appendChild(renderer.domElement);

  const labels = document.createElement("div");
  labels.className = "dso-labels";
  container.appendChild(labels);
  const galleryLabels = document.createElement("div");
  galleryLabels.className = "dso-labels";
  galleryLabels.style.display = "none";
  container.appendChild(galleryLabels);

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.3;
  controls.minZoom = 0.5;
  controls.maxZoom = 5;
  controls.screenSpacePanning = true;

  function lights(scene: THREE.Scene, span: number): { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
    const hemi = new THREE.HemisphereLight("#eef3ff", "#b49a7a", 1.6);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
    sun.position.set(9, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    return { hemi, sun };
  }

  // ---- 办公室
  const office = new THREE.Scene();
  // 房间外的环境按本地时间切换早晨 / 正午 / 傍晚 / 夜晚
  const env = createEnvironment(office, container, lights(office, 17), RING_CENTER, ROOM, LOUNGE.table);
  // 休息区、书架等装饰不影响信息：首帧之后空闲时再搭，先让人物和工位出来。
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  const addDecor = () => {
    if (disposed) return;
    office.add(buildDecor(RING_CENTER), buildLounge());
  };
  if (idle !== undefined) idle(addDecor, { timeout: 600 });
  else setTimeout(addDecor, 200);
  let room: THREE.Group | undefined;
  const agents = new Map<string, Agent>();
  const seen = new Set<string>();
  const flights: Flight[] = [];
  let initialized = false;
  let selected: string | null = null;
  let focusPulse = -10;
  /** 鼠标悬停的角色（头顶信息只在悬停或选中时显示）。 */
  let hovered: string | null = null;
  /** 刚离开的角色：头顶信息再保留一会儿，好让鼠标移到名牌上点击。 */
  let lastHovered: string | null = null;
  let lastHoveredUntil = 0;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.64, 40),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  office.add(ring);

  // 醒目提醒：头顶大「!」（不被遮挡）、背后光晕、脚下扩散的光圈
  let attention: { id: string; kind: "report" | "error" } | null = null;
  const marker = (() => {
    const group = new THREE.Group();
    const v = new Voxels();
    v.box(-1, 4, -1, 1, 12, 1, "#ffffff");
    v.box(-1, 0, -1, 1, 2, 1, "#ffffff");
    const geometry = v.geometry(0.13);
    geometry.translate(0, -0.85, 0);
    const bang = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#ffc93a", depthTest: false }));
    bang.renderOrder = 21;
    // 深色描边：同形状放大一圈画在后面
    const outline = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#3a2a08", depthTest: false, side: THREE.BackSide }));
    outline.scale.setScalar(1.22);
    outline.renderOrder = 20;
    bang.add(outline);
    const glowTexture = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture, color: "#ffc93a", transparent: true, depthTest: false, blending: THREE.AdditiveBlending }),
    );
    glow.renderOrder = 19;
    const rings = [0, 1, 2].map(() => {
      const r = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.52, 40),
        new THREE.MeshBasicMaterial({ color: "#ffc93a", transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      r.rotation.x = -Math.PI / 2;
      group.add(r);
      return r;
    });
    group.add(glow, bang);
    group.visible = false;
    office.add(group);
    return { group, bang, glow, rings, color: "#ffc93a" };
  })();

  // ---- 图鉴
  let gallery: THREE.Scene | undefined;
  interface GalleryEntry {
    readonly rig: CharacterRig;
    readonly seed: number;
    readonly x: number;
    readonly z: number;
    readonly vendor: Vendor;
    readonly tier: Tier;
    readonly role: RoleKind;
    readonly title: string;
    readonly pad: THREE.Mesh;
    readonly label: HTMLElement;
  }
  const galleryRigs: GalleryEntry[] = [];
  function buildGallery(): THREE.Scene {
    const scene = new THREE.Scene();
    lights(scene, 14);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(13.5, 14, 0.4, 64), new THREE.MeshLambertMaterial({ color: "#e9e2d6" }));
    stage.position.y = -0.2;
    stage.receiveShadow = true;
    scene.add(stage);
    const vendors: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];
    const tiers: Tier[] = ["flagship", "fast"];
    const add = (vendor: Vendor, tier: Tier, role: RoleKind, x: number, z: number, text: string, color?: string) => {
      const rig = buildCharacter(vendor, tier, role);
      rig.root.position.set(x, 0, z);
      scene.add(rig.root);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.06, 24), new THREE.MeshLambertMaterial({ color: color ?? "#d4cbbd" }));
      pad.position.set(x, 0.03, z);
      pad.receiveShadow = true;
      scene.add(pad);
      const label = document.createElement("div");
      galleryRigs.push({ rig, seed: x * 1.3 + z, x, z, vendor, tier, role, title: text, pad, label });
      for (const mesh of rig.meshes) mesh.userData.galleryIndex = galleryRigs.length - 1;
      label.className = "dso-label";
      const inner = document.createElement("div");
      inner.className = "dso-gallery";
      inner.textContent = text;
      label.appendChild(inner);
      galleryLabels.appendChild(label);
      label.dataset.x = String(x);
      label.dataset.z = String(z);
    };
    tiers.forEach((tier, row) =>
      vendors.forEach((vendor, i) =>
        add(vendor, tier, "general", -8.8 + i * 2.2, -7 + row * 6, `${VENDOR_LABEL[vendor]} · ${TIER_LABEL[tier]}`),
      ),
    );
    const roles: RoleKind[] = ["lead", "frontend", "backend", "qa", "reviewer", "docs", "design", "devops", "data", "general"];
    roles.forEach((role, i) => add("claude", "fast", role, -8.55 + i * 1.9, 7.6, ROLE_LABEL[role], ROLE_COLOR[role]));
    return scene;
  }

  let mode: "office" | "gallery" = "office";
  // 办公室是固定机位（不能旋转 / 平移 / 缩放），按画布大小自动把整个房间框进画面
  const OFFICE_ANGLE = { polar: 1.0, azimuth: 0.62 };
  const galleryView = { target: new THREE.Vector3(0, 1.4, 0.4), zoom: 1.25, polar: 1.22, azimuth: 0 };
  function applyView(view: typeof galleryView): void {
    controls.target.copy(view.target);
    const r = 60;
    camera.position.set(
      view.target.x + r * Math.sin(view.polar) * Math.sin(view.azimuth),
      view.target.y + r * Math.cos(view.polar),
      view.target.z + r * Math.sin(view.polar) * Math.cos(view.azimuth),
    );
    camera.zoom = view.zoom;
    camera.updateProjectionMatrix();
    controls.update();
  }
  /** 房间（含墙厚、底座、墙顶上方留给头顶信息的空间）的八个角，投到画面里求外接框。 */
  const FIT_BOX = new THREE.Box3(new THREE.Vector3(ROOM.x0 - 0.3, -0.5, ROOM.z0 - 0.3), new THREE.Vector3(ROOM.x1 + 0.3, ROOM.wallHeight + 0.6, ROOM.z1 + 0.3));
  function fitOffice(): void {
    const center = FIT_BOX.getCenter(new THREE.Vector3());
    applyView({ target: center, zoom: 1, ...OFFICE_ANGLE });
    camera.updateMatrixWorld();
    const inv = camera.matrixWorldInverse;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      const p = new THREE.Vector3(
        i & 1 ? FIT_BOX.max.x : FIT_BOX.min.x,
        i & 2 ? FIT_BOX.max.y : FIT_BOX.min.y,
        i & 4 ? FIT_BOX.max.z : FIT_BOX.min.z,
      ).applyMatrix4(inv);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    // 把外接框中心挪到画面中心，再按宽高取较小的缩放（留一点边）
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const shift = right.multiplyScalar((x0 + x1) / 2).add(up.multiplyScalar((y0 + y1) / 2));
    controls.target.add(shift);
    camera.position.add(shift);
    camera.zoom = Math.min((camera.right - camera.left) / (x1 - x0), (camera.top - camera.bottom) / (y1 - y0)) * 0.96;
    camera.updateProjectionMatrix();
  }
  function setOfficeControls(on: boolean): void {
    controls.enableRotate = on;
    controls.enablePan = on;
    controls.enableZoom = on;
  }

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    const view = aspect > 1.4 ? 21 : 26;
    camera.left = (-view * aspect) / 2;
    camera.right = (view * aspect) / 2;
    camera.top = view / 2;
    camera.bottom = -view / 2;
    camera.updateProjectionMatrix();
    if (mode === "office") fitOffice();
  }
  setOfficeControls(false);
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  // ---- 点选
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt: [number, number] | null = null;
  const onDown = (event: PointerEvent) => {
    downAt = [event.clientX, event.clientY];
  };
  const onUp = (event: PointerEvent) => {
    if (downAt === null) return;
    const moved = Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]);
    downAt = null;
    if (moved > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    if (mode === "gallery") {
      if (inspecting !== null) return;
      const hit = raycaster.intersectObjects(galleryRigs.flatMap((g) => g.rig.meshes), false)[0];
      const index = hit?.object.userData.galleryIndex as number | undefined;
      if (index !== undefined) inspect(index);
      return;
    }
    const meshes = [...agents.values()].flatMap((agent) => agent.rig.meshes);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    const id = (hit?.object.userData.agentId as string | undefined) ?? null;
    options.onSelect(id);
  };
  let hoverPending = false;
  let hoverAt: [number, number] = [0, 0];
  const onMove = (event: PointerEvent) => {
    if (mode !== "office") return;
    hoverAt = [event.clientX, event.clientY];
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((hoverAt[0] - rect.left) / rect.width) * 2 - 1, -((hoverAt[1] - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...agents.values()].flatMap((agent) => agent.rig.meshes), false)[0];
      const next = (hit?.object.userData.agentId as string | undefined) ?? null;
      if (hovered !== null && next !== hovered) {
        lastHovered = hovered;
        lastHoveredUntil = clock.elapsedTime + 0.6;
      }
      hovered = next;
      renderer.domElement.style.cursor = hovered === null ? "" : "pointer";
    });
  };
  const onLeave = () => {
    if (hovered !== null) {
      lastHovered = hovered;
      lastHoveredUntil = clock.elapsedTime + 0.6;
    }
    hovered = null;
  };
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("pointerleave", onLeave);
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  // ---- 图鉴细看
  type InspectPose = "stand" | "walk" | "type" | "read" | "write" | "think" | "wait" | "talk" | "idle" | "lounge" | "failed";
  const POSES: [InspectPose, string][] = [
    ["stand", "站立"],
    ["walk", "走路"],
    ["type", "打字"],
    ["read", "阅读"],
    ["write", "书写"],
    ["think", "思考"],
    ["wait", "等待"],
    ["talk", "沟通"],
    ["idle", "工位摸鱼"],
    ["lounge", "喝咖啡"],
    ["failed", "沮丧"],
  ];
  const FACES: [string, [Eyes, Mouth] | undefined][] = [
    ["自动", undefined],
    ["普通", ["open", "none"]],
    ["闭眼", ["closed", "none"]],
    ["开心", ["happy", "smile"]],
    ["困倦", ["half", "small"]],
    ["惊讶", ["open", "open"]],
    ["微笑", ["open", "smile"]],
  ];
  let inspectFace: [Eyes, Mouth] | undefined;
  const ANGLES: [number, string][] = [
    [0, "正面"],
    [Math.PI / 4, "斜侧"],
    [Math.PI / 2, "侧面"],
    [Math.PI, "背面"],
  ];
  let inspecting: number | null = null;
  let inspectYaw = 0;
  let inspectSpin = true;
  let inspectPose: InspectPose = "stand";
  const galleryHint = document.createElement("div");
  galleryHint.className = "dso-ghint";
  galleryHint.textContent = "点击角色查看细节";
  galleryHint.style.display = "none";
  container.appendChild(galleryHint);
  const panel = document.createElement("div");
  panel.className = "dso-inspect";
  panel.style.display = "none";
  container.appendChild(panel);
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  // 坐姿用的小凳（细看时才显示）
  const stool = new THREE.Group();
  {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.5), new THREE.MeshLambertMaterial({ color: "#3c4250" }));
    seat.position.y = SEAT_HEIGHT - 0.04;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, SEAT_HEIGHT - 0.08, 8), new THREE.MeshLambertMaterial({ color: "#9aa3ad" }));
    leg.position.y = (SEAT_HEIGHT - 0.08) / 2;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 16), new THREE.MeshLambertMaterial({ color: "#9aa3ad" }));
    foot.position.y = 0.02;
    stool.add(seat, leg, foot);
    for (const m of [seat, leg, foot]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    stool.visible = false;
  }
  /** 细看时套给 pose() 的假成员：只用到 pose 读取的字段。 */
  const fakeSpot = (seat: boolean): Spot => ({ x: 0, z: 0, facing: 0, approach: [], ...(seat ? { seat: "chair" as const } : {}) });
  const deskSpotFake = fakeSpot(true);
  const loungeSpotFake = fakeSpot(true);
  const standSpot = fakeSpot(false);
  function fakeAgent(entry: GalleryEntry): Agent {
    const p = inspectPose;
    const seated = p !== "stand" && p !== "walk";
    const working = ["type", "read", "write", "think", "wait", "talk"].includes(p);
    const current =
      p === "type"
        ? { kind: "tool", category: "edit", label: "", since: 0 }
        : p === "read"
          ? { kind: "tool", category: "read", label: "", since: 0 }
          : p === "write"
            ? { kind: "tool", category: "plan", label: "", since: 0 }
            : p === "wait"
              ? { kind: "waiting", category: "wait", label: "", since: 0 }
              : p === "talk"
                ? { kind: "tool", category: "team", label: "", since: 0 }
                : { kind: "thinking", label: "", since: 0 };
    return {
      rig: entry.rig,
      moving: p === "walk",
      at: !seated ? standSpot : p === "lounge" ? loungeSpotFake : deskSpotFake,
      deskAt: deskSpotFake,
      status: p === "failed" ? "failed" : working ? "running" : "inactive",
      jumpAt: -10,
      face: inspectFace,
      member: { id: entry.title, current },
    } as unknown as Agent;
  }

  function renderPanel(): void {
    if (inspecting === null) return;
    const entry = galleryRigs[inspecting]!;
    panel.innerHTML = "";
    const h = document.createElement("h4");
    const chip = document.createElement("span");
    chip.className = "dso-role";
    chip.style.background = ROLE_COLOR[entry.role];
    chip.textContent = ROLE_LABEL[entry.role];
    h.append(document.createTextNode(`${VENDOR_LABEL[entry.vendor]}`), chip);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${TIER_LABEL[entry.tier]}档 · 拖动旋转视角 · 滚轮缩放 · Esc 返回`;
    panel.append(h, sub);
    const group = (title: string, items: [string, boolean, () => void][]) => {
      const g = document.createElement("div");
      g.className = "grp";
      const t = document.createElement("span");
      t.textContent = title;
      const row = document.createElement("div");
      row.className = "row";
      for (const [text, on, act] of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        if (on) b.className = "on";
        b.addEventListener("click", () => {
          act();
          renderPanel();
        });
        row.appendChild(b);
      }
      g.append(t, row);
      panel.appendChild(g);
    };
    const yaw = ((inspectYaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    group("角度", [
      ...ANGLES.map(([a, text]): [string, boolean, () => void] => [
        text,
        !inspectSpin && Math.abs(yaw - a) < 0.01,
        () => {
          inspectSpin = false;
          inspectYaw = a;
        },
      ]),
      ["自动旋转", inspectSpin, () => (inspectSpin = !inspectSpin)],
    ]);
    group(
      "动作",
      POSES.map(([p, text]) => [text, inspectPose === p, () => (inspectPose = p)]),
    );
    if (galleryRigs[inspecting]!.rig.setFace !== undefined)
      group(
        "表情",
        FACES.map(([text, f]) => [text, inspectFace === f, () => (inspectFace = f)]),
      );
    const nav = document.createElement("div");
    nav.className = "nav";
    const mk = (text: string, act: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", act);
      nav.appendChild(b);
    };
    mk("‹ 上一个", () => inspect((inspecting! - 1 + galleryRigs.length) % galleryRigs.length));
    mk("返回图鉴", () => uninspect());
    mk("下一个 ›", () => inspect((inspecting! + 1) % galleryRigs.length));
    panel.appendChild(nav);
  }

  function inspect(index: number): void {
    const first = inspecting === null;
    if (first) {
      galleryView.target.copy(controls.target);
      galleryView.zoom = camera.zoom;
    }
    inspecting = index;
    inspectYaw = 0;
    const entry = galleryRigs[index]!;
    galleryRigs.forEach((g, i) => {
      const on = i === index;
      g.rig.root.visible = on;
      g.pad.visible = on;
    });
    galleryLabels.style.display = "none";
    galleryHint.style.display = "none";
    stool.position.set(entry.x, 0, entry.z - 0.05);
    stool.removeFromParent();
    gallery?.add(stool);
    const h = entry.rig.height;
    const viewHeight = camera.top - camera.bottom;
    controls.maxZoom = 16;
    applyView({
      target: new THREE.Vector3(entry.x, h * 0.52, entry.z),
      zoom: viewHeight / (h * 1.45),
      polar: 1.38,
      azimuth: 0,
    });
    panel.style.display = "";
    renderPanel();
  }

  function uninspect(): void {
    if (inspecting === null) return;
    const entry = galleryRigs[inspecting]!;
    entry.rig.root.rotation.set(0, 0, 0);
    inspecting = null;
    inspectPose = "stand";
    inspectFace = undefined;
    inspectSpin = true;
    stool.visible = false;
    for (const g of galleryRigs) {
      g.rig.root.visible = true;
      g.pad.visible = true;
    }
    panel.style.display = "none";
    galleryLabels.style.display = "";
    galleryHint.style.display = "";
    controls.maxZoom = 5;
    applyView(galleryView);
  }

  const onKey = (event: KeyboardEvent) => {
    if (mode !== "gallery" || inspecting === null) return;
    if (event.key === "Escape") {
      // 拦在弹窗关闭之前：先退出细看。
      event.stopPropagation();
      event.preventDefault();
      uninspect();
    } else if (event.key === "ArrowLeft") inspect((inspecting - 1 + galleryRigs.length) % galleryRigs.length);
    else if (event.key === "ArrowRight") inspect((inspecting + 1) % galleryRigs.length);
  };
  document.addEventListener("keydown", onKey, true);

  // ---- 状态同步
  function idleSpotFor(member: OfficeMember, index: number): Spot {
    if (member.role === "lead") return LEAD_IDLE;
    return LOUNGE_SPOTS[index % LOUNGE_SPOTS.length]!;
  }

  function statusOf(member: OfficeMember, live: Readonly<Record<string, boolean>>): Status {
    if (member.phase === "failed") return "failed";
    if (member.phase === "provisioning") return "provisioning";
    return (live[member.id] ?? member.busy) ? "running" : "inactive";
  }

  function nameOf(id: string): string {
    if (id === USER_ID) return "你";
    return agents.get(id)?.member.name ?? "成员";
  }

  function headPosition(id: string, now: number): THREE.Vector3 | undefined {
    const agent = agents.get(id);
    if (agent === undefined) return undefined;
    const root = agent.rig.root.position;
    return new THREE.Vector3(root.x, agent.rig.body.position.y + agent.rig.height * 0.85, root.z);
    void now;
  }

  function showSay(agent: Agent, html: string, now: number): void {
    // 组长的动态放在左侧信息栏，3D 里不再冒气泡
    if (agent.member.role === "lead") return;
    agent.say.innerHTML = html;
    agent.say.style.display = "";
    agent.sayUntil = now + 5;
  }

  function escape(text: string): string {
    return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  }

  function launch(item: OfficeInteraction, delay: number): void {
    const now = clock.elapsedTime;
    const target = agents.get(item.to);
    if (target === undefined) return;
    const fromPos =
      item.from === USER_ID
        ? new THREE.Vector3(target.rig.root.position.x + 2, 7, target.rig.root.position.z + 5)
        : headPosition(item.from, now);
    const toPos = headPosition(item.to, now);
    if (fromPos === undefined || toPos === undefined) return;
    const mesh = envelope(item.kind);
    mesh.visible = false;
    office.add(mesh);
    flights.push({
      mesh,
      from: fromPos,
      to: toPos,
      toId: item.to,
      start: now + delay,
      duration: 1.5 + Math.min(1, fromPos.distanceTo(toPos) / 20),
      arrived: false,
      onArrive: () => {
        target.jumpAt = clock.elapsedTime;
        if (item.from === USER_ID) showSay(target, `📨 收到<b>你</b>的指令：${escape(item.preview.slice(0, 40))}`, clock.elapsedTime);
      },
    });
    const sender = agents.get(item.from);
    if (sender !== undefined) {
      const verb = item.kind === "spawn" ? "招募" : item.kind === "report" ? "完工汇报" : "→";
      setTimeout(
        () =>
          showSay(
            sender,
            `${verb} <b>${escape(nameOf(item.to))}</b>：${escape(item.preview.slice(0, 46))}`,
            clock.elapsedTime,
          ),
        delay * 1000,
      );
    }
  }

  function update(snapshot: OfficeSnapshot, live: Readonly<Record<string, boolean>>): void {
    const now = clock.elapsedTime;
    // 项目名变了（改名）就重搭房间（招牌在墙上）
    const project = snapshot.projectName ?? snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目";
    if (room === undefined || room.userData.project !== project) {
      room?.removeFromParent();
      room = buildRoom(`${project} 项目组`);
      room.userData.project = project;
      office.add(room);
      env.applyRoom(room);
    }
    const ids = new Set(snapshot.members.map((m) => m.id));
    for (const [id, agent] of agents)
      if (!ids.has(id)) {
        agent.dispose();
        agents.delete(id);
      }
    let teammateIndex = 0;
    snapshot.members.forEach((member) => {
      const index = member.role === "lead" ? -1 : teammateIndex++;
      let agent = agents.get(member.id);
      const status = statusOf(member, live);
      if (agent === undefined) {
        const deskAt = member.role === "lead" ? LEAD_DESK : deskSpot(index);
        const idleAt = idleSpotFor(member, Math.max(0, index));
        const fresh = initialized && member.role !== "lead";
        const start = fresh ? DOOR : status === "inactive" && member.role !== "lead" ? idleAt : deskAt;
        agent = new Agent(member, deskAt, idleAt, start, office, labels, (id) => options.onSelect(id));
        if (member.role === "lead") agent.callAt = LEAD_CALL;
        agent.inactiveSince = status === "inactive" && !fresh ? -100 : now;
        agents.set(member.id, agent);
      } else if (
        agent.member.vendor !== member.vendor ||
        agent.member.tier !== member.tier ||
        agent.member.roleKind !== member.roleKind
      ) {
        // 模型或岗位变化：重建角色。
        const { deskAt, idleAt, at } = agent;
        agent.dispose();
        agent = new Agent(member, deskAt, idleAt, at, office, labels, (id) => options.onSelect(id));
        if (member.role === "lead") agent.callAt = LEAD_CALL;
        agents.set(member.id, agent);
      }
      if (agent.status !== "inactive" && status === "inactive") agent.inactiveSince = now;
      agent.status = status;
      agent.member = member;
      agent.attention = attention?.id === member.id ? attention.kind : null;
      agent.renderTag();
    });

    for (const item of snapshot.interactions) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!initialized) continue;
      launch(item, flights.filter((f) => !f.arrived).length * 0.35);
    }
    if (!initialized) {
      // 首次打开：回放最近一条交流，让场景有点动静。
      const last = snapshot.interactions.at(-1);
      if (last !== undefined) setTimeout(() => launch(last, 0), 600);
    }

    initialized = true;
  }

  // ---- 每帧
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  let frame = 0;

  function bubbleOf(agent: Agent): { text: string; cls: string } | null {
    const m = agent.member;
    if (m.role === "lead") return null;
    switch (agent.status) {
      case "failed":
        return { text: `⚠️ 创建失败${m.error ? `：${m.error}` : ""}`, cls: "fail" };
      case "provisioning":
        return { text: "✨ 入职中…", cls: "" };
      case "running": {
        const current = m.current;
        if (current === undefined) return { text: "💭 工作中…", cls: "" };
        if (current.kind === "thinking") return { text: "💭 思考中…", cls: "" };
        if (current.kind === "waiting") return { text: "⏳ 等待组员进展", cls: "wait" };
        return { text: `${CATEGORY_ICON[current.category ?? "other"]} ${current.label}`, cls: "" };
      }
      default:
        return agent.at === agent.idleAt && !agent.moving ? { text: "☕ 休息", cls: "idle" } : null;
    }
  }

  function screenOf(agent: Agent): [ScreenMode, string] {
    if (agent.status === "failed") return ["failed", ""];
    if (agent.status !== "running") return [agent.at === agent.deskAt && !agent.moving ? "idle" : "off", ""];
    const current = agent.member.current;
    if (current === undefined || current.kind === "thinking") return ["thinking", "思考中"];
    if (current.kind === "waiting") return ["wait", current.label];
    return [current.category ?? "other", current.label];
  }

  function tick(): void {
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    frame += 1;
    if (mode !== "office") controls.update();

    if (mode === "office") {
      for (const agent of agents.values()) {
        // 路径规划
        const want = agent.wanted(t);
        if (!agent.moving && want !== agent.at) {
          agent.path = route(agent.at, want);
          agent.at = want;
          agent.moving = true;
        }
        if (agent.moving) {
          const target = agent.path[0];
          if (target === undefined) {
            agent.moving = false;
          } else {
            const pos = agent.rig.root.position;
            const dx = target[0] - pos.x;
            const dz = target[1] - pos.z;
            const dist = Math.hypot(dx, dz);
            const step = 2.4 * dt;
            if (dist <= step) {
              pos.x = target[0];
              pos.z = target[1];
              agent.path.shift();
              if (agent.path.length === 0) agent.moving = false;
            } else {
              pos.x += (dx / dist) * step;
              pos.z += (dz / dist) * step;
              agent.heading = Math.atan2(dx, dz);
            }
          }
        }
        const facing = agent.moving ? agent.heading : agent.at.facing;
        let diff = facing - agent.rig.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        agent.rig.root.rotation.y += diff * Math.min(1, dt * 10);
        setGray(agent, agent.status === "failed");
        pose(agent, t, dt);

        // 显示器
        const [screenMode, screenLabel] = screenOf(agent);
        const animated = screenMode !== "off" && screenMode !== "failed";
        if (screenMode !== agent.screenMode || screenLabel !== agent.screenLabel || (animated && t - agent.screenTick > 0.45)) {
          agent.screenMode = screenMode;
          agent.screenLabel = screenLabel;
          agent.screenTick = t;
          drawScreen(agent.desk.screenCanvas, screenMode, agent.member.roleKind, t * 2, screenLabel);
          agent.desk.screenTexture.needsUpdate = true;
          (agent.desk.statusLight.material as THREE.MeshBasicMaterial).color.set(
            agent.status === "running" ? "#4fe07a" : agent.status === "failed" ? "#e04f4f" : "#8a93a3",
          );
        }
        for (const led of agent.desk.blinkers)
          led.visible = agent.status !== "running" || Math.sin(t * 9 + (led.userData.phase as number)) > -0.2;
      }

      // 信封
      for (let i = flights.length - 1; i >= 0; i -= 1) {
        const flight = flights[i]!;
        const k = (t - flight.start) / flight.duration;
        if (k < 0) continue;
        flight.mesh.visible = true;
        if (k >= 1) {
          if (!flight.arrived) {
            flight.arrived = true;
            flight.onArrive();
          }
          flight.mesh.removeFromParent();
          flights.splice(i, 1);
          continue;
        }
        // 追着收件人当前的位置飞
        const target = headPosition(flight.toId, t);
        if (target !== undefined) flight.to.copy(target);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const mid = tmp.copy(flight.from).add(flight.to).multiplyScalar(0.5);
        mid.y += 2 + flight.from.distanceTo(flight.to) * 0.12;
        const a = flight.from.clone().lerp(mid, e);
        const b = mid.clone().lerp(flight.to, e);
        flight.mesh.position.copy(a.lerp(b, e));
        flight.mesh.rotation.set(Math.sin(t * 6) * 0.3, t * 4, Math.sin(t * 5) * 0.2);
        flight.mesh.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.4);
      }

      // 醒目提醒
      const called = attention === null ? undefined : agents.get(attention.id);
      marker.group.visible = called !== undefined;
      if (called !== undefined) {
        const root = called.rig.root.position;
        const color = attention!.kind === "error" ? "#ff5a4f" : "#ffc93a";
        if (marker.color !== color) {
          marker.color = color;
          marker.bang.material.color.set(color);
          marker.glow.material.color.set(color);
          for (const r of marker.rings) r.material.color.set(color);
        }
        const top = called.rig.body.position.y + called.rig.height + (called.rig.halo ? 0.75 : 0.35);
        marker.bang.position.set(root.x, top + 0.8 + Math.sin(t * 3.2) * 0.15, root.z);
        marker.bang.rotation.y = Math.sin(t * 1.4) * 0.5;
        marker.glow.position.copy(marker.bang.position);
        marker.glow.scale.setScalar(3.2 + Math.sin(t * 4) * 0.45);
        marker.rings.forEach((r, i) => {
          const k = (t * 0.8 + i / marker.rings.length) % 1;
          r.position.set(root.x, 0.04, root.z);
          r.scale.setScalar(0.6 + k * 3.2);
          r.material.opacity = (1 - k) * 0.75;
        });
      }

      // 选中光环
      const sel = selected === null ? undefined : agents.get(selected);
      ring.visible = sel !== undefined;
      if (sel !== undefined) {
        ring.position.x = sel.rig.root.position.x;
        ring.position.z = sel.rig.root.position.z;
        // 「定位」时光环先放大再收回，闪几下
        const pulse = t - focusPulse < 1.6 ? Math.abs(Math.sin((t - focusPulse) * 6)) * (1.6 - (t - focusPulse)) * 0.9 : 0;
        ring.scale.setScalar(1 + Math.sin(t * 4) * 0.06 + pulse);
        (ring.material as THREE.MeshBasicMaterial).color.set(ROLE_COLOR[sel.member.roleKind]);
      }
      // 挂钟
      const clockObj = room?.userData.clock as THREE.Group | undefined;
      const hands = clockObj?.userData.hands as THREE.Mesh[] | undefined;
      if (hands !== undefined) {
        const date = new Date();
        hands[0]!.rotation.z = -(date.getMinutes() / 60) * Math.PI * 2;
        hands[1]!.rotation.z = -((date.getHours() % 12) / 12) * Math.PI * 2 + Math.PI / 2;
      }

      renderer.render(office, camera);
      updateLabels(t);
    } else if (gallery !== undefined) {
      if (inspecting !== null) {
        const entry = galleryRigs[inspecting]!;
        if (inspectSpin) inspectYaw += dt * 0.6;
        const seated = inspectPose !== "stand" && inspectPose !== "walk";
        stool.visible = seated;
        pose(fakeAgent(entry), t, dt);
        entry.rig.root.rotation.y = inspectYaw;
        // 坐姿时人朝 +z、凳子在身后：凳子跟着转。
        stool.rotation.y = inspectYaw;
        stool.position.set(entry.x - Math.sin(inspectYaw) * 0.05, 0, entry.z - Math.cos(inspectYaw) * 0.05);
        const rig = entry.rig;
        if (rig.halo) rig.halo.rotation.y = t * 1.6;
        renderer.render(gallery, camera);
        return;
      }
      for (const { rig, seed } of galleryRigs) {
        rig.root.rotation.y = Math.sin(t * 0.4 + seed) * 0.35;
        rig.body.position.y = Math.sin(t * 2 + seed) * 0.01;
        rig.head.rotation.z = Math.sin(t * 0.8 + seed) * 0.07;
        rig.armR.rotation.set(-0.3 + Math.sin(t * 1.2 + seed) * 0.08, 0, 0.32);
        rig.armL.rotation.set(-0.15, 0, -0.32);
        rig.setFace?.(every(t, 4, 0.13, seed) >= 0 ? "closed" : "open", "none");
        if (rig.tail) rig.tail.rotation.y = Math.sin(t * 1.8 + seed) * 0.3;
        if (rig.halo) rig.halo.rotation.y = t * 1.6;
        if (rig.sparkles)
          rig.sparkles.children.forEach((child) => {
            const phase = (child.userData.phase as number) + t * 0.9;
            child.position.set(Math.cos(phase) * 0.75, Math.sin(phase * 2) * 0.12 + 0.3, Math.sin(phase) * 0.6);
          });
      }
      renderer.render(gallery, camera);
      const w = container.clientWidth;
      const h = container.clientHeight;
      for (const label of galleryLabels.children as HTMLCollectionOf<HTMLElement>) {
        tmp.set(Number(label.dataset.x), -0.1, Number(label.dataset.z)).project(camera);
        label.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h + 22}px) translate(-50%,-100%)`;
      }
    }
    void frame;
  }

  function updateLabels(t: number): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    for (const agent of agents.values()) {
      // 头顶信息只在悬停或选中时显示
      const id = agent.member.id;
      const show = id === hovered || id === selected || agent.labelHover || (id === lastHovered && t < lastHoveredUntil);
      agent.label.style.display = show ? "" : "none";
      if (!show) {
        if (agent.sayUntil > 0 && t > agent.sayUntil) {
          agent.sayUntil = 0;
          agent.say.style.display = "none";
        }
        continue;
      }
      const root = agent.rig.root.position;
      const top = agent.rig.body.position.y + agent.rig.height + (agent.rig.halo ? 0.62 : 0.12);
      tmp.set(root.x, top, root.z).project(camera);
      const x = ((tmp.x + 1) / 2) * w;
      const y = ((1 - tmp.y) / 2) * h;
      agent.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%,-100%)`;
      agent.label.style.zIndex = String(Math.round((1 - tmp.z) * 1000));
      const bubble = bubbleOf(agent);
      if (bubble === null) agent.bubble.style.display = "none";
      else {
        agent.bubble.style.display = "";
        if (agent.bubble.textContent !== bubble.text) agent.bubble.textContent = bubble.text;
        const cls = `dso-bubble ${bubble.cls}`;
        if (agent.bubble.className !== cls) agent.bubble.className = cls;
      }
      if (agent.sayUntil > 0 && t > agent.sayUntil) {
        agent.sayUntil = 0;
        agent.say.style.display = "none";
      }
      agent.tag.classList.toggle("sel", agent.member.id === selected);
    }
  }

  let raf = 0;
  let paused = false;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || paused) return;
    tick();
  };
  raf = requestAnimationFrame(loop);

  return {
    update,
    select(id) {
      selected = id;
    },
    focus(id) {
      const agent = agents.get(id);
      if (agent === undefined || mode !== "office") return;
      // 固定机位不动镜头：选中光环放大闪几下，标出这个人在哪
      selected = id;
      focusPulse = clock.elapsedTime;
    },
    setAttention(id, kind = "report") {
      attention = id === null ? null : { id, kind };
      for (const agent of agents.values()) agent.attention = agent.member.id === id ? kind : null;
    },
    setPaused(next) {
      if (paused === next) return;
      paused = next;
      // 恢复时丢掉暂停期间的时间差，免得动画一下跳太远
      if (!next) clock.getDelta();
    },
    setMode(next) {
      if (next === mode) return;
      if (next !== "gallery") uninspect();
      mode = next;
      galleryHint.style.display = next === "gallery" ? "" : "none";
      if (next === "gallery") {
        gallery ??= buildGallery();
        setOfficeControls(true);
        applyView(galleryView);
      } else {
        setOfficeControls(false);
        fitOffice();
      }
      labels.style.display = next === "office" ? "" : "none";
      galleryLabels.style.display = next === "gallery" ? "" : "none";
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      env.dispose();
      document.removeEventListener("keydown", onKey, true);
      panel.remove();
      galleryHint.remove();
      for (const agent of agents.values()) agent.dispose();
      agents.clear();
      renderer.dispose();
      renderer.domElement.remove();
      labels.remove();
      galleryLabels.remove();
    },
  };
}

