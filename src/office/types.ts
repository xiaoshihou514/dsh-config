/**
 * 智能体办公室的宿主 ↔ 浏览器数据契约（纯类型，无运行时依赖）。
 *
 * 宿主从 Lead 与各成员会话的事件日志推导出 {@link OfficeSnapshot}，浏览器
 * 轮询 `/dsh-config/office?lead=<会话 id>` 取得后交给 3D 场景与侧栏渲染。
 */

/** 厂商：决定体素人设（发色、服饰、标志性配件）。 */
export type Vendor =
  | "claude"
  | "gpt"
  | "gemini"
  | "grok"
  | "kimi"
  | "qwen"
  | "glm"
  | "deepseek"
  | "other";

/** 档位：旗舰按人设全装建模，快速为小只简装。 */
export type Tier = "flagship" | "fast";

/** 岗位：决定手持道具、工牌颜色与工位摆设。 */
export type RoleKind =
  | "lead"
  | "frontend"
  | "backend"
  | "qa"
  | "reviewer"
  | "docs"
  | "design"
  | "devops"
  | "data"
  | "general";

/** 工具调用的大类：决定显示器画面与动作。 */
export type ToolCategory =
  | "shell"
  | "read"
  | "edit"
  | "search"
  | "web"
  | "team"
  | "plan"
  | "wait"
  | "other";

/** 成员此刻在做什么（只对运行中的成员有意义）。 */
export interface OfficeCurrent {
  readonly kind: "thinking" | "tool" | "waiting";
  readonly category?: ToolCategory | undefined;
  readonly tool?: string | undefined;
  readonly label: string;
  readonly since: number;
}

/** 成员活动流里的一条。 */
export interface OfficeActivity {
  readonly at: number;
  readonly kind: "tool" | "say" | "think" | "receive" | "turn" | "error";
  readonly category?: ToolCategory | undefined;
  readonly tool?: string | undefined;
  readonly label: string;
  /** 较长的正文（消息、回复），已截断。 */
  readonly detail?: string | undefined;
  /** 工具结果是否出错；未返回时缺省。 */
  readonly failed?: boolean | undefined;
}

export interface OfficeMemberStats {
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly sent: number;
  readonly received: number;
  readonly outputTokens: number;
}

export interface OfficeMember {
  readonly id: string;
  readonly name: string;
  readonly role: "lead" | "teammate";
  readonly description?: string | undefined;
  readonly phase: "provisioning" | "active" | "failed";
  readonly error?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly vendor: Vendor;
  readonly tier: Tier;
  readonly roleKind: RoleKind;
  /** 宿主侧判断：会话已加载且有未结束的步骤。浏览器会用实时状态覆盖。 */
  readonly busy: boolean;
  readonly current?: OfficeCurrent | undefined;
  readonly lastActiveAt?: number | undefined;
  readonly joinedAt?: number | undefined;
  readonly stats: OfficeMemberStats;
  /** 最近的活动，按时间正序。 */
  readonly activity: readonly OfficeActivity[];
}

/** 成员之间（含你本人）的一次交流。`from`/`to` 是成员 id，你本人为 `"user"`。 */
export interface OfficeInteraction {
  readonly id: string;
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly kind: "spawn" | "message" | "report" | "instruction";
  readonly preview: string;
  readonly text: string;
}

export interface OfficeTask {
  readonly id: string;
  readonly subject: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly ownerName?: string | undefined;
}

export interface OfficeSnapshot {
  readonly leadId: string;
  readonly title?: string | undefined;
  readonly cwd?: string | undefined;
  readonly generatedAt: number;
  readonly members: readonly OfficeMember[];
  readonly interactions: readonly OfficeInteraction[];
  /** 共享任务板；为空时用 Lead 的待办清单代替（`source: "todo"`）。 */
  readonly tasks: readonly OfficeTask[];
  readonly taskSource: "team" | "todo" | "none";
}

/** 你本人在交流图里的固定 id。 */
export const USER_ID = "user";
