/**
 * Browser entry: sidebar usage entry, and the plugin-manager row
 * configuration pages (0.2.0 slot contract: `plugins.row.config`, keyed by
 * `<package name>#<row id>`).
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: pull the SlotMap declaration merges each slot contract owner
// publishes, so register() type-checks against them.
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { UsageTrigger } from "./UsageTrigger.tsx";
import { CodexLoginCard } from "./CodexLoginCard.tsx";
import { CopilotLoginCard } from "./CopilotLoginCard.tsx";
import { InjectOnceCard } from "./InjectOnceCard.tsx";
import { OpencodeTrigger } from "./OpencodePanel.tsx";
import { TurnNotify } from "./TurnNotify.tsx";

export const inject = ["slots"];

/** 行配置条目的 key = `<包名>#<行 id>`（行 id 即 cordis.patch.yml 声明的行）。 */
const ROW_KEY = (rowId: string): `dsh-config#${string}` => `dsh-config#${rowId}`;

console.log("[dsh-config] client bundle 2026-10-27-2（总览并入指标卡）");

export function apply(ctx: Context): void {
  // 侧边栏「用量」入口（设置上方）：root 列表槽位，owner 传 wide。
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "usage", order: 0 },
    UsageTrigger,
  ));
  // 侧边栏「OpenCode」入口：把 opencode 的会话/agent 后端接进 dsh。
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "opencode", order: 1 },
    OpencodeTrigger,
  ));
  // 回合完成系统通知（隐形槽位组件：监听 session 快照，自身不渲染）。
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "dsh-config-turn-notify", order: 2 },
    TurnNotify,
  ));
  // 插件管理器（侧边栏插件按钮 → dsh-config → 行「配置」）的行配置页。
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
    { name: "plugins.row.config", key: ROW_KEY("dsh-config-codex-provider") },
    CodexLoginCard,
  ));
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
    { name: "plugins.row.config", key: ROW_KEY("dsh-config-copilot-provider") },
    CopilotLoginCard,
  ));
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
    { name: "plugins.row.config", key: ROW_KEY("dsh-config-inject-once") },
    InjectOnceCard,
  ));
}
