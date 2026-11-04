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
  DESK_TOP,
  LEAD_OFFICE,
  ROOM,
  SEAT_HEIGHT,
  buildDesk,
  buildLeadOffice,
  buildLounge,
  buildRoom,
  buildWhiteboard,
  type DeskParts,
  type Whiteboard,
} from "./furniture.ts";
import { drawScreen, drawWhiteboard, type ScreenMode } from "./screens.ts";
import { Voxels } from "./voxel.ts";

export interface SceneOptions {
  readonly onSelect: (id: string | null) => void;
}

export interface OfficeScene {
  update(snapshot: OfficeSnapshot, live: Readonly<Record<string, boolean>>): void;
  select(id: string | null): void;
  focus(id: string): void;
  setMode(mode: "office" | "gallery"): void;
  dispose(): void;
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

const AISLE = 2.6;
const DESK_COLS = [-8.5, -5, -1.5, 2] as const;
const DESK_ROWS = [-5.2, -0.2] as const;

function deskSpot(index: number): Spot {
  const col = index % DESK_COLS.length;
  const row = Math.floor(index / DESK_COLS.length) % DESK_ROWS.length;
  const x = DESK_COLS[col]!;
  const z = DESK_ROWS[row]!;
  const lane = x + 1.75;
  return { x, z, facing: 0, seat: "chair", approach: [[lane, AISLE], [lane, z], [x, z]] };
}

const LEAD_DESK: Spot = {
  x: 8.2,
  z: -6.6,
  facing: 0,
  seat: "chair",
  approach: [
    [5.75, AISLE],
    [5.75, -1.8],
    [5.75, -6.6],
    [8.2, -6.6],
  ],
};

const LEAD_IDLE: Spot = {
  x: 5.3,
  z: -3.7,
  facing: 0.5,
  approach: [
    [5.75, AISLE],
    [5.75, -1.8],
    [5.3, -3.7],
  ],
};

const DOOR: Spot = { x: ROOM.x0 + 0.6, z: 6, facing: Math.PI / 2, approach: [[-10.5, AISLE], [ROOM.x0 + 0.6, 6]] };

const TABLE: P2 = [8, 5.6];
function faceTo(x: number, z: number, target: P2): number {
  return Math.atan2(target[0] - x, target[1] - z);
}

const LOUNGE_SPOTS: readonly Spot[] = [
  ...[6.9, 8, 9.1].map(
    (x): Spot => ({ x, z: 7.95, facing: Math.PI, seat: "sofa", approach: [[6.2, AISLE], [6.2, 7.1], [x, 7.1], [x, 7.95]] }),
  ),
  ...(
    [
      [5.7, 5.4],
      [10.3, 5.4],
      [6.6, 3.8],
      [9.4, 3.8],
      [5.6, 4.0],
      [10.4, 4.0],
    ] as const
  ).map(([x, z]): Spot => ({ x, z, facing: faceTo(x, z, TABLE), approach: [[x, AISLE], [x, z]] })),
];

function route(from: Spot, to: Spot): P2[] {
  return [...from.approach.slice(0, -1).reverse(), ...to.approach];
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

/** 每帧重置关节后按状态摆姿势。 */
function pose(agent: Agent, t: number, dt: number): void {
  const rig = agent.rig;
  const flagship = rig.tier === "flagship";
  for (const part of [rig.head, rig.armL, rig.armR, rig.legL, rig.legR, rig.body]) part.rotation.set(0, 0, 0);
  rig.skirt?.rotation.set(0, 0, 0);
  rig.body.position.set(0, 0, 0);
  const seed = agent.member.id.length * 1.37;

  const seated = !agent.moving && agent.at.seat !== undefined;
  if (rig.heldL) rig.heldL.visible = !seated;
  if (rig.heldR) rig.heldR.visible = !seated;

  if (agent.moving) {
    const w = t * 10;
    rig.legL.rotation.x = Math.sin(w) * 0.6;
    rig.legR.rotation.x = -Math.sin(w) * 0.6;
    rig.armL.rotation.x = -Math.sin(w) * 0.45;
    rig.armR.rotation.x = Math.sin(w) * 0.45;
    rig.body.position.y = Math.abs(Math.sin(w)) * 0.035;
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
      rig.armL.rotation.x = -0.3;
      rig.armR.rotation.x = -0.3;
    } else if (atDesk && agent.status === "running") {
      const kind = current?.kind ?? "thinking";
      if (kind === "waiting") {
        rig.body.rotation.x = -0.08;
        rig.armL.rotation.set(-1.15, 0, -0.75);
        rig.armR.rotation.set(-1.15, 0, 0.75);
        rig.head.rotation.y = Math.sin(t * 0.8 + seed) * 0.4;
        rig.legR.rotation.x = -Math.PI / 2 + Math.max(0, Math.sin(t * 6)) * 0.15;
      } else if (kind === "thinking") {
        rig.armL.rotation.x = -1.4;
        rig.armR.rotation.set(-2.5, 0, 0.45);
        rig.head.rotation.z = 0.15 + Math.sin(t * 0.9 + seed) * 0.05;
        rig.head.rotation.x = -0.1;
      } else if (current?.category === "team") {
        rig.armL.rotation.x = -1.4;
        rig.armR.rotation.set(-2.6 + Math.sin(t * 7) * 0.3, 0, -0.2);
        rig.head.rotation.y = Math.sin(t * 2 + seed) * 0.2;
      } else {
        const speed = current?.category === "read" || current?.category === "search" ? 4 : 18;
        rig.armL.rotation.x = -1.42 + Math.sin(t * speed + seed) * 0.07;
        rig.armR.rotation.x = -1.42 + Math.sin(t * speed + seed + 1.7) * 0.07;
        rig.head.rotation.x = 0.1 + (speed === 4 ? Math.sin(t * 0.7) * 0.05 : 0);
      }
    } else {
      // 坐着放松（沙发 / 工位空闲）
      rig.armL.rotation.set(-0.5, 0, 0.15);
      rig.armR.rotation.set(-0.5, 0, -0.15);
      rig.head.rotation.z = Math.sin(t * 0.6 + seed) * 0.08;
      rig.body.position.y += Math.sin(t * 1.6 + seed) * 0.006;
    }
  } else {
    // 站立闲聊
    rig.body.position.y = Math.sin(t * 2 + seed) * 0.008;
    rig.head.rotation.z = Math.sin(t * 0.7 + seed) * 0.07;
    rig.head.rotation.y = Math.sin(t * 0.37 + seed) * 0.3;
    rig.armL.rotation.set(-0.15 + Math.sin(t * 1.3 + seed) * 0.05, 0, -0.32);
    rig.armR.rotation.set(-0.3 + Math.sin(t * 1.1 + seed) * 0.05, 0, 0.32);
    if (agent.status === "provisioning") rig.armR.rotation.set(-2.7 + Math.sin(t * 8) * 0.25, 0, -0.3);
  }

  // 像素画角色：手臂没有单独拆分，动作靠上身摆动；坐下时裙摆收起。
  if (rig.upper !== undefined && rig.lower !== undefined) {
    rig.upper.rotation.set(0, 0, 0);
    rig.lower.rotation.set(0, 0, 0);
    rig.lower.scale.y = seated ? 0.55 : 1;
    if (agent.moving) {
      const w = t * 10;
      rig.upper.rotation.z = Math.sin(w) * 0.05;
      rig.lower.rotation.z = -Math.sin(w) * 0.05;
    } else if (seated && agent.at === agent.deskAt && agent.status === "running") {
      const kind = agent.member.current?.kind ?? "thinking";
      const category = agent.member.current?.category;
      if (kind === "waiting") {
        rig.upper.rotation.x = -0.08;
        rig.upper.rotation.y = Math.sin(t * 0.8 + seed) * 0.2;
      } else if (kind === "thinking") {
        rig.upper.rotation.z = 0.07 + Math.sin(t * 0.9 + seed) * 0.03;
        rig.head.rotation.z = 0.1;
      } else if (category === "team") {
        rig.upper.rotation.y = Math.sin(t * 3 + seed) * 0.12;
      } else {
        rig.upper.rotation.x = 0.1 + Math.sin(t * 16 + seed) * 0.012;
      }
    } else if (agent.status === "failed") {
      rig.upper.rotation.x = 0.25;
    } else {
      rig.upper.rotation.z = Math.sin(t * 0.8 + seed) * 0.03;
    }
  }

  // 收到消息时轻跳
  const since = t - agent.jumpAt;
  if (since >= 0 && since < 0.5) rig.body.position.y += Math.sin((since / 0.5) * Math.PI) * 0.22;

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
  readonly to: THREE.Vector3;
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

  function lights(scene: THREE.Scene, span: number): void {
    scene.add(new THREE.HemisphereLight("#eef3ff", "#b49a7a", 1.6));
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
  }

  // ---- 办公室
  const office = new THREE.Scene();
  lights(office, 17);
  office.add(buildLeadOffice(), buildLounge());
  const whiteboard: Whiteboard = buildWhiteboard();
  office.add(whiteboard.group);
  let room: THREE.Group | undefined;
  const agents = new Map<string, Agent>();
  const seen = new Set<string>();
  const flights: Flight[] = [];
  let initialized = false;
  let lastTasks = "";
  let selected: string | null = null;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.64, 40),
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  office.add(ring);

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
  const officeView = { target: new THREE.Vector3(0, 0.6, 0), zoom: 1.25, polar: 1.02, azimuth: 0.62 };
  const galleryView = { target: new THREE.Vector3(0, 1.4, 0.4), zoom: 1.25, polar: 1.22, azimuth: 0 };
  function applyView(view: typeof officeView): void {
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
  applyView(officeView);

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
  }
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
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  // ---- 图鉴细看
  type InspectPose = "stand" | "walk" | "type" | "think" | "wait" | "talk" | "sleep";
  const POSES: [InspectPose, string][] = [
    ["stand", "站立"],
    ["walk", "走路"],
    ["type", "打字"],
    ["think", "思考"],
    ["wait", "等待"],
    ["talk", "沟通"],
    ["sleep", "休息"],
  ];
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
  const standSpot = fakeSpot(false);
  function fakeAgent(entry: GalleryEntry): Agent {
    const seated = inspectPose !== "stand" && inspectPose !== "walk";
    const working = inspectPose === "type" || inspectPose === "think" || inspectPose === "wait" || inspectPose === "talk";
    const current =
      inspectPose === "type"
        ? { kind: "tool", category: "edit", label: "", since: 0 }
        : inspectPose === "wait"
          ? { kind: "waiting", category: "wait", label: "", since: 0 }
          : inspectPose === "talk"
            ? { kind: "tool", category: "team", label: "", since: 0 }
            : { kind: "thinking", label: "", since: 0 };
    return {
      rig: entry.rig,
      moving: inspectPose === "walk",
      at: seated ? deskSpotFake : standSpot,
      deskAt: deskSpotFake,
      status: working ? "running" : "inactive",
      jumpAt: -10,
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
    if (room === undefined) {
      const project = snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目";
      room = buildRoom(`${project} 项目组`);
      office.add(room);
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
        agents.set(member.id, agent);
      }
      if (agent.status !== "inactive" && status === "inactive") agent.inactiveSince = now;
      agent.status = status;
      agent.member = member;
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

    const taskKey = JSON.stringify([snapshot.taskSource, snapshot.tasks]);
    if (taskKey !== lastTasks) {
      lastTasks = taskKey;
      drawWhiteboard(whiteboard.canvas, snapshot.tasks, snapshot.taskSource);
      whiteboard.texture.needsUpdate = true;
    }
    initialized = true;
  }

  // ---- 每帧
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  let frame = 0;

  function bubbleOf(agent: Agent): { text: string; cls: string } | null {
    const m = agent.member;
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
        return agent.at === agent.idleAt && !agent.moving ? { text: m.role === "lead" ? "☕ 待命" : "☕ 休息", cls: "idle" } : null;
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
    controls.update();

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
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const mid = tmp.copy(flight.from).add(flight.to).multiplyScalar(0.5);
        mid.y += 2 + flight.from.distanceTo(flight.to) * 0.12;
        const a = flight.from.clone().lerp(mid, e);
        const b = mid.clone().lerp(flight.to, e);
        flight.mesh.position.copy(a.lerp(b, e));
        flight.mesh.rotation.set(Math.sin(t * 6) * 0.3, t * 4, Math.sin(t * 5) * 0.2);
        flight.mesh.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.4);
      }

      // 选中光环
      const sel = selected === null ? undefined : agents.get(selected);
      ring.visible = sel !== undefined;
      if (sel !== undefined) {
        ring.position.x = sel.rig.root.position.x;
        ring.position.z = sel.rig.root.position.z;
        ring.scale.setScalar(1 + Math.sin(t * 4) * 0.06);
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
        if (inspectPose === "sleep") entry.rig.head.rotation.x = 0.35;
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
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    tick();
  };
  raf = requestAnimationFrame(loop);

  // 聚焦动画
  let focusAnim: { from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number; start: number } | null = null;
  const focusTick = () => {
    if (focusAnim === null) return;
    const k = Math.min(1, (performance.now() - focusAnim.start) / 600);
    const e = 1 - (1 - k) ** 3;
    const delta = focusAnim.from.clone().lerp(focusAnim.to, e).sub(controls.target);
    controls.target.add(delta);
    camera.position.add(delta);
    camera.zoom = focusAnim.z0 + (focusAnim.z1 - focusAnim.z0) * e;
    camera.updateProjectionMatrix();
    if (k < 1) requestAnimationFrame(focusTick);
    else focusAnim = null;
  };

  return {
    update,
    select(id) {
      selected = id;
    },
    focus(id) {
      const agent = agents.get(id);
      if (agent === undefined || mode !== "office") return;
      const p = agent.rig.root.position;
      focusAnim = {
        from: controls.target.clone(),
        to: new THREE.Vector3(p.x, DESK_TOP, p.z),
        z0: camera.zoom,
        z1: Math.max(camera.zoom, 1.9),
        start: performance.now(),
      };
      requestAnimationFrame(focusTick);
    },
    setMode(next) {
      if (next === mode) return;
      if (next !== "gallery") uninspect();
      mode = next;
      galleryHint.style.display = next === "gallery" ? "" : "none";
      if (next === "gallery") {
        gallery ??= buildGallery();
        officeView.target.copy(controls.target);
        officeView.zoom = camera.zoom;
        applyView(galleryView);
      } else {
        applyView(officeView);
      }
      labels.style.display = next === "office" ? "" : "none";
      galleryLabels.style.display = next === "gallery" ? "" : "none";
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
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

void LEAD_OFFICE;
