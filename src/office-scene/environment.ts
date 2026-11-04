/**
 * 房间外的时间感：按本地时间分早晨 / 正午 / 傍晚 / 夜晚四档，改变房间四周的天空（容器背景，
 * 夜里有星星）、阳光（月光）方向与颜色、半球光，以及窗外的景色（窗玻璃贴一张
 * 天空 + 远处城市剪影的画，夜里亮灯）。傍晚起开灯：壁灯、落地灯亮起带光晕，室内点光源
 * 与暖色环境光照亮房间。每分钟检查一次时间。
 */

import * as THREE from "three";

export type DayPhase = "morning" | "noon" | "dusk" | "night";

interface PhaseLook {
  /** 窗外天空自上而下的渐变色。 */
  readonly sky: readonly string[];
  /** 远处楼群剪影的颜色（近、远两层）与亮灯比例。 */
  readonly city: readonly [string, string];
  readonly lit: number;
  readonly stars: boolean;
  readonly hemiSky: string;
  readonly hemiGround: string;
  readonly hemi: number;
  readonly sunColor: string;
  readonly sun: number;
  readonly sunPos: readonly [number, number, number];
  readonly lamp: number;
}

const STARS = Array.from({ length: 36 }, (_, i) => {
  const x = (i * 37) % 100;
  const y = (i * 53) % 46;
  const r = i % 5 === 0 ? 1.6 : 1;
  return `radial-gradient(${r}px ${r}px at ${x}% ${y}%, rgba(255,255,255,${i % 3 === 0 ? 0.95 : 0.6}), transparent)`;
}).join(", ");

/** 房间四周的天空（CSS 背景）。 */
function skyCss(look: PhaseLook): string {
  const stops = look.sky.map((c, i) => `${c} ${Math.round((i / (look.sky.length - 1)) * 100)}%`).join(", ");
  return `${look.stars ? `${STARS}, ` : ""}linear-gradient(180deg, ${stops})`;
}

const LOOK: Record<DayPhase, PhaseLook> = {
  morning: {
    sky: ["#8ec5f0", "#cfe6f7", "#fde7cc"],
    city: ["#9fb3c8", "#c4d2df"],
    lit: 0,
    stars: false,
    hemiSky: "#f2f6ff",
    hemiGround: "#b49a7a",
    hemi: 1.45,
    sunColor: "#ffe2b8",
    sun: 1.9,
    sunPos: [16, 11, 7],
    lamp: 0,
  },
  noon: {
    sky: ["#5fa8ec", "#a9d3f5", "#e9f3fb"],
    city: ["#93a9bf", "#bccbd9"],
    lit: 0,
    stars: false,
    hemiSky: "#eef3ff",
    hemiGround: "#b49a7a",
    hemi: 1.6,
    sunColor: "#fff4e0",
    sun: 2.2,
    sunPos: [9, 18, 10],
    lamp: 0,
  },
  dusk: {
    sky: ["#3d4f98", "#9b6aa8", "#f2946a", "#ffd29a"],
    city: ["#4a3c58", "#7a5a72"],
    lit: 0.25,
    stars: false,
    hemiSky: "#ffd9b8",
    hemiGround: "#7a5a50",
    hemi: 1.2,
    sunColor: "#ff9d5c",
    sun: 1.7,
    sunPos: [-16, 6, 5],
    lamp: 6,
  },
  night: {
    sky: ["#070d24", "#14204a", "#263465"],
    city: ["#0d1330", "#1a2448"],
    lit: 0.45,
    stars: true,
    // 夜里室内开灯：暖色环境光为主，窗外月光只剩一点冷色
    hemiSky: "#ffe4c2",
    hemiGround: "#6a5040",
    hemi: 1.15,
    sunColor: "#a9bcff",
    sun: 0.35,
    sunPos: [-7, 16, -9],
    lamp: 16,
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

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 窗外景色：天空渐变 + 两层城市剪影（夜里亮灯、有星星）。所有窗户共用一张。 */
function viewTexture(look: PhaseLook): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, H);
  look.sky.forEach((c, i) => grad.addColorStop(i / (look.sky.length - 1), c));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const rand = rng(7);
  if (look.stars)
    for (let i = 0; i < 70; i += 1) {
      g.fillStyle = `rgba(255,255,255,${0.4 + rand() * 0.6})`;
      const r = rand() < 0.15 ? 2 : 1;
      g.fillRect(rand() * W, rand() * H * 0.55, r, r);
    }
  // 远、近两层楼群（先画远的）
  for (const layer of [1, 0]) {
    const color = look.city[layer]!;
    let x = -10;
    while (x < W) {
      const w = 26 + rand() * 46;
      const h = (layer === 1 ? 50 : 30) + rand() * (layer === 1 ? 70 : 100);
      const top = H - h - (layer === 1 ? 26 : 0);
      g.fillStyle = color;
      g.fillRect(x, top, w, H - top);
      if (look.lit > 0)
        for (let wy = top + 6; wy < H - 6; wy += 9)
          for (let wx = x + 5; wx < x + w - 6; wx += 8)
            if (rand() < look.lit * (layer === 1 ? 0.6 : 1)) {
              g.fillStyle = rand() < 0.8 ? "#ffd98a" : "#cfe6ff";
              g.fillRect(wx, wy, 3, 4);
            }
      x += w + 2 + rand() * 8;
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 壁灯 / 落地灯：灯罩 + 灯泡，开灯时灯泡发亮并有一圈光晕。 */
interface Fixture {
  readonly group: THREE.Group;
  readonly bulb: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly glow: THREE.Sprite;
}

let glowTexture: THREE.CanvasTexture | undefined;
function glowMap(): THREE.CanvasTexture {
  if (glowTexture === undefined) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,240,200,0.95)");
    grad.addColorStop(0.3, "rgba(255,220,150,0.4)");
    grad.addColorStop(1, "rgba(255,210,140,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowTexture = new THREE.CanvasTexture(c);
  }
  return glowTexture;
}

const SHADE = new THREE.MeshLambertMaterial({ color: "#f3e3c4" });
const METAL = new THREE.MeshLambertMaterial({ color: "#5d5650" });

/** 墙上的壁灯：贴墙的底座 + 朝上开口的灯罩。facing 是墙面朝向室内的方向（绕 y）。 */
function sconce(x: number, y: number, z: number, facing: number): Fixture {
  const group = new THREE.Group();
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.04), METAL);
  plate.position.z = 0.02;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.22), METAL);
  arm.position.set(0, -0.05, 0.13);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.13, 0.26, 12, 1, true), SHADE);
  shade.position.set(0, 0.08, 0.26);
  (shade.material as THREE.Material).side = THREE.DoubleSide;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), new THREE.MeshBasicMaterial({ color: "#d8d2c4" }));
  bulb.position.set(0, 0.05, 0.26);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowMap(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glow.position.copy(bulb.position);
  glow.scale.setScalar(1.3);
  group.add(plate, arm, shade, bulb, glow);
  group.position.set(x, y, z);
  group.rotation.y = facing;
  return { group, bulb, glow };
}

/** 落地灯：底座 + 灯杆 + 灯罩。 */
function floorLamp(x: number, z: number): Fixture {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.06, 14), METAL);
  base.position.y = 0.03;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 8), METAL);
  pole.position.y = 0.83;
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, 0.36, 14, 1, true), SHADE);
  shade.position.y = 1.72;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: "#d8d2c4" }));
  bulb.position.y = 1.62;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowMap(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  glow.position.y = 1.66;
  glow.scale.setScalar(1.8);
  group.add(base, pole, shade, bulb, glow);
  group.position.set(x, 0, z);
  return { group, bulb, glow };
}

export interface Environment {
  /** 房间重搭（如改名）后给窗户贴上当前时段的景色。 */
  applyRoom(room: THREE.Object3D): void;
  readonly phase: DayPhase;
  /** 地上会挡路的灯具（落地灯），寻路时当障碍。 */
  readonly solids: readonly THREE.Object3D[];
  dispose(): void;
}

export function createEnvironment(
  scene: THREE.Scene,
  container: HTMLElement,
  lights: { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight },
  center: readonly [number, number],
  room: { x0: number; x1: number; z0: number; z1: number },
  lounge: readonly [number, number],
): Environment {
  // 室内吸顶灯：白天也微亮，夜里是主光源
  const lamp = new THREE.PointLight("#ffe2b0", 0, 24, 1.4);
  lamp.position.set(center[0], 3.6, center[1]);
  scene.add(lamp);
  const lamp2 = new THREE.PointLight("#ffe2b0", 0, 16, 1.4);
  lamp2.position.set(lounge[0], 2.6, lounge[1]);
  scene.add(lamp2);
  // 壁灯（后墙、左墙，避开窗户、书架、招牌）与沙发旁的落地灯；傍晚起开灯
  const standing = floorLamp(lounge[0] + 2.1, room.z0 + 0.55);
  const fixtures: Fixture[] = [
    sconce(-8.8, 2.75, room.z0, 0),
    sconce(-4.0, 2.75, room.z0, 0),
    sconce(9.3, 2.75, room.z0, 0),
    sconce(room.x0, 2.75, -6.0, Math.PI / 2),
    sconce(room.x0, 2.75, -3.2, Math.PI / 2),
    standing,
  ];
  for (const f of fixtures) scene.add(f.group);
  const lamp3 = new THREE.PointLight("#ffe2b0", 0, 14, 1.4);
  lamp3.position.set(room.x0 + 2.5, 2.6, room.z0 + 3);
  scene.add(lamp3);

  const textures = new Map<DayPhase, THREE.CanvasTexture>();
  const textureOf = (phase: DayPhase) => {
    let t = textures.get(phase);
    if (t === undefined) {
      t = viewTexture(LOOK[phase]);
      textures.set(phase, t);
    }
    return t;
  };

  let current: DayPhase | null = null;
  let roomRef: THREE.Object3D | undefined;

  const paintWindows = (target: THREE.Object3D, phase: DayPhase) => {
    const map = textureOf(phase);
    target.traverse((obj) => {
      if (obj.userData.glass !== true) return;
      const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.map = map;
      mat.color.set("#ffffff");
      mat.needsUpdate = true;
    });
  };

  const apply = (phase: DayPhase) => {
    if (phase === current) return;
    current = phase;
    const look = LOOK[phase];
    container.style.background = skyCss(look);
    lights.hemi.color.set(look.hemiSky);
    lights.hemi.groundColor.set(look.hemiGround);
    lights.hemi.intensity = look.hemi;
    lights.sun.color.set(look.sunColor);
    lights.sun.intensity = look.sun;
    lights.sun.position.set(...look.sunPos);
    lamp.intensity = look.lamp;
    lamp2.intensity = look.lamp * 0.6;
    lamp3.intensity = look.lamp * 0.45;
    const on = look.lamp > 0;
    for (const f of fixtures) {
      f.bulb.material.color.set(on ? "#fff4d6" : "#d8d2c4");
      f.glow.visible = on;
    }
    if (roomRef) paintWindows(roomRef, phase);
  };

  const check = () => apply(phaseAt(new Date()));
  check();
  const timer = setInterval(check, 60_000);

  return {
    applyRoom(target) {
      roomRef = target;
      if (current !== null) paintWindows(target, current);
    },
    get phase() {
      return current ?? phaseAt(new Date());
    },
    solids: [standing.group],
    dispose() {
      clearInterval(timer);
      for (const t of textures.values()) t.dispose();
      lamp.removeFromParent();
      lamp2.removeFromParent();
      lamp3.removeFromParent();
      for (const f of fixtures) f.group.removeFromParent();
      container.style.removeProperty("background");
    },
  };
}
