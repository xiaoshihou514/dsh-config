/**
 * 体素网格：整数坐标 → 颜色；网格化时剔除被遮挡的面，按朝向烘焙明暗，
 * 并给每个体素一点色彩抖动，产生手工体素画的质感。
 */

import * as THREE from "three";

export type ColorFn = (x: number, y: number, z: number) => string | null;

const FACES: readonly {
  dir: readonly [number, number, number];
  corners: readonly (readonly [number, number, number])[];
  shade: number;
}[] = [
  // +x
  { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.86 },
  // -x
  { dir: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.8 },
  // +y
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1 },
  // -y
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.62 },
  // +z
  { dir: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.93 },
  // -z
  { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.74 },
];

/** 平涂模式下各朝向的明暗（+x, -x, +y, -y, +z, -z）。 */
const FLAT_SHADE = [0.96, 0.94, 1, 0.85, 1, 0.97] as const;

const colorCache = new Map<string, THREE.Color>();
function parse(color: string): THREE.Color {
  let cached = colorCache.get(color);
  if (cached === undefined) {
    cached = new THREE.Color(color);
    colorCache.set(color, cached);
  }
  return cached;
}

function jitter(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.07;
}

export class Voxels {
  readonly cells = new Map<string, string>();

  private static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  set(x: number, y: number, z: number, color: string | null): this {
    if (color === null) this.cells.delete(Voxels.key(x, y, z));
    else this.cells.set(Voxels.key(x, y, z), color);
    return this;
  }

  get(x: number, y: number, z: number): string | undefined {
    return this.cells.get(Voxels.key(x, y, z));
  }

  has(x: number, y: number, z: number): boolean {
    return this.cells.has(Voxels.key(x, y, z));
  }

  /** 填充闭区间长方体；颜色可为函数（返回 null 跳过）。 */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: string | ColorFn,
  ): this {
    const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
    const [az, bz] = z0 <= z1 ? [z0, z1] : [z1, z0];
    for (let x = ax; x <= bx; x += 1)
      for (let y = ay; y <= by; y += 1)
        for (let z = az; z <= bz; z += 1) {
          const value = typeof color === "string" ? color : color(x, y, z);
          if (value !== null) this.set(x, y, z, value);
        }
    return this;
  }

  /** 只改已有体素的颜色。 */
  paint(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: string): this {
    return this.box(x0, y0, z0, x1, y1, z1, (x, y, z) => (this.has(x, y, z) ? color : null));
  }

  /** 左右镜像（x → -x）复制当前全部体素。 */
  mirrorX(): this {
    for (const [key, color] of [...this.cells]) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      if (!this.has(-x, y, z)) this.set(-x, y, z, color);
    }
    return this;
  }

  get size(): number {
    return this.cells.size;
  }

  /**
   * 生成几何体。体素 (x,y,z) 占据 [x-0.5, x+0.5]（水平居中）× [y, y+1] × [z-0.5, z+0.5]。
   * @param scale - 每个体素的世界尺寸。
   * @param pivot - 体素坐标中的枢轴点，几何体相对它平移（用于关节旋转）。
   */
  geometry(
    scale: number,
    pivot: readonly [number, number, number] = [0, 0, 0],
    /** 平涂：不加色彩抖动，面朝向明暗更柔和（像素画角色用）。 */
    flat = false,
    /**
     * 按面取色（可选）：face 依次为 +x、-x、+y、-y、+z、-z；返回 null / undefined
     * 时用体素本身的颜色。像素画角色用它让不同朝向的面各自取对应视图的颜色。
     */
    faceColor?: (x: number, y: number, z: number, face: number) => string | null | undefined,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const tmp = new THREE.Color();
    for (const [key, color] of this.cells) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      const cell = parse(color);
      const j = flat ? 0 : jitter(x, y, z);
      for (let f = 0; f < FACES.length; f += 1) {
        const face = FACES[f]!;
        if (this.has(x + face.dir[0], y + face.dir[1], z + face.dir[2])) continue;
        const start = positions.length / 3;
        const own = faceColor?.(x, y, z, f);
        const base = own == null ? cell : parse(own);
        // 底面附近略暗，模拟环境光遮蔽。
        const occlusion = face.dir[1] === 0 && !this.has(x, y - 1, z) ? 0.97 : 1;
        const shade = flat ? FLAT_SHADE[f]! : face.shade * occlusion;
        tmp.setRGB(
          Math.min(1, Math.max(0, base.r * shade + j)),
          Math.min(1, Math.max(0, base.g * shade + j)),
          Math.min(1, Math.max(0, base.b * shade + j)),
        );
        for (const corner of face.corners) {
          positions.push(
            (x - 0.5 + corner[0] - pivot[0]) * scale,
            (y + corner[1] - pivot[1]) * scale,
            (z - 0.5 + corner[2] - pivot[2]) * scale,
          );
          normals.push(face.dir[0], face.dir[1], face.dir[2]);
          colors.push(tmp.r, tmp.g, tmp.b);
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** 共享的体素材质（顶点色 + 兰伯特光照）。 */
let sharedMaterial: THREE.MeshLambertMaterial | undefined;
export function voxelMaterial(): THREE.MeshLambertMaterial {
  sharedMaterial ??= new THREE.MeshLambertMaterial({ vertexColors: true });
  return sharedMaterial;
}

/** 体素 → 带阴影的网格。 */
export function voxelMesh(
  voxels: Voxels,
  scale: number,
  pivot: readonly [number, number, number] = [0, 0, 0],
  material: THREE.Material = voxelMaterial(),
): THREE.Mesh {
  const mesh = new THREE.Mesh(voxels.geometry(scale, pivot), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(pivot[0] * scale, pivot[1] * scale, pivot[2] * scale);
  return mesh;
}

/** 颜色插值（十六进制串）。 */
export function mix(a: string, b: string, t: number): string {
  const ca = parse(a);
  const cb = parse(b);
  return `#${new THREE.Color().copy(ca).lerp(cb, Math.min(1, Math.max(0, t))).getHexString()}`;
}

export function shade(color: string, factor: number): string {
  const c = parse(color);
  return `#${new THREE.Color(
    Math.min(1, c.r * factor),
    Math.min(1, c.g * factor),
    Math.min(1, c.b * factor),
  ).getHexString()}`;
}
