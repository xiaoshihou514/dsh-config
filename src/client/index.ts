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
import { OfficeOverlay, OfficeToggle, TEAM_PROMPT, officeHost } from "./office/OfficeShell.tsx";

export const inject = ["slots"];

const layoutRef: { current: { selectPanel(panelId: null): void } | undefined } = { current: undefined };

/** 行配置条目的 key = `<包名>#<行 id>`（行 id 即 cordis.patch.yml 声明的行）。 */
const ROW_KEY = (rowId: string): `dsh-config#${string}` => `dsh-config#${rowId}`;

console.log("[dsh-config] client bundle 2026-11-04-2（办公室模式）");

/**
 * 侧边栏底部：「办公室」与「用量」竖着叠放。宿主的 footer.action 容器是横向 flex，
 * 两个占满整行的按钮分开注册会互相挤掉，所以合成一个组件只注册一次。
 */
function SidebarFooterActions({ wide }: { wide: boolean }) {
  return createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", width: "100%", minWidth: 0 } },
    createElement(OfficeToggle, { wide }),
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
  // 智能体办公室：全窗口覆盖层（办公室模式开启时显示，右侧留给原生对话）。
  ctx.slots.inject("shell.overlay" as never, () =>
    ctx.slots.register({ name: "shell.overlay", id: "dsh-config-office" } as never, OfficeOverlay as never),
  );
  // 布局服务（切回对话面板用）：可选。
  ctx.inject(["layout"], (scoped) => {
    layoutRef.current = (scoped as unknown as { layout: { selectPanel(panelId: null): void } }).layout;
    scoped.effect(
      () => () => {
        layoutRef.current = undefined;
      },
      "dsh-config: office layout ref",
    );
  });
  // 宿主能力：打开会话（右侧原生对话）、显示对话面板、快速组建团队。
  ctx.inject(["uiWorkspace", "workspaces", "sessions", "conversation"], (scoped) => {
    const services = scoped as unknown as {
      uiWorkspace: {
        openSession(target: unknown): void;
        openWorkspace(workspaceId: string, beforeOpen?: (sessionId: string) => void): Promise<void>;
        pickDirectory(): Promise<string | null>;
      };
      workspaces: {
        list: {
          getSnapshot(): { items: readonly { workspaceId: string; path: string; title: string }[] };
          subscribe(listener: () => void): () => void;
        };
        create(input: { path: string }): Promise<{ workspaceId: string; path: string }>;
        rename(workspaceId: string, title: string): Promise<unknown>;
      };
      sessions: {
        binding(sessionId: string): unknown;
      };
      conversation: {
        input: {
          requestDraftInitialization(
            binding: unknown,
            options: { prompt?: string; clearPreviousDraft?: boolean },
          ): "applied" | "preserved" | "blocked";
        };
      };
    };
    const ui = services.uiWorkspace;
    officeHost.current = {
      openSession(leadId, sessionId) {
        if (sessionId === leadId) ui.openSession(leadId);
        else ui.openSession({ parentSessionId: leadId, childSessionId: sessionId, mode: "continuable" });
      },
      showConversation() {
        try {
          layoutRef.current?.selectPanel(null);
        } catch {
          // 没有布局服务时忽略
        }
      },
      listWorkspaces: () =>
        services.workspaces.list.getSnapshot().items.map(({ workspaceId, path, title }) => ({ workspaceId, path, title })),
      pickDirectory: () => ui.pickDirectory(),
      subscribeWorkspaces: (listener) => services.workspaces.list.subscribe(listener),
      async renameProject(path, title) {
        const existing = services.workspaces.list.getSnapshot().items.find((w) => w.path === path);
        const ws = existing ?? (await services.workspaces.create({ path }));
        await services.workspaces.rename(ws.workspaceId, title);
      },
      async createTeam(path) {
        const existing = services.workspaces.list.getSnapshot().items.find((w) => w.path === path);
        const ws = existing ?? (await services.workspaces.create({ path }));
        let sessionId: string | undefined;
        // 新会话的输入框就绪后预填项目经理提示词，但不发送：留出补充指示和改写的余地。
        await ui.openWorkspace(ws.workspaceId, (id) => {
          sessionId = id;
          const binding = services.sessions.binding(id);
          if (binding === undefined) throw new Error("新会话尚未就绪，无法预填提示词");
          const result = services.conversation.input.requestDraftInitialization(binding, {
            prompt: TEAM_PROMPT,
            clearPreviousDraft: true,
          });
          if (result === "blocked") throw new Error("输入框正忙，无法预填提示词");
        });
        if (sessionId === undefined) throw new Error("未能打开会话");
        return sessionId;
      },
    };
    scoped.effect(
      () => () => {
        officeHost.current = undefined;
      },
      "dsh-config: office host",
    );
  });
}
