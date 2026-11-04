/**
 * 模型 → 厂商 / 档位，成员名与职责描述 → 岗位。宿主与 3D 场景共用。
 *
 * 想调整哪个模型算「快速」、哪个算「旗舰」，改 {@link FAST_PATTERNS} /
 * {@link FLAGSHIP_PATTERNS} 即可：先匹配旗舰，再匹配快速，都不中按旗舰算。
 */

import type { RoleKind, Tier, Vendor } from "./types.ts";

/** 厂商识别：按顺序匹配「供应商 / 模型 id」小写串，先中先得。 */
const VENDOR_PATTERNS: readonly (readonly [Vendor, RegExp])[] = [
  ["claude", /claude|anthropic|opus|sonnet|haiku|fable|mythos/],
  ["gemini", /gemini|google|argon/],
  ["grok", /grok|xai/],
  ["kimi", /kimi|moonshot/],
  ["qwen", /qwen|qwq|dashscope|bailian/],
  ["glm", /glm|zai|zhipu|bigmodel/],
  ["deepseek", /deepseek/],
  ["gpt", /gpt|openai|codex|\bo\d|luna|terra|astra|\bsol\b|-sol/],
];

/** 明确的旗舰标记（优先于快速）。 */
const FLAGSHIP_PATTERNS: readonly RegExp[] = [
  /opus/,
  /fable/,
  /mythos/,
  /astra/,
  /(^|[-/.])sol($|[-.])/,
  /(^|[-/])pro($|[-.])/,
  /(^|[-/])max($|[-.])/,
  /ultra/,
  /argon/,
];

/** 快速档标记。 */
const FAST_PATTERNS: readonly RegExp[] = [
  /flash/,
  /haiku/,
  /sonnet/,
  /luna/,
  /terra/,
  /mini/,
  /nano/,
  /lite/,
  /turbo/,
  /-fast/,
  /(^|[-/])air($|[-.])/,
  /spark/,
  /instant/,
  /small/,
];

export function vendorOf(provider: string | undefined, model: string | undefined): Vendor {
  const key = `${provider ?? ""}/${model ?? ""}`.toLowerCase();
  // 模型名优先：同一供应商（如 cursor、opencodex）会转售多家模型。
  const modelKey = (model ?? "").toLowerCase();
  for (const [vendor, pattern] of VENDOR_PATTERNS)
    if (pattern.test(modelKey)) return vendor;
  for (const [vendor, pattern] of VENDOR_PATTERNS)
    if (pattern.test(key)) return vendor;
  return "other";
}

export function tierOf(model: string | undefined): Tier {
  const key = (model ?? "").toLowerCase();
  if (FLAGSHIP_PATTERNS.some((pattern) => pattern.test(key))) return "flagship";
  if (FAST_PATTERNS.some((pattern) => pattern.test(key))) return "fast";
  return "flagship";
}

/** 岗位关键词：按顺序匹配「名字 + 描述」，先中先得。 */
const ROLE_PATTERNS: readonly (readonly [RoleKind, RegExp])[] = [
  ["reviewer", /review|审查|审核|评审|code-?check/],
  ["qa", /\bqa\b|test|测试|质检|质量/],
  ["frontend", /front|前端|\bui\b|\bux\b|vue|react|web|界面|页面/],
  ["backend", /back|后端|server|服务端|rust|tauri|api|数据库|\bdb\b/],
  ["design", /design|设计|美术|视觉|art/],
  ["docs", /doc|文档|writer|写作|翻译/],
  ["devops", /devops|\bops\b|运维|部署|deploy|\bci\b|infra|构建|release|发布/],
  ["data", /data|数据|research|研究|调研|分析|analy/],
];

export function roleKindOf(
  role: "lead" | "teammate",
  name: string,
  description: string | undefined,
): RoleKind {
  if (role === "lead") return "lead";
  const key = `${name} ${description ?? ""}`.toLowerCase();
  for (const [kind, pattern] of ROLE_PATTERNS) if (pattern.test(key)) return kind;
  return "general";
}

export const VENDOR_LABEL: Record<Vendor, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  qwen: "Qwen",
  glm: "GLM",
  deepseek: "DeepSeek",
  other: "未知",
};

export const TIER_LABEL: Record<Tier, string> = {
  flagship: "旗舰",
  fast: "快速",
};

export const ROLE_LABEL: Record<RoleKind, string> = {
  lead: "组长",
  frontend: "前端",
  backend: "后端",
  qa: "测试",
  reviewer: "审查",
  docs: "文档",
  design: "设计",
  devops: "运维",
  data: "数据",
  general: "组员",
};

/** 岗位主色（工牌、袖章、名牌），浏览器与场景共用。 */
export const ROLE_COLOR: Record<RoleKind, string> = {
  lead: "#f2b632",
  frontend: "#ec6fa8",
  backend: "#2fb3a3",
  qa: "#f08a3c",
  reviewer: "#e04f4f",
  docs: "#a7794a",
  design: "#9a6cf0",
  devops: "#5b7fd6",
  data: "#4fb85b",
  general: "#8a93a3",
};
