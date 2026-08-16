/** Browser entry: mounts the personal Token calendar in 设置 → 插件. */

import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { UsageCalendar } from "./UsageCalendar.tsx";

export const inject = ["slots"];

export function apply(ctx: ClientContext): void {
  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register(
      {
        name: "settings.plugin.item",
        id: "dsh-config",
        order: 15,
        inject: () => ({})
      },
      UsageCalendar
    );
  });
}
