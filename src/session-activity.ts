/**
 * 会话活动广播与工作区顺序推进：
 *
 * 1. 官方只在「用户直接发送的消息」时广播 api-session/activity（会话列表
 *    「最近更新」排序的依据）；助手回复不推进，导致选了「最近更新」排序
 *    后，模型回复中的会话不会浮到最前。本插件补发：每条 assistant/message
 *    （一轮回复落盘）也广播一次活动。
 *
 * 2. 工作区分组模式下，组的顺序 = 宿主工作区注册表的持久顺序（官方组件
 *    不按活动排组）。本插件在会话有活动（用户消息或 AI 回复）时，把该
 *    会话所属的工作区移到注册表顺序最前——侧边栏的组顺序随之实现
 *    「最近活动的组排最上」，且顺序持久化。
 *
 * 使用官方 workspaceRegistry 接口（resolveByPath / list / insertBefore），
 * 不修改任何宿主行为；同一工作区已在最前时跳过（自然节流）。
 */

import type { Context } from "@deepseek-ai/cordis";

export const name = "dsh-config-session-activity";
export const inject = ["sessions", "workspaceRegistry"];

interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ id: string } | undefined>;
  list(): { id: string }[];
  insertBefore(id: string, beforeId?: string): Promise<unknown>;
}

/** 会话活动 → 所属工作区移到注册表顺序最前（已在最前则跳过）。 */
async function promoteWorkspace(
  ctx: Context,
  cwd: string | undefined,
): Promise<void> {
  if (cwd === undefined || cwd.length === 0) return;
  const registry = (
    ctx as unknown as { workspaceRegistry?: WorkspaceRegistryLike }
  ).workspaceRegistry;
  if (registry === undefined) return;
  try {
    const workspace = await registry.resolveByPath(cwd);
    if (workspace === undefined) return;
    const ordered = registry.list();
    if (ordered[0]?.id === workspace.id) return;
    await registry.insertBefore(workspace.id, ordered[0]?.id);
  } catch (error) {
    ctx
      .logger("dsh-config-session-activity")
      .warn(
        "工作区顺序推进失败：%s",
        error instanceof Error ? error.message : String(error),
      );
  }
}

export function apply(ctx: Context): void {
  ctx.on("session/event", (session, event) => {
    // 助手回复：推进列表活动 + 所属工作区移到最前。
    if (event.type === "assistant/message") {
      ctx.emit("api-session/activity", session.id, event.time);
      void promoteWorkspace(ctx, session.header.cwd);
      return;
    }
    // 用户直接发送的消息：官方已推进列表活动，这里只补工作区顺序。
    if (event.type === "user/message" && event.data.source.kind === "user") {
      void promoteWorkspace(ctx, session.header.cwd);
    }
  });
}
