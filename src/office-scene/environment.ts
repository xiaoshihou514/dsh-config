/**
 * 房间外的环境，按本地时间分早晨 / 正午 / 傍晚 / 夜晚四档：天空渐变（容器背景，
 * 夜里加星星）、远处草地与一圈体素树、阳光（月光）方向与颜色、半球光、窗玻璃颜色，
 * 夜里室内点灯。每分钟检查一次时间。
 */

import * as THREE from "three";
import { Voxels, voxelMaterial } from "./voxel.ts";

export type DayPhase = "morning" | "noon" | "dusk" | "night";

interface PhaseLook {
  readonly sky: string;
  readonly ground: string;
  readonly dirt: string;
  readonly grass: readonly [string, string, string];
  readonly hemiSky: string;
  readonly hemiGround: string;
  readonly hemi: number;
  readonly sunColor: string;
  readonly sun: number;
  readonly sunPos: readonly [number, number, number];
  readonly glass: string;
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
    dirt: "#8a6a4a",
    sky: "linear-gradient(180deg, #8ec5f0 0%, #cfe6f7 45%, #fde7cc 100%)",
    ground: "#8fc06f",
    grass: ["#7fb662", "#94c776", "#6ea957"],
    hemiSky: "#f2f6ff",
    hemiGround: "#b49a7a",
    hemi: 1.45,
    sunColor: "#ffe2b8",
    sun: 1.9,
    sunPos: [16, 11, 7],
    glass: "#cfe8ff",
    lamp: 0,
  },
  noon: {
    dirt: "#8a6a4a",
    sky: "linear-gradient(180deg, #5fa8ec 0%, #a9d3f5 50%, #e9f3fb 100%)",
    ground: "#7fba5f",
    grass: ["#6faa52", "#86c26a", "#5f9c47"],
    hemiSky: "#eef3ff",
    hemiGround: "#b49a7a",
    hemi: 1.6,
    sunColor: "#fff4e0",
    sun: 2.2,
    sunPos: [9, 18, 10],
    glass: "#bfe3ff",
    lamp: 0,
  },
  dusk: {
    dirt: "#6e5040",
    sky: "linear-gradient(180deg, #3d4f98 0%, #9b6aa8 35%, #f2946a 72%, #ffd29a 100%)",
    ground: "#6e8a52",
    grass: ["#5f7c48", "#738f55", "#536f3f"],
    hemiSky: "#ffd2b4",
    hemiGround: "#6a4a5a",
    hemi: 1.15,
    sunColor: "#ff9d5c",
    sun: 1.7,
    sunPos: [-16, 6, 5],
    glass: "#ffc489",
    lamp: 1.2,
  },
  night: {
    dirt: "#2e2630",
    sky: `${STARS}, linear-gradient(180deg, #070d24 0%, #14204a 55%, #263465 100%)`,
    ground: "#26382b",
    grass: ["#22331f", "#2a3d27", "#1d2b1b"],
    hemiSky: "#7d8cc4",
    hemiGround: "#251d30",
    hemi: 0.75,
    sunColor: "#a9bcff",
    sun: 0.55,
    sunPos: [-7, 16, -9],
    glass: "#2c3a6c",
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

/** 远处的一棵体素树（三种造型按种子挑）。 */
function tree(seed: number, colors: readonly [string, string, string]): Voxels {
  const v = new Voxels();
  const trunk = "#7a5534";
  const h = 4 + (seed % 3);
  v.box(0, 0, 0, 0, h, 0, trunk);
  if (seed % 2 === 0) {
    // 圆冠
    for (let y = h - 1; y <= h + 5; y += 1)
      for (let x = -3; x <= 3; x += 1)
        for (let z = -3; z <= 3; z += 1) {
          const d = x * x + z * z + (y - (h + 2)) ** 2 * 1.3;
          if (d <= 11) v.set(x, y, z, colors[(x + y + z + 30) % 3]!);
        }
  } else {
    // 尖冠（松树）
    for (let y = h - 1; y <= h + 8; y += 1) {
      const r = Math.max(0, Math.round((h + 8 - y) * 0.4));
      for (let x = -r; x <= r; x += 1)
        for (let z = -r; z <= r; z += 1) if (Math.abs(x) + Math.abs(z) <= r + 1) v.set(x, y, z, colors[(y + x + 30) % 3]!);
    }
  }
  return v;
}

export interface Environment {
  /** 房间重搭（如改名）后重新给窗玻璃上色。 */
  applyRoom(room: THREE.Object3D): void;
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

  // 浮空岛：比房间每边宽 MARGIN 的圆角平台（顶面草地、侧面泥土往下收），岛外露出天空
  const groundMat = new THREE.MeshLambertMaterial({ color: "#7fba5f" });
  const dirtMat = new THREE.MeshLambertMaterial({ color: "#8a6a4a" });
  const MARGIN = 4;
  const hx = room.x1 - room.x0 + MARGIN * 2;
  const hz = room.z1 - room.z0 + MARGIN * 2;
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  const slab = (w: number, d: number, r: number) => {
    const shape = new THREE.Shape();
    const x0 = -w / 2;
    const z0 = -d / 2;
    shape.moveTo(x0 + r, z0);
    shape.lineTo(x0 + w - r, z0);
    shape.quadraticCurveTo(x0 + w, z0, x0 + w, z0 + r);
    shape.lineTo(x0 + w, z0 + d - r);
    shape.quadraticCurveTo(x0 + w, z0 + d, x0 + w - r, z0 + d);
    shape.lineTo(x0 + r, z0 + d);
    shape.quadraticCurveTo(x0, z0 + d, x0, z0 + d - r);
    shape.lineTo(x0, z0 + r);
    shape.quadraticCurveTo(x0, z0, x0 + r, z0);
    return shape;
  };
  const layer = (w: number, d: number, depth: number, y: number, mat: THREE.Material) => {
    const g = new THREE.ExtrudeGeometry(slab(w, d, 2.5), { depth, bevelEnabled: false, curveSegments: 6 });
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, y, cz);
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  layer(hx, hz, 0.5, -0.4, groundMat);
  layer(hx - 0.4, hz - 0.4, 2.4, -0.9, dirtMat);
  layer(hx - 4, hz - 4, 2.2, -3.3, dirtMat);
  layer(hx - 9, hz - 9, 2.2, -5.5, dirtMat);

  // 一圈树（房间外 17～32 单位，前方镜头方向留空不挡视线）
  const trees: THREE.Mesh[] = [];
  const treeGroup = new THREE.Group();
  group.add(treeGroup);
  const plantTrees = (colors: readonly [string, string, string]) => {
    for (const m of trees) {
      m.geometry.dispose();
      m.removeFromParent();
    }
    trees.length = 0;
    const spots: [number, number][] = [];
    // 沿后墙、左墙外的草地边缘种一排（镜头在 +x +z 一侧，那两边不种免得挡视线）
    for (let x = room.x0 - 1.5; x <= room.x1 + 1.5; x += 3.3) spots.push([x, room.z0 - 2 - ((Math.round(x) & 1) ? 0.6 : 0)]);
    for (let z = room.z0 + 1; z <= room.z1 + 1.5; z += 3.4) spots.push([room.x0 - 2 - ((Math.round(z) & 1) ? 0.6 : 0), z]);
    spots.forEach(([x, z], i) => {
      const m = new THREE.Mesh(tree(i, colors).geometry(0.2), voxelMaterial());
      m.castShadow = true;
      m.position.set(x, -0.4, z);
      m.rotation.y = i;
      treeGroup.add(m);
      trees.push(m);
    });
  };

  // 夜里室内的暖灯
  const lamp = new THREE.PointLight("#ffcf8a", 0, 22, 1.6);
  lamp.position.set(center[0], 3.4, center[1]);
  scene.add(lamp);
  const lamp2 = new THREE.PointLight("#ffcf8a", 0, 16, 1.6);
  lamp2.position.set(8, 3.2, 6);
  scene.add(lamp2);

  let current: DayPhase | null = null;
  let roomRef: THREE.Object3D | undefined;

  const paintGlass = (room: THREE.Object3D, color: string) => {
    room.traverse((obj) => {
      if (obj.userData.glass === true) ((obj as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
    });
  };

  const apply = (phase: DayPhase) => {
    if (phase === current) return;
    current = phase;
    const look = LOOK[phase];
    container.style.background = look.sky;
    groundMat.color.set(look.ground);
    dirtMat.color.set(look.dirt);
    lights.hemi.color.set(look.hemiSky);
    lights.hemi.groundColor.set(look.hemiGround);
    lights.hemi.intensity = look.hemi;
    lights.sun.color.set(look.sunColor);
    lights.sun.intensity = look.sun;
    lights.sun.position.set(...look.sunPos);
    lamp.intensity = look.lamp;
    lamp2.intensity = look.lamp * 0.7;
    plantTrees(look.grass);
    if (roomRef) paintGlass(roomRef, look.glass);
  };

  const check = () => apply(phaseAt(new Date()));
  check();
  const timer = setInterval(check, 60_000);

  return {
    applyRoom(room) {
      roomRef = room;
      if (current !== null) paintGlass(room, LOOK[current].glass);
    },
    get phase() {
      return current ?? phaseAt(new Date());
    },
    dispose() {
      clearInterval(timer);
      for (const m of trees) m.geometry.dispose();
      group.removeFromParent();
      lamp.removeFromParent();
      lamp2.removeFromParent();
      container.style.removeProperty("background");
    },
  };
}
