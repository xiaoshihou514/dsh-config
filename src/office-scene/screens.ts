/** 显示器画面与白板的 canvas 绘制。 */

import { ROLE_COLOR } from "../office/classify.ts";
import type { OfficeTask, RoleKind, ToolCategory } from "../office/types.ts";

export type ScreenMode = ToolCategory | "thinking" | "idle" | "failed" | "off";

const FONT = "system-ui, 'PingFang SC', 'Noto Sans CJK SC', sans-serif";

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 画一帧显示器内容；tick 让内容滚动。 */
export function drawScreen(canvas: HTMLCanvasElement, mode: ScreenMode, role: RoleKind, tick: number, label: string): void {
  const g = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  const r = rand(Math.floor(tick) * 31 + 7);
  switch (mode) {
    case "shell": {
      g.fillStyle = "#0f1a14";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i += 1) {
        g.fillStyle = i === 8 ? "#d8ffe0" : r() > 0.8 ? "#ffd23f" : "#4fe07a";
        g.fillRect(6, 6 + i * 10, 8 + r() * (w - 30), 5);
      }
      if (Math.floor(tick * 2) % 2 === 0) {
        g.fillStyle = "#d8ffe0";
        g.fillRect(8 + r() * 60, 86, 6, 6);
      }
      break;
    }
    case "edit": {
      g.fillStyle = "#1e2230";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#2a2f40";
      g.fillRect(0, 0, 14, h);
      const colors = ["#c792ea", "#82aaff", "#c3e88d", "#f78c6c", "#89ddff", "#d6deeb"];
      for (let i = 0; i < 9; i += 1) {
        let x = 18 + (i % 3) * 8;
        for (let k = 0; k < 3; k += 1) {
          const len = 8 + r() * 30;
          g.fillStyle = colors[Math.floor(r() * colors.length)]!;
          g.fillRect(x, 6 + i * 10, len, 5);
          x += len + 4;
        }
      }
      g.fillStyle = "rgba(255,255,255,0.12)";
      g.fillRect(14, 6 + (Math.floor(tick) % 9) * 10 - 2, w, 9);
      break;
    }
    case "read":
    case "search": {
      g.fillStyle = "#f7f7f2";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#3b4252";
      g.fillRect(8, 6, 70, 7);
      for (let i = 0; i < 8; i += 1) {
        g.fillStyle = mode === "search" && i === Math.floor(tick) % 8 ? "#ffd23f" : "#a6adbb";
        g.fillRect(8, 20 + i * 9, 40 + r() * (w - 60), 4);
      }
      if (mode === "search") {
        g.strokeStyle = "#4f7fe0";
        g.lineWidth = 4;
        g.beginPath();
        g.arc(w - 32, 36, 14, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.moveTo(w - 22, 46);
        g.lineTo(w - 10, 58);
        g.stroke();
      }
      break;
    }
    case "web": {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#dfe3ea";
      g.fillRect(0, 0, w, 14);
      ["#e8584f", "#f2b13c", "#4fb86b"].forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect(5 + i * 9, 4, 6, 6);
      });
      g.fillStyle = "#4f7fe0";
      g.fillRect(8, 22, w - 16, 26);
      for (let i = 0; i < 4; i += 1) {
        g.fillStyle = "#b8bec8";
        g.fillRect(8, 56 + i * 9, 30 + r() * (w - 50), 4);
      }
      break;
    }
    case "team": {
      g.fillStyle = "#eef2fb";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i += 1) {
        const mine = (i + Math.floor(tick)) % 2 === 0;
        g.fillStyle = mine ? "#4f7fe0" : "#ffffff";
        const bw = 50 + r() * 50;
        g.fillRect(mine ? w - bw - 8 : 8, 8 + i * 21, bw, 15);
      }
      break;
    }
    case "plan": {
      g.fillStyle = "#fffaf0";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 6; i += 1) {
        const done = i < (Math.floor(tick) % 7);
        g.strokeStyle = "#8a93a3";
        g.lineWidth = 2;
        g.strokeRect(8, 8 + i * 14, 9, 9);
        if (done) {
          g.fillStyle = "#4fb85b";
          g.fillRect(10, 10 + i * 14, 5, 5);
        }
        g.fillStyle = done ? "#b8bec8" : "#3b4252";
        g.fillRect(24, 11 + i * 14, 40 + ((i * 37) % 70), 4);
      }
      break;
    }
    case "wait":
    case "thinking": {
      g.fillStyle = mode === "wait" ? "#2b2140" : "#1e2a40";
      g.fillRect(0, 0, w, h);
      const n = Math.floor(tick * 3) % 4;
      g.fillStyle = "#ffffff";
      for (let i = 0; i < 3; i += 1) {
        g.globalAlpha = i < n ? 1 : 0.25;
        g.beginPath();
        g.arc(w / 2 - 22 + i * 22, h / 2, 6, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      break;
    }
    case "failed": {
      g.fillStyle = "#7a1f2a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#ffffff";
      g.font = `bold 46px ${FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("!", w / 2, h / 2);
      break;
    }
    case "off": {
      g.fillStyle = "#15171c";
      g.fillRect(0, 0, w, h);
      break;
    }
    default: {
      // 屏保：岗位色渐变 + 浮动方块
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, ROLE_COLOR[role]);
      grad.addColorStop(1, "#1e2230");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.7)";
      const t = tick * 0.6;
      g.fillRect(w / 2 + Math.cos(t) * 40 - 6, h / 2 + Math.sin(t * 1.3) * 22 - 6, 12, 12);
      break;
    }
  }
  if (label && mode !== "off" && mode !== "idle") {
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(0, h - 15, w, 15);
    g.fillStyle = "#ffffff";
    g.font = `10px ${FONT}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(label, 4, h - 7, w - 8);
  }
}

const STATUS_COLUMNS: readonly [OfficeTask["status"], string, string][] = [
  ["pending", "待处理", "#fff3a8"],
  ["in_progress", "进行中", "#bfe1ff"],
  ["completed", "已完成", "#c9f2c7"],
];

function wrap(g: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    if (g.measureText(line + ch).width > width) {
      out.push(line);
      line = ch;
      if (out.length === lines) break;
    } else line += ch;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && text.length > out.join("").length) out[lines - 1] = `${out[lines - 1]!.slice(0, -1)}…`;
  return out;
}

export function drawWhiteboard(
  canvas: HTMLCanvasElement,
  tasks: readonly OfficeTask[],
  source: "team" | "todo" | "none",
): void {
  const g = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = "#fbfcfd";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#2b3a55";
  g.font = `bold 24px ${FONT}`;
  g.textAlign = "left";
  g.textBaseline = "top";
  g.fillText(source === "todo" ? "组长待办" : "共享任务板", 18, 12);
  g.fillStyle = "#8a93a3";
  g.font = `14px ${FONT}`;
  g.fillText(`${tasks.filter((t) => t.status === "completed").length}/${tasks.length} 完成`, w - 110, 18);
  const colW = (w - 36) / 3;
  STATUS_COLUMNS.forEach(([status, title, color], col) => {
    const x = 18 + col * colW;
    g.fillStyle = "#3b4252";
    g.font = `bold 15px ${FONT}`;
    g.fillText(title, x + 4, 48);
    g.strokeStyle = "#dfe3ea";
    g.beginPath();
    g.moveTo(x + colW - 4, 46);
    g.lineTo(x + colW - 4, h - 12);
    g.stroke();
    const list = tasks.filter((t) => t.status === status).slice(0, 4);
    list.forEach((task, i) => {
      const y = 72 + i * 70;
      g.save();
      g.translate(x + 6 + colW / 2 - 12, y + 30);
      g.rotate(((task.id.length * 7 + i * 3) % 5 - 2) * 0.012);
      g.fillStyle = color;
      g.fillRect(-(colW - 24) / 2, -30, colW - 24, 62);
      g.fillStyle = "rgba(0,0,0,0.08)";
      g.fillRect(-(colW - 24) / 2, 28, colW - 24, 4);
      g.fillStyle = "#2a2d36";
      g.font = `13px ${FONT}`;
      wrap(g, task.subject, colW - 36, 2).forEach((line, k) => g.fillText(line, -(colW - 24) / 2 + 6, -24 + k * 17));
      if (task.ownerName) {
        g.fillStyle = "#6a7180";
        g.font = `11px ${FONT}`;
        g.fillText(`@${task.ownerName}`, -(colW - 24) / 2 + 6, 12);
      }
      g.restore();
    });
    const more = tasks.filter((t) => t.status === status).length - list.length;
    if (more > 0) {
      g.fillStyle = "#8a93a3";
      g.font = `12px ${FONT}`;
      g.fillText(`还有 ${more} 项…`, x + 8, h - 28);
    }
  });
  if (tasks.length === 0) {
    g.fillStyle = "#a6adbb";
    g.font = `16px ${FONT}`;
    g.fillText("暂无任务", 24, 90);
  }
}
