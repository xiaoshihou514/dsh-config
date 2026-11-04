/**
 * 房间外的时间感：按本地时间分早晨 / 正午 / 傍晚 / 夜晚四档，改变房间四周的天空（容器背景，
 * 夜里有星星）、阳光（月光）方向与颜色、半球光、室内灯，以及窗外的景色（窗玻璃贴一张
 * 天空 + 远处城市剪影的画，夜里亮灯）。每分钟检查一次时间。
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
    lamp: 0.4,
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
    lamp: 0.3,
  },
  dusk: {
    sky: ["#3d4f98", "#9b6aa8", "#f2946a", "#ffd29a"],
    city: ["#4a3c58", "#7a5a72"],
    lit: 0.25,
    stars: false,
    hemiSky: "#ffd2b4",
    hemiGround: "#6a4a5a",
    hemi: 1.15,
    sunColor: "#ff9d5c",
    sun: 1.7,
    sunPos: [-16, 6, 5],
    lamp: 1.4,
  },
  night: {
    sky: ["#070d24", "#14204a", "#263465"],
    city: ["#0d1330", "#1a2448"],
    lit: 0.45,
    stars: true,
    hemiSky: "#7d8cc4",
    hemiGround: "#251d30",
    hemi: 0.75,
    sunColor: "#a9bcff",
    sun: 0.55,
    sunPos: [-7, 16, -9],
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

export interface Environment {
  /** 房间重搭（如改名）后给窗户贴上当前时段的景色。 */
  applyRoom(room: THREE.Object3D): void;
  readonly phase: DayPhase;
  dispose(): void;
}

export function createEnvironment(
  scene: THREE.Scene,
  container: HTMLElement,
  lights: { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight },
  center: readonly [number, number],
): Environment {
  // 室内吸顶灯：白天也微亮，夜里是主光源
  const lamp = new THREE.PointLight("#ffe2b0", 0, 24, 1.4);
  lamp.position.set(center[0], 3.6, center[1]);
  scene.add(lamp);
  const lamp2 = new THREE.PointLight("#ffe2b0", 0, 16, 1.4);
  lamp2.position.set(6.5, 3.6, -6);
  scene.add(lamp2);

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
    lamp2.intensity = look.lamp * 0.7;
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
    dispose() {
      clearInterval(timer);
      for (const t of textures.values()) t.dispose();
      lamp.removeFromParent();
      lamp2.removeFromParent();
      container.style.removeProperty("background");
    },
  };
}
