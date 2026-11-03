/**
 * 用量面板的模型家族名。
 *
 * 筛选和图例都按家族归并：剥掉 provider 前缀后，取模型名里的家族。
 * `x-preview` 本身带横线，不能切在第一个「-」上。
 */

/** 家族名本身带「-」，或藏在路径最后一段里。长的放前面。 */
const FAMILY_PREFIXES = [
  "x-preview",
  "deepseek",
  "claude",
  "mimo",
  "kimi",
  "grok",
  "nemotron",
  "glm",
  "gpt",
] as const;

/** 路径最后一段才是模型名（`provider/cursor/grok-4.7` → `grok-4.7`）。 */
function modelLeaf(model: string): string {
  const slash = model.lastIndexOf("/");
  const leaf = slash === -1 ? model : model.slice(slash + 1);
  return leaf.toLowerCase().replace(/^@/, "");
}

/** 筛选用、图例用的家族名。 */
export function modelGroupKey(model: string): string {
  const leaf = modelLeaf(model);
  const prefix = FAMILY_PREFIXES.find(
    (item) =>
      leaf === item ||
      leaf.startsWith(`${item}-`) ||
      leaf.includes(`-${item}-`) ||
      leaf.includes(`-${item}`),
  );
  if (prefix !== undefined) return prefix;
  const dash = leaf.indexOf("-");
  return dash === -1 ? leaf : leaf.slice(0, dash);
}
