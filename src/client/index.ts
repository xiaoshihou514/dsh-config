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
import { createElement } from "react";
import { UsageTrigger } from "./UsageTrigger.tsx";
import { InjectOnceCard } from "./InjectOnceCard.tsx";
import { TurnNotify } from "./TurnNotify.tsx";
import { OfficeAction, OfficeSidebarTrigger, TEAM_PROMPT, officeHost } from "./OfficeAction.tsx";

export const inject = ["slots"];

/** 行配置条目的 key = `<包名>#<行 id>`（行 id 即 cordis.patch.yml 声明的行）。 */
const ROW_KEY = (rowId: string): `dsh-config#${string}` => `dsh-config#${rowId}`;

console.log("[dsh-config] client bundle 2026-11-04-1（全屏办公室）");

/** 打开成员会话（工作区服务就绪后填入）。 */
const workspaceRef: { openMember: ((leadId: string, memberId: string) => void) | undefined } = { openMember: undefined };

/**
 * 侧边栏底部：「办公室」与「用量」竖着叠放。宿主的 footer.action 容器是横向 flex，
 * 两个占满整行的按钮分开注册会互相挤掉，所以合成一个组件只注册一次。
 */
function SidebarFooterActions({ wide }: { wide: boolean }) {
  return createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", width: "100%", minWidth: 0 } },
    createElement(OfficeSidebarTrigger, {
      wide,
      openMember: (leadId: string, memberId: string) => workspaceRef.openMember?.(leadId, memberId),
    }),
    createElement(UsageTrigger, { wide }),
  );
}

export function apply(ctx: Context): void {
  // 侧边栏底部（设置上方）：办公室 + 用量。root 列表槽位，owner 传 wide。
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "usage", order: 0 },
    SidebarFooterActions,
  ));
  // 回合完成系统通知（隐形槽位组件：监听 session 快照，自身不渲染）。
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "dsh-config-turn-notify", order: 2 },
    TurnNotify,
  ));
  // 插件管理器（侧边栏插件按钮 → dsh-config → 行「配置」）的行配置页。
  ctx.slots.inject("plugins.row.config", () => ctx.slots.register(
    { name: "plugins.row.config", key: ROW_KEY("dsh-config-inject-once") },
    InjectOnceCard,
  ));
  // 智能体办公室：会话头部按钮（团队插件启用时显示）。打开成员会话需要工作区服务。
  ctx.inject(["uiWorkspace"], (scoped) => {
    const workspace = (scoped as unknown as {
      uiWorkspace: { openSession(target: unknown): void };
    }).uiWorkspace;
    const openMember = (leadId: string, memberId: string) => {
      if (memberId === leadId) workspace.openSession(leadId);
      else workspace.openSession({ parentSessionId: leadId, childSessionId: memberId, mode: "continuable" });
    };
    workspaceRef.openMember = openMember;
    // 快速组建团队：要工作区列表与会话服务；任一缺失时只保留切换功能。
    scoped.inject(["workspaces", "sessions"], (full) => {
      const services = full as unknown as {
        workspaces: {
          list: { getSnapshot(): { items: readonly { workspaceId: string; path: string; title: string }[] } };
          create(input: { path: string }): Promise<{ workspaceId: string; path: string }>;
        };
        sessions: {
          using<T>(
            target: string,
            options: { source: string },
            operation: (reference: { ready: Promise<{ session: { prompt(content: { type: "text"; text: string }[], mode: "queue"): Promise<{ ok?: boolean; error?: unknown } | unknown> } }> }) => Promise<T>,
          ): Promise<T>;
        };
      };
      const ui = workspace as unknown as {
        connectWorkspace(workspaceId: string): Promise<string>;
        pickDirectory(): Promise<string | null>;
      };
      officeHost.current = {
        openMember,
        listWorkspaces: () => services.workspaces.list.getSnapshot().items.map(({ workspaceId, path, title }) => ({ workspaceId, path, title })),
        pickDirectory: () => ui.pickDirectory(),
        async createTeam(path) {
          const existing = services.workspaces.list.getSnapshot().items.find((w) => w.path === path);
          const ws = existing ?? (await services.workspaces.create({ path }));
          const sessionId = await ui.connectWorkspace(ws.workspaceId);
          await services.sessions.using(sessionId, { source: "controllerOperation" }, async (reference) => {
            const binding = await reference.ready;
            const result = (await binding.session.prompt([{ type: "text", text: TEAM_PROMPT }], "queue")) as { ok?: boolean; error?: { message?: string } };
            if (result && result.ok === false) throw new Error(result.error?.message ?? "发送提示词失败");
          });
          return sessionId;
        },
      };
      full.effect(() => () => {
        officeHost.current = undefined;
      }, "dsh-config: office host");
    });
    scoped.effect(() => () => {
      if (workspaceRef.openMember === openMember) workspaceRef.openMember = undefined;
    }, "dsh-config: office workspace ref");
    scoped.slots.inject("conversation.session.header.actions", () => scoped.slots.register(
      {
        name: "conversation.session.header.actions",
        id: "dsh-config-agent-office",
        order: -19,
        inject: () => ({ openMember }),
      } as never,
      OfficeAction as never,
    ));
  });
}
