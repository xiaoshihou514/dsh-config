/** Browser entry: mounts the sidebar usage entry, the composer auto-approve toggle, and the approval-review config card. */

import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { UsageTrigger } from "./UsageTrigger.tsx";
import { AutoApproveToggle } from "./AutoApproveToggle.tsx";
import { ApprovalReviewCard, type ApprovalReviewCardInjected, type ApprovalReviewSettings } from "./ApprovalReviewCard.tsx";
import { CodexLoginCard } from "./CodexLoginCard.tsx";
import { InjectOnceCard } from "./InjectOnceCard.tsx";

export const inject = ["slots", "connection", "settingsScope"];

export function apply(ctx: ClientContext): void {
  const approvalScope = ctx.settingsScope.bind<ApprovalReviewSettings>({ namespace: "dsh-config-approval" });
  const approvalInjected = (): ApprovalReviewCardInjected => ({
    scope: approvalScope,
    api: (ctx.get("connection") as ConnectionHandle).api,
  });

  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    {
      name: "sidebar.footer.action",
      id: "usage",
      order: 0,
      inject: () => ({})
    },
    UsageTrigger
  ));
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    {
      name: "conversation.input.left",
      id: "dsh-config-auto-approve",
      order: 0,
      inject: () => ({})
    },
    AutoApproveToggle
  ));
  // rc.2 still publishes the old keyed-slot types, while the runtime contract is already a list slot.
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
    ({
      name: "settings.plugin.item",
      id: "dsh-config-approval",
      inject: approvalInjected
    } as never),
    ApprovalReviewCard
  ));
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
    ({
      name: "settings.plugin.item",
      id: "dsh-config-codex-login",
      inject: () => ({})
    } as never),
    CodexLoginCard
  ));
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
    ({
      name: "settings.plugin.item",
      id: "dsh-config-inject-once",
      inject: () => ({})
    } as never),
    InjectOnceCard
  ));
}
