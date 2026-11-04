/**
 * 办公室陈设：地板、墙、窗、门、工位（按岗位区分摆设）、茶水休息区。
 * 家具用 0.1 世界单位的体素拼搭。
 */

import * as THREE from "three";
import { ROLE_COLOR } from "../office/classify.ts";
import type { RoleKind } from "../office/types.ts";
import { Voxels, shade, voxelMaterial } from "./voxel.ts";

export const FURNITURE_VOXEL = 0.1;
const F = FURNITURE_VOXEL;

/** 办公室尺寸（世界单位）。 */
export type WallSide = "back" | "front" | "left" | "right";

export const ROOM = { x0: -12, x1: 12, z0: -9, z1: 9, wallHeight: 4 } as const;
export const DESK_TOP = 0.85;
export const SEAT_HEIGHT = 0.5;

const WOOD = "#b98a5c";
const WOOD_DARK = "#8a6240";
const METAL = "#9aa3ad";
const DARK = "#2a2d36";

const meshCache = new Map<string, THREE.BufferGeometry>();

/** 体素 → 网格；给了 key 时几何体按 key 缓存（工位等重复件只网格化一次）。 */
function mesh(v: Voxels | (() => Voxels), scale = F, key?: string): THREE.Mesh {
  let g = key === undefined ? undefined : meshCache.get(key);
  if (g === undefined) {
    g = (typeof v === "function" ? v() : v).geometry(scale);
    if (key !== undefined) meshCache.set(key, g);
  }
  const m = new THREE.Mesh(g, voxelMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- 纹理

export function canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

function floorTexture(): THREE.CanvasTexture {
  const texture = canvasTexture(256, 256, (g) => {
    const tones = ["#c9a27a", "#c19a72", "#cfa983", "#bf966c"];
    for (let row = 0; row < 8; row += 1) {
      const offset = (row % 2) * 64;
      for (let col = -1; col < 3; col += 1) {
        g.fillStyle = tones[(row * 3 + col + 8) % tones.length]!;
        g.fillRect(col * 128 + offset, row * 32, 128, 32);
        g.fillStyle = "rgba(90,60,30,0.25)";
        g.fillRect(col * 128 + offset, row * 32, 2, 32);
      }
      g.fillStyle = "rgba(90,60,30,0.3)";
      g.fillRect(0, row * 32 + 31, 256, 1);
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set((ROOM.x1 - ROOM.x0) / 4, (ROOM.z1 - ROOM.z0) / 4);
  return texture;
}

// ---------------------------------------------------------------- 房间

export function buildRoom(projectName: string): THREE.Group {
  const room = new THREE.Group();
  const width = ROOM.x1 - ROOM.x0;
  const depth = ROOM.z1 - ROOM.z0;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshLambertMaterial({ map: floorTexture() }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);

  const wallMat = new THREE.MeshLambertMaterial({ color: "#efe8dc" });
  const trimMat = new THREE.MeshLambertMaterial({ color: "#c9b79c" });
  const wallT = 0.3;
  const H = ROOM.wallHeight;

  /**
   * 一面墙：在局部坐标里沿 +x 铺开、室内朝 +z，墙体在 z∈[-wallT, 0]；
   * windows / door 是局部 x 区间。外层按朝向旋转摆放，userData.side 供环境按镜头方向淡化。
   */
  const buildWall = (side: WallSide, a0: number, a1: number, windows: [number, number][], door?: [number, number]) => {
    const group = new THREE.Group();
    group.userData.side = side;
    const holes = [...windows, ...(door ? [door] : [])].sort((p, q) => p[0] - q[0]);
    let cursor = a0;
    const solid = (a: number, b: number, y0: number, y1: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b - a, y1 - y0, wallT), wallMat);
      m.position.set((a + b) / 2, (y0 + y1) / 2, -wallT / 2);
      m.receiveShadow = true;
      group.add(m);
    };
    for (const [a, b] of holes) {
      if (a > cursor) solid(cursor, a, 0, H);
      cursor = b;
    }
    if (a1 > cursor) solid(cursor, a1, 0, H);
    for (const [a, b] of windows) {
      solid(a, b, 0, 1.1);
      solid(a, b, H - 0.6, H);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(b - a, H - 1.7), new THREE.MeshBasicMaterial({ color: "#bfe3ff" }));
      glass.position.set((a + b) / 2, 1.1 + (H - 1.7) / 2, -wallT + 0.02);
      glass.userData.glass = true;
      const frame = new Voxels();
      const cols = Math.round((b - a) / F);
      const rows = Math.round((H - 1.7) / F);
      for (let x = 0; x <= cols; x += 1)
        for (let y = 0; y <= rows; y += 1)
          if (x === 0 || x === cols || y === 0 || y === rows || x === Math.round(cols / 2) || y === Math.round(rows / 2))
            frame.set(x, y, 0, "#f7f4ee");
      const frameMesh = mesh(frame);
      frameMesh.castShadow = false;
      frameMesh.position.set(a, 1.1, -0.02);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(b - a + 0.2, 0.08, 0.3), trimMat);
      sill.position.set((a + b) / 2, 1.1, 0.1);
      group.add(glass, frameMesh, sill);
    }
    if (door) {
      const [a, b] = door;
      solid(a, b, 2.6, H);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(b - a - 0.1, 2.6, 0.08), new THREE.MeshLambertMaterial({ color: "#9b7350" }));
      panel.position.set((a + b) / 2, 1.3, -0.2);
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshLambertMaterial({ color: "#e3b546" }));
      knob.position.set(a + 0.35, 1.2, -0.12);
      group.add(panel, knob);
    }
    const skirting = new THREE.Mesh(new THREE.BoxGeometry(a1 - a0, 0.16, 0.06), trimMat);
    skirting.position.set((a0 + a1) / 2, 0.08, 0.03);
    group.add(skirting);
    room.add(group);
    return group;
  };
  // 四面墙：后墙、左墙（带门）、前墙、右墙。朝镜头的墙由环境按视角淡成几乎透明。
  const back = buildWall("back", ROOM.x0 - wallT, ROOM.x1 + wallT, [
    [-9, -5.5],
    [-3.5, 0],
    [6, 10],
  ]);
  back.position.set(0, 0, ROOM.z0);
  const front = buildWall("front", -ROOM.x1 - wallT, -ROOM.x0 + wallT, [
    [-10, -6],
    [-3, 1],
    [5, 9],
  ]);
  front.rotation.y = Math.PI;
  front.position.set(0, 0, ROOM.z1);
  const left = buildWall("left", -ROOM.z1, -ROOM.z0, [[-3, 1]], [-7, -5]);
  left.rotation.y = Math.PI / 2;
  left.position.set(ROOM.x0, 0, 0);
  const right = buildWall("right", ROOM.z0, ROOM.z1, [
    [-6, -2],
    [2, 6],
  ]);
  right.rotation.y = -Math.PI / 2;
  right.position.set(ROOM.x1, 0, 0);

  // 项目名招牌
  const signTexture = canvasTexture(512, 96, (g) => {
    g.fillStyle = "#2b3a55";
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = "#f2b632";
    g.fillRect(0, 88, 512, 8);
    g.fillStyle = "#ffffff";
    g.font = "bold 44px system-ui, 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(projectName, 256, 46, 490);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.75), new THREE.MeshBasicMaterial({ map: signTexture }));
  sign.position.set(3, 3.35, 0.03);
  back.add(sign);

  // 挂钟
  const clock = new THREE.Group();
  const clockFace = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 20),
    new THREE.MeshLambertMaterial({ color: "#ffffff" }),
  );
  clockFace.rotation.x = Math.PI / 2;
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.25, 0.02), new THREE.MeshBasicMaterial({ color: "#333" }));
  hand.position.set(0, 0.1, 0.04);
  const hand2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: "#333" }));
  hand2.position.set(0.08, 0, 0.04);
  clock.add(clockFace, hand, hand2);
  clock.position.set(-1.75, 3.35, 0.06);
  clock.userData.hands = [hand, hand2];
  back.add(clock);
  room.userData.clock = clock;
  return room;
}

// ---------------------------------------------------------------- 圆桌区与陈设

/** 圆桌区地毯（组长坐圆心）+ 后墙书架、盆栽。 */
export function buildDecor(center: readonly [number, number]): THREE.Group {
  const group = new THREE.Group();
  const [cx, cz] = center;
  const rug = new THREE.Mesh(new THREE.CircleGeometry(5.2, 48), new THREE.MeshLambertMaterial({ color: "#b98a64" }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(cx, 0.008, cz);
  rug.receiveShadow = true;
  const inner = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.55, 48), new THREE.MeshLambertMaterial({ color: "#e3b546" }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(cx, 0.012, cz);
  inner.receiveShadow = true;
  const core = new THREE.Mesh(new THREE.CircleGeometry(2.3, 48), new THREE.MeshLambertMaterial({ color: "#a8463c" }));
  core.rotation.x = -Math.PI / 2;
  core.position.set(cx, 0.012, cz);
  core.receiveShadow = true;
  group.add(rug, inner, core);

  // 书架（后墙右侧）
  const shelf = new Voxels();
  shelf.box(0, 0, 0, 14, 22, 3, (x, y, z) => {
    if (x === 0 || x === 14 || y === 0 || y === 22 || y % 7 === 0 || z === 0) return WOOD_DARK;
    if (z === 3) return null;
    const colors = ["#c94f4f", "#4f7fe0", "#e3b546", "#4fb85b", "#9a6cf0", "#f08a3c"];
    return y % 7 === 6 && x % 3 === 0 ? null : colors[(x * 7 + Math.floor(y / 7)) % colors.length]!;
  });
  const shelfMesh = mesh(shelf);
  shelfMesh.position.set(9.6, 0, ROOM.z0 + 0.05);
  group.add(shelfMesh, plant(11.3, ROOM.z0 + 0.6, 1.2), plant(6.4, ROOM.z0 + 0.6, 1));
  return group;
}

// ---------------------------------------------------------------- 工位

export interface DeskParts {
  readonly group: THREE.Group;
  /** 显示器屏幕（朝向坐着的人，即 -z）。 */
  readonly screen: THREE.Mesh;
  readonly screenCanvas: HTMLCanvasElement;
  readonly screenTexture: THREE.CanvasTexture;
  /** 显示器背面的状态灯（朝向镜头）。 */
  readonly statusLight: THREE.Mesh;
  /** 会闪烁的灯（服务器机箱等）。 */
  readonly blinkers: THREE.Mesh[];
}

/**
 * 一个工位：桌、椅、显示器、岗位摆设。原点在椅子中心地面，人朝 +z 坐。
 */
export function buildDesk(role: RoleKind, big = false): DeskParts {
  const group = new THREE.Group();
  const roleColor = ROLE_COLOR[role];
  const deskW = big ? 24 : 20;
  const deskD = big ? 12 : 10;
  const top = Math.round(DESK_TOP / F);
  const deskZ0 = 5; // 桌子后沿（相对椅子中心，体素）
  const desk = new Voxels();
  const half = deskW / 2;
  const wood = big ? "#6e4a30" : WOOD;
  // 桌面
  desk.box(-half, top - 1, deskZ0, half - 1, top - 1, deskZ0 + deskD - 1, wood);
  // 桌腿 / 侧板
  desk.box(-half, 0, deskZ0, -half, top - 2, deskZ0 + deskD - 1, shade(wood, 0.85));
  desk.box(half - 1, 0, deskZ0, half - 1, top - 2, deskZ0 + deskD - 1, shade(wood, 0.85));
  // 前挡板：岗位色条
  desk.box(-half + 1, 2, deskZ0 + deskD - 1, half - 2, top - 2, deskZ0 + deskD - 1, (x, y) =>
    y === top - 3 ? roleColor : shade(wood, 0.92),
  );
  if (big) desk.box(-half + 1, top - 3, deskZ0 + deskD - 1, half - 2, top - 3, deskZ0 + deskD - 1, "#e3b546");
  // 键盘
  desk.box(-3, top, deskZ0 + 1, 3, top, deskZ0 + 2, role === "backend" ? "#3a3f4a" : "#e8ebf0");
  // 马克杯
  desk.box(half - 4, top, deskZ0 + 2, half - 3, top + 1, deskZ0 + 3, big ? "#e3b546" : "#ffffff");
  // 名牌
  desk.box(-half + 2, top, deskZ0 + deskD - 3, -half + 5, top, deskZ0 + deskD - 2, roleColor);

  // 椅子
  const chair = new Voxels();
  const seat = Math.round(SEAT_HEIGHT / F);
  const chairColor = big ? "#7a2a2a" : "#3c4250";
  chair.box(-3, seat - 1, -3, 3, seat - 1, 3, chairColor);
  chair.box(-3, seat, -4, 3, seat + (big ? 9 : 6), -4, chairColor);
  if (big) chair.box(-3, seat + 9, -4, 3, seat + 9, -4, "#e3b546");
  chair.box(0, 1, 0, 0, seat - 2, 0, METAL);
  chair.box(-2, 0, 0, 2, 0, 0, METAL).box(0, 0, -2, 0, 0, 2, METAL);

  // 岗位摆设
  const deco = new Voxels();
  const blinkers: THREE.Mesh[] = [];
  const decoX = half - 6;
  switch (role) {
    case "frontend": {
      // 第二块竖屏 + 彩色便签
      deco.box(-half + 2, top, deskZ0 + 6, -half + 3, top + 5, deskZ0 + 8, DARK);
      ["#ffd23f", "#ec6fa8", "#5bc0eb"].forEach((c, i) => deco.set(half - 2 - i, top, deskZ0 + 5, c));
      break;
    }
    case "backend": {
      // 桌旁服务器机箱
      deco.box(half + 1, 0, deskZ0 + 2, half + 4, 12, deskZ0 + 8, "#30343e");
      for (let y = 2; y <= 10; y += 2) deco.box(half + 1, y, deskZ0 + 9, half + 4, y, deskZ0 + 9, "#4a505c");
      break;
    }
    case "qa": {
      // 虫子标本罐
      deco.box(decoX, top, deskZ0 + 6, decoX + 2, top + 3, deskZ0 + 8, "#cfeeff");
      deco.set(decoX + 1, top + 1, deskZ0 + 9, "#4fb85b");
      deco.box(decoX, top + 4, deskZ0 + 6, decoX + 2, top + 4, deskZ0 + 8, "#f08a3c");
      break;
    }
    case "reviewer": {
      // 一摞批改过的稿纸
      for (let i = 0; i < 4; i += 1) deco.box(decoX - 1, top + i, deskZ0 + 5, decoX + 2, top + i, deskZ0 + 8, i % 2 ? "#ffffff" : "#f2f2f2");
      deco.box(decoX, top + 4, deskZ0 + 6, decoX + 1, top + 4, deskZ0 + 6, "#e04f4f");
      break;
    }
    case "docs": {
      ["#a7794a", "#4f7fe0", "#c94f4f", "#4fb85b"].forEach((c, i) =>
        deco.box(decoX - 1, top + i, deskZ0 + 5, decoX + 2, top + i, deskZ0 + 8, c),
      );
      break;
    }
    case "design": {
      deco.box(decoX - 2, top, deskZ0 + 4, decoX + 2, top, deskZ0 + 7, "#2a2d36");
      ["#e04f4f", "#4f7fe0", "#ffd23f", "#4fb85b", "#9a6cf0"].forEach((c, i) => deco.set(decoX - 2 + i, top + 1, deskZ0 + 8, c));
      break;
    }
    case "devops": {
      deco.box(half + 1, 0, deskZ0 + 2, half + 4, 16, deskZ0 + 8, "#2c3a5a");
      for (let y = 2; y <= 14; y += 3) deco.box(half + 1, y, deskZ0 + 9, half + 4, y, deskZ0 + 9, "#5b7fd6");
      deco.box(half - 1, top, deskZ0 + 3, half + 1, top, deskZ0 + 3, "#f2a33a");
      break;
    }
    case "data": {
      deco.box(decoX - 1, top, deskZ0 + 6, decoX + 2, top + 4, deskZ0 + 6, "#ffffff");
      [1, 3, 2, 4].forEach((h, i) => deco.box(decoX - 1 + i, top + 1, deskZ0 + 7, decoX - 1 + i, top + h, deskZ0 + 7, "#4fb85b"));
      break;
    }
    case "lead": {
      // 文件盒
      deco.box(-half + 3, top, deskZ0 + 3, -half + 7, top + 2, deskZ0 + 6, "#c9b79c");
      break;
    }
    default:
      break;
  }

  const k = `${role}:${big}`;
  group.add(mesh(desk, F, `desk:${k}`), mesh(chair, F, `chair:${big}`));
  if (deco.size > 0) group.add(mesh(deco, F, `deco:${k}`));

  if (role === "backend" || role === "devops") {
    const tall = role === "devops" ? 1.6 : 1.2;
    for (let i = 0; i < 4; i += 1) {
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.02),
        new THREE.MeshBasicMaterial({ color: i % 2 ? "#4fe07a" : "#5bc0eb" }),
      );
      led.position.set((half + 1.5) * F + i * 0.06, (0.3 + (i % 2) * 0.12) * tall, (deskZ0 + 9.6) * F);
      led.userData.phase = i * 1.7;
      group.add(led);
      blinkers.push(led);
    }
  }

  // 显示器
  const monitorW = big ? 1.1 : 0.9;
  const monitorH = 0.52;
  const monitor = new THREE.Group();
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(monitorW + 0.06, monitorH + 0.06, 0.05),
    new THREE.MeshLambertMaterial({ color: DARK }),
  );
  bezel.castShadow = true;
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.06), new THREE.MeshLambertMaterial({ color: METAL }));
  stand.position.set(0, -monitorH / 2 - 0.08, 0.02);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.02, 0.2), new THREE.MeshLambertMaterial({ color: METAL }));
  foot.position.set(0, -monitorH / 2 - 0.16, 0.02);
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = 160;
  screenCanvas.height = 96;
  const screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(monitorW, monitorH), new THREE.MeshBasicMaterial({ map: screenTexture }));
  screen.rotation.y = Math.PI;
  screen.position.z = -0.03;
  const statusLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.02), new THREE.MeshBasicMaterial({ color: "#8a93a3" }));
  statusLight.position.set(0, 0, 0.035);
  monitor.add(bezel, stand, foot, screen, statusLight);
  monitor.position.set(0, DESK_TOP + 0.17 + monitorH / 2, (deskZ0 + deskD * 0.62) * F);
  group.add(monitor);

  return { group, screen, screenCanvas, screenTexture, statusLight, blinkers };
}

// ---------------------------------------------------------------- 休息区与杂项

export function plant(x: number, z: number, size = 1): THREE.Mesh {
  const v = new Voxels();
  v.box(-2, 0, -2, 2, 3, 2, "#c9734a");
  v.box(-2, 3, -2, 2, 3, 2, "#6b4a2e");
  const leaves = ["#4fa65a", "#3e8f4c", "#62b86c"];
  for (let y = 4; y <= 11; y += 1) {
    const r = y < 7 ? 3 : y < 10 ? 2 : 1;
    for (let dx = -r; dx <= r; dx += 1)
      for (let dz = -r; dz <= r; dz += 1)
        if (Math.abs(dx) + Math.abs(dz) <= r + 1 && (dx * 3 + dz * 5 + y) % 4 !== 0)
          v.set(dx, y, dz, leaves[(dx + dz + y + 9) % 3]!);
  }
  const m = mesh(v, F * size);
  m.position.set(x, 0, z);
  return m;
}

export function buildLounge(): THREE.Group {
  const group = new THREE.Group();
  // 圆形小地毯
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.6, 24), new THREE.MeshLambertMaterial({ color: "#7fb3a6" }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(8, 0.01, 6);
  rug.receiveShadow = true;
  group.add(rug);

  // 沙发（靠前墙方向，面朝 -z）
  const sofa = new Voxels();
  sofa.box(-14, 0, 0, 14, 4, 7, "#4f6fb0");
  sofa.box(-14, 5, 5, 14, 9, 7, "#4f6fb0");
  sofa.box(-14, 5, 0, -12, 7, 7, "#45619c").box(12, 5, 0, 14, 7, 7, "#45619c");
  sofa.box(-11, 5, 0, -1, 5, 4, "#6a88c6").box(1, 5, 0, 11, 5, 4, "#6a88c6");
  const sofaMesh = mesh(sofa);
  sofaMesh.position.set(8, 0, 7.7);
  group.add(sofaMesh);

  // 茶几
  const table = new Voxels();
  table.box(-6, 3, -4, 6, 3, 4, WOOD).box(-5, 0, -3, -5, 2, -3, WOOD_DARK).box(5, 0, 3, 5, 2, 3, WOOD_DARK);
  table.box(5, 0, -3, 5, 2, -3, WOOD_DARK).box(-5, 0, 3, -5, 2, 3, WOOD_DARK);
  table.box(-1, 4, -1, 0, 5, 0, "#ffffff").box(2, 4, 1, 3, 4, 2, "#f2b632");
  const tableMesh = mesh(table);
  tableMesh.position.set(8, 0, 5.6);
  group.add(tableMesh);

  // 咖啡机 + 柜台（靠右墙）
  const counter = new Voxels();
  counter.box(0, 0, -15, 6, 9, 15, "#d9d2c5");
  counter.box(0, 9, -15, 6, 9, 15, "#8a8f99");
  counter.box(1, 10, -13, 5, 16, -8, "#30343e");
  counter.box(5, 12, -12, 5, 13, -9, "#e04f4f");
  counter.box(2, 10, -6, 4, 11, -4, "#ffffff");
  counter.box(1, 10, 2, 5, 18, 7, "#5bc0eb");
  counter.box(1, 18, 3, 5, 18, 6, "#dfe6ee");
  const counterMesh = mesh(counter);
  counterMesh.position.set(ROOM.x1 - 0.7, 0, 4.8);
  group.add(counterMesh);

  group.add(plant(4.3, 8.3, 1.3), plant(11.4, 8.4, 1.1));
  return group;
}
