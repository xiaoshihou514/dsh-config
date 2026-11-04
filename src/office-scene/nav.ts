/**
 * 角色寻路：把房间划成 0.25 的格子，家具（工位、沙发、茶几、书架、盆栽……）的水平包围盒按人的
 * 半径外扩后标成障碍，8 邻域 A*（不许斜穿墙角）求路，再用视线检查拉直成少量拐点。
 * 座位本身在家具包围盒里，由调用方给出座位旁的「入口点」，最后一段从入口直走进座位。
 */

export type P2 = readonly [number, number];

export interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/** 二叉小顶堆（按 f 值）。 */
class Heap {
  private readonly items: number[] = [];
  constructor(private readonly score: Float32Array) {}
  get size(): number {
    return this.items.length;
  }
  push(i: number): void {
    const a = this.items;
    a.push(i);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.score[a[p]!]! <= this.score[i]!) break;
      a[k] = a[p]!;
      k = p;
    }
    a[k] = i;
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && this.score[a[r]!]! < this.score[a[l]!]! ? r : l;
        if (this.score[a[c]!]! >= this.score[last]!) break;
        a[k] = a[c]!;
        k = c;
      }
      a[k] = last;
    }
    return top;
  }
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly blocked: Uint8Array;

  constructor(
    private readonly bounds: Rect,
    private readonly cell = 0.25,
    /** 人的半径：障碍外扩、离墙留空。 */
    private readonly radius = 0.28,
  ) {
    this.cols = Math.ceil((bounds.x1 - bounds.x0) / cell);
    this.rows = Math.ceil((bounds.z1 - bounds.z0) / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.setObstacles([]);
  }

  private cx(i: number): number {
    return this.bounds.x0 + (i + 0.5) * this.cell;
  }
  private cz(j: number): number {
    return this.bounds.z0 + (j + 0.5) * this.cell;
  }
  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.bounds.x0) / this.cell)));
  }
  private row(z: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.bounds.z0) / this.cell)));
  }

  /** 重新标障碍（墙边按半径留空）。 */
  setObstacles(rects: readonly Rect[]): void {
    const r = this.radius;
    const { x0, x1, z0, z1 } = this.bounds;
    for (let j = 0; j < this.rows; j += 1)
      for (let i = 0; i < this.cols; i += 1) {
        const x = this.cx(i);
        const z = this.cz(j);
        let hit = x < x0 + r || x > x1 - r || z < z0 + r || z > z1 - r;
        for (let k = 0; !hit && k < rects.length; k += 1) {
          const o = rects[k]!;
          hit = x > o.x0 - r && x < o.x1 + r && z > o.z0 - r && z < o.z1 + r;
        }
        this.blocked[j * this.cols + i] = hit ? 1 : 0;
      }
  }

  isFree(x: number, z: number): boolean {
    return this.blocked[this.row(z) * this.cols + this.col(x)] === 0;
  }

  /** 离 (x, z) 最近的空格中心（本身空着就原样返回）。 */
  nearestFree(x: number, z: number): P2 {
    if (this.isFree(x, z)) return [x, z];
    const ci = this.col(x);
    const cj = this.row(z);
    for (let ring = 1; ring < Math.max(this.cols, this.rows); ring += 1) {
      let best: P2 | undefined;
      let bestD = Infinity;
      for (let j = cj - ring; j <= cj + ring; j += 1)
        for (let i = ci - ring; i <= ci + ring; i += 1) {
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if (this.blocked[j * this.cols + i] !== 0) continue;
          const d = Math.hypot(this.cx(i) - x, this.cz(j) - z);
          if (d < bestD) {
            bestD = d;
            best = [this.cx(i), this.cz(j)];
          }
        }
      if (best !== undefined) return best;
    }
    return [x, z];
  }

  /** 两点连线经过的格子是否都空着（按半格步长采样）。 */
  lineFree(a: P2, b: P2): boolean {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let k = 0; k <= n; k += 1) {
      const t = k / n;
      if (!this.isFree(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  }

  /**
   * 从 a 到 b 的路径（不含 a，末点为 b）。a、b 落在障碍里时先就近挪到空格。
   * 找不到路返回 null。
   */
  find(a: P2, b: P2): P2[] | null {
    const start = this.nearestFree(a[0], a[1]);
    const goal = this.nearestFree(b[0], b[1]);
    const out: P2[] = [];
    if (start[0] !== a[0] || start[1] !== a[1]) out.push(start);
    if (this.lineFree(start, goal)) {
      out.push(goal);
      if (goal[0] !== b[0] || goal[1] !== b[1]) out.push(b);
      return out;
    }
    const cols = this.cols;
    const total = cols * this.rows;
    const s = this.row(start[1]) * cols + this.col(start[0]);
    const g = this.row(goal[1]) * cols + this.col(goal[0]);
    const gx = g % cols;
    const gz = Math.floor(g / cols);
    const cost = new Float32Array(total).fill(Infinity);
    const score = new Float32Array(total);
    const from = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gx);
      const dz = Math.abs(Math.floor(i / cols) - gz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    const heap = new Heap(score);
    cost[s] = 0;
    score[s] = h(s);
    heap.push(s);
    let found = false;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === 1) continue;
      closed[cur] = 1;
      if (cur === g) {
        found = true;
        break;
      }
      const ci = cur % cols;
      const cj = Math.floor(cur / cols);
      for (let dj = -1; dj <= 1; dj += 1)
        for (let di = -1; di <= 1; di += 1) {
          if (di === 0 && dj === 0) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= this.rows) continue;
          const n = nj * cols + ni;
          if (this.blocked[n] !== 0 || closed[n] === 1) continue;
          // 斜走不许擦过墙角
          if (di !== 0 && dj !== 0 && (this.blocked[cj * cols + ni] !== 0 || this.blocked[nj * cols + ci] !== 0)) continue;
          const c = cost[cur]! + (di !== 0 && dj !== 0 ? Math.SQRT2 : 1);
          if (c < cost[n]!) {
            cost[n] = c;
            from[n] = cur;
            score[n] = c + h(n);
            heap.push(n);
          }
        }
    }
    if (!found) return null;
    const cells: P2[] = [];
    for (let k = g; k !== -1 && k !== s; k = from[k]!) cells.push([this.cx(k % cols), this.cz(Math.floor(k / cols))]);
    cells.reverse();
    // 首尾换成精确点，再拉直：能直线走到的拐点都跳过
    cells[cells.length - 1] = goal;
    let anchor: P2 = start;
    for (let k = 0; k < cells.length; k += 1) {
      const next = cells[k + 1];
      if (next !== undefined && this.lineFree(anchor, next)) continue;
      out.push(cells[k]!);
      anchor = cells[k]!;
    }
    if (goal[0] !== b[0] || goal[1] !== b[1]) out.push(b);
    return out;
  }
}
