import { Context } from "@deepseek-ai/cordis";
//#region src/usage-api.d.ts
declare const name = "dsh-config-usage-api";
declare const inject: string[];
/** Last header per session, used to attribute its following usage event. */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };