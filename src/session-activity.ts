/**
 * 会话活动广播：官方只在「用户直接发送的消息」时推进会话列表的
 * 最近活动时间（api-session/activity）；助手回复不推进，导致选了
 * 「最近更新」排序后，模型回复中的会话不会浮到最前。
 *
 * 本插件补发：每条 assistant/message（一轮回复落盘）也广播一次活动，
 * 使侧边栏会话按「最后一次回复」排序。纯事件转发，无状态。
 */

import type { Context } from "@deepseek-ai/cordis";

export const name = "dsh-config-session-activity";
export const inject = ["sessions"];

export function apply(ctx: Context): void {
  ctx.on("session/event", (session, event) => {
    if (event.type !== "assistant/message") return;
    ctx.emit("api-session/activity", session.id, event.time);
  });
}
