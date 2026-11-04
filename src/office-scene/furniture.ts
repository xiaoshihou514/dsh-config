/**
 * 办公室陈设：地板、墙、窗、门、组长办公室玻璃隔断、工位（按岗位区分摆设）、
 * 茶水休息区、白板。家具用 0.1 世界单位的体素拼搭。
 */

import * as THREE from "three";
import { ROLE_COLOR } from "../office/classify.ts";
import type { RoleKind } from "../office/types.ts";
import { Voxels, shade, voxelMaterial } from "./voxel.ts";

export const FURNITURE_VOXEL = 0.1;
const F = FURNITURE_VOXEL;

/** 办公室尺寸（世界单位）。 */
export const ROOM = { x0: -12, x1: 12, z0: -9, z1: 9, wallHeight: 4 } as const;
export const DESK_TOP = 0.85;
export const SEAT_HEIGHT = 0.5;

const WOOD = "#b98a5c";
const WOOD_DARK = "#8a6240";
const METAL = "#9aa3ad";
const DARK = "#2a2d36";

function mesh(v: Voxels, scale = F): THREE.Mesh {
  const m = new THREE.Mesh(v.geometry(scale), voxelMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- 纹理

function canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
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
  // 地板边缘厚度
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.6, 0.4, depth + 0.6),
    new THREE.MeshLambertMaterial({ color: "#8a6a4c" }),
  );
  base.position.set(0, -0.201, 0);
  room.add(base);

  const wallMat = new THREE.MeshLambertMaterial({ color: "#efe8dc" });
  const trimMat = new THREE.MeshLambertMaterial({ color: "#c9b79c" });
  // 后墙（带窗）
  const back = new THREE.Group();
  const wallT = 0.3;
  const segments: [number, number][] = [];
  const windows: [number, number][] = [
    [-9, -5.5],
    [-3.5, 0],
    [6, 10],
  ];
  let cursor: number = ROOM.x0;
  for (const [a, b] of windows) {
    segments.push([cursor, a]);
    cursor = b;
  }
  segments.push([cursor, ROOM.x1]);
  for (const [a, b] of segments) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(b - a, ROOM.wallHeight, wallT), wallMat);
    wall.position.set((a + b) / 2, ROOM.wallHeight / 2, ROOM.z0 - wallT / 2);
    wall.receiveShadow = true;
    back.add(wall);
  }
  for (const [a, b] of windows) {
    const lower = new THREE.Mesh(new THREE.BoxGeometry(b - a, 1.1, wallT), wallMat);
    lower.position.set((a + b) / 2, 0.55, ROOM.z0 - wallT / 2);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(b - a, 0.6, wallT), wallMat);
    upper.position.set((a + b) / 2, ROOM.wallHeight - 0.3, ROOM.z0 - wallT / 2);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(b - a, ROOM.wallHeight - 1.7),
      new THREE.MeshBasicMaterial({ color: "#bfe3ff" }),
    );
    glass.position.set((a + b) / 2, 1.1 + (ROOM.wallHeight - 1.7) / 2, ROOM.z0 - wallT + 0.02);
    const frame = new Voxels();
    const cols = Math.round((b - a) / F);
    const rows = Math.round((ROOM.wallHeight - 1.7) / F);
    for (let x = 0; x <= cols; x += 1)
      for (let y = 0; y <= rows; y += 1)
        if (x === 0 || x === cols || y === 0 || y === rows || x === Math.round(cols / 2) || y === Math.round(rows / 2))
          frame.set(x, y, 0, "#f7f4ee");
    const frameMesh = mesh(frame);
    frameMesh.castShadow = false;
    frameMesh.position.set(a, 1.1, ROOM.z0 - 0.02);
    const sill = new THREE.Mesh(new THREE.BoxGeometry(b - a + 0.2, 0.08, 0.3), trimMat);
    sill.position.set((a + b) / 2, 1.1, ROOM.z0 + 0.1);
    back.add(lower, upper, glass, frameMesh, sill);
  }
  room.add(back);

  // 左墙（带门、白板）
  const left = new THREE.Group();
  const doorZ: [number, number] = [5, 7];
  for (const [a, b] of [
    [ROOM.z0, doorZ[0]],
    [doorZ[1], ROOM.z1],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(wallT, ROOM.wallHeight, b - a), wallMat);
    wall.position.set(ROOM.x0 - wallT / 2, ROOM.wallHeight / 2, (a + b) / 2);
    wall.receiveShadow = true;
    left.add(wall);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(wallT, ROOM.wallHeight - 2.6, doorZ[1] - doorZ[0]), wallMat);
  lintel.position.set(ROOM.x0 - wallT / 2, 2.6 + (ROOM.wallHeight - 2.6) / 2, (doorZ[0] + doorZ[1]) / 2);
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 2.6, doorZ[1] - doorZ[0] - 0.1),
    new THREE.MeshLambertMaterial({ color: "#9b7350" }),
  );
  door.position.set(ROOM.x0 - 0.2, 1.3, (doorZ[0] + doorZ[1]) / 2);
  const knob = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshLambertMaterial({ color: "#e3b546" }));
  knob.position.set(ROOM.x0 - 0.12, 1.2, doorZ[1] - 0.35);
  left.add(lintel, door, knob);
  room.add(left);

  // 踢脚线
  const skirtingBack = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, 0.06), trimMat);
  skirtingBack.position.set(0, 0.08, ROOM.z0 + 0.03);
  const skirtingLeft = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, depth), trimMat);
  skirtingLeft.position.set(ROOM.x0 + 0.03, 0.08, 0);
  room.add(skirtingBack, skirtingLeft);

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
  sign.position.set(3, 3.35, ROOM.z0 + 0.03);
  room.add(sign);

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
  clock.position.set(-1.75, 3.35, ROOM.z0 + 0.06);
  clock.userData.hands = [hand, hand2];
  room.add(clock);
  room.userData.clock = clock;
  return room;
}

// ---------------------------------------------------------------- 组长办公室

export const LEAD_OFFICE = { x0: 4, z1: -2.5, doorX: [5, 6.5] as const };

export function buildLeadOffice(): THREE.Group {
  const group = new THREE.Group();
  const glassMat = new THREE.MeshLambertMaterial({ color: "#cfe8ff", transparent: true, opacity: 0.28, depthWrite: false });
  const frameMat = new THREE.MeshLambertMaterial({ color: "#7d8796" });
  const height = 2.6;
  const addPanel = (x: number, z: number, w: number, d: number) => {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), glassMat);
    glass.position.set(x, height / 2, z);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.08, d + 0.04), frameMat);
    top.position.set(x, height, z);
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.1, d + 0.04), frameMat);
    bottom.position.set(x, 0.05, z);
    group.add(glass, top, bottom);
  };
  // 左侧隔断
  addPanel(LEAD_OFFICE.x0, (ROOM.z0 + LEAD_OFFICE.z1) / 2, 0.06, LEAD_OFFICE.z1 - ROOM.z0);
  // 前侧隔断（留门）
  addPanel((LEAD_OFFICE.x0 + LEAD_OFFICE.doorX[0]) / 2, LEAD_OFFICE.z1, LEAD_OFFICE.doorX[0] - LEAD_OFFICE.x0, 0.06);
  addPanel((LEAD_OFFICE.doorX[1] + ROOM.x1) / 2, LEAD_OFFICE.z1, ROOM.x1 - LEAD_OFFICE.doorX[1], 0.06);
  // 门牌
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.32),
    new THREE.MeshBasicMaterial({
      map: canvasTexture(256, 60, (g) => {
        g.fillStyle = "#f2b632";
        g.fillRect(0, 0, 256, 60);
        g.fillStyle = "#3a2a08";
        g.font = "bold 34px system-ui, 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("组长办公室", 128, 32);
      }),
    }),
  );
  plate.position.set(8.5, 2.3, LEAD_OFFICE.z1 + 0.05);
  group.add(plate);

  // 地毯
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(5, 4), new THREE.MeshLambertMaterial({ color: "#a8463c" }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(8.2, 0.01, -5.6);
  rug.receiveShadow = true;
  const rugInner = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 3.4), new THREE.MeshLambertMaterial({ color: "#c96a4e" }));
  rugInner.rotation.x = -Math.PI / 2;
  rugInner.position.set(8.2, 0.015, -5.6);
  rugInner.receiveShadow = true;
  group.add(rug, rugInner);

  // 书架
  const shelf = new Voxels();
  shelf.box(0, 0, 0, 14, 22, 3, (x, y, z) => {
    if (x === 0 || x === 14 || y === 0 || y === 22 || y % 7 === 0 || z === 0) return WOOD_DARK;
    if (z === 3) return null;
    const colors = ["#c94f4f", "#4f7fe0", "#e3b546", "#4fb85b", "#9a6cf0", "#f08a3c"];
    return y % 7 === 6 && x % 3 === 0 ? null : colors[(x * 7 + Math.floor(y / 7)) % colors.length]!;
  });
  const shelfMesh = mesh(shelf);
  shelfMesh.position.set(10, 0, ROOM.z0 + 0.05);
  group.add(shelfMesh);

  group.add(plant(11.2, -3.2, 1.2));
  // 地球仪
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshLambertMaterial({ color: "#4f9fe0" }));
  globe.position.set(9.2, DESK_TOP + 0.28, -5.5);
  globe.castShadow = true;
  const globeStand = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.07, 0.14, 8), new THREE.MeshLambertMaterial({ color: GOLD() }));
  globeStand.position.set(9.2, DESK_TOP + 0.07, -5.5);
  group.add(globe, globeStand);
  return group;
}

function GOLD(): string {
  return "#e3b546";
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
  const deskW = big ? 30 : 20;
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

  group.add(mesh(desk), mesh(chair));
  if (deco.size > 0) group.add(mesh(deco));

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

export interface Whiteboard {
  readonly group: THREE.Group;
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
}

/** 左墙上的任务白板（面朝 +x）。 */
export function buildWhiteboard(): Whiteboard {
  const group = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const w = 6;
  const h = 3.4;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture }));
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.05), new THREE.MeshLambertMaterial({ color: "#aab2bd" }));
  frame.position.z = -0.03;
  const tray = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.16), new THREE.MeshLambertMaterial({ color: "#aab2bd" }));
  tray.position.set(0, -h / 2 - 0.08, 0.06);
  board.position.z = 0.002;
  group.add(frame, board, tray);
  group.rotation.y = Math.PI / 2;
  group.position.set(ROOM.x0 + 0.06, 2.1, -4.6);
  return { group, canvas, texture };
}
