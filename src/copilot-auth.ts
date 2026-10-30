import { homedir } from "node:os";
import { join } from "node:path";

/** Copilot 登录凭据路径。用量面板用其中的 GitHub OAuth refresh 查询配额。 */
export function copilotAuthFile(): string {
  const root = process.env.COPILOT_HOME?.trim() || join(homedir(), ".dsh");
  return join(root, "copilot", "auth.json");
}
