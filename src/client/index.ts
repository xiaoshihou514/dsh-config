/**
 * Browser entry: sidebar usage entry, composer auto-approve toggle + user
 * message nav, and the Plugins-page config tabs (0.2.0 slot contract:
 * `settings.plugins.tab` list entries with self-owned pages).
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: pull the SlotMap / standard-props declaration merges each slot
// contract owner publishes, so register() type-checks against them.
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { UsageTrigger } from "./UsageTrigger.tsx";
import { AutoApproveToggle } from "./AutoApproveToggle.tsx";
import { ApprovalReviewCard } from "./ApprovalReviewCard.tsx";
import { CodexLoginCard } from "./CodexLoginCard.tsx";
import { CopilotLoginCard } from "./CopilotLoginCard.tsx";
import { InjectOnceCard } from "./InjectOnceCard.tsx";
import { UserMessageNav } from "./UserMessageNav.tsx";

export const inject = ["slots", "remote", "remote.credentials", "configForms"];

export function apply(ctx: Context): void {
  // 侧边栏「用量」入口（设置上方）：root 列表槽位，owner 传 wide。
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "usage", order: 0 },
    UsageTrigger,
  ));
  // 输入栏自动审批开关（session 作用域：组件收到 sessionId 标准注入）。
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "dsh-config-auto-approve", order: 0 },
    AutoApproveToggle,
  ));
  // 用户消息导航悬浮面板（session 作用域：组件收到 useSession 标准注入）。
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "dsh-config-user-msg-nav", order: 1 },
    UserMessageNav,
  ));
  // 设置 → 插件 页的配置页签（0.2.0：插件配置页 = settings.plugins.tab 列表项）。
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
    {
      name: "settings.plugins.tab",
      id: "dsh-config-approval",
      order: 20,
      label: "自动模式",
    },
    ApprovalReviewCard,
  ));
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
    {
      name: "settings.plugins.tab",
      id: "dsh-config-codex-login",
      order: 21,
      label: "Codex 登录",
    },
    CodexLoginCard,
  ));
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
    {
      name: "settings.plugins.tab",
      id: "dsh-config-copilot-login",
      order: 22,
      label: "Copilot 登录",
    },
    CopilotLoginCard,
  ));
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
    {
      name: "settings.plugins.tab",
      id: "dsh-config-inject-once",
      order: 23,
      label: "备忘录",
    },
    InjectOnceCard,
  ));
}
