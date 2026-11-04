/**
 * 厂商人设调色与特征，依据 ../人设/体素/ 下的三视图像素画手工还原。
 *
 * 共同风格：大方头、大眼、蓬松长发向两侧外扩并垂到膝下、钟形长裙 + 荷叶边、
 * 手臂微张。
 *
 * - claude：橘色波浪长发、琥珀瞳、右侧橘花 + 黑蝴蝶结流苏；奶白泡泡袖衬衫、
 *   黑金束腰、奶白长裙配橘色前片与黑色侧片、奶白系带短靴；手捧书。
 * - gpt：银白（淡紫影）超长波浪发及地、大弯龙角、尖耳、呆毛、白玫瑰发饰；
 *   白色开衩长裙；腰间展开的白色龙翼、脚边卷起的鳞纹龙尾。
 * - deepseek：深蓝波浪长发渐浅、呆毛、女仆头饰、右侧蓝蝴蝶结、下垂鲸鳍耳；
 *   藏青泡泡袖女仆裙 + 通长白围裙（鲸鱼刺绣）、蓝色裙片、白荷叶边、白袜、
 *   藏青圆头鞋；鲸尾。
 * - gemini：蓝→粉渐变波浪长发、两侧丸子、猫耳、呆毛、星形发夹、异色瞳；
 *   藏青露腰上衣 + 白袖、藏青短裙 + 白荷叶衬裙、白毛绒袜套、厚底鞋；猫尾。
 * - glm：黑色直长发带蓝色发梢、横向大狐耳、女仆头饰 + 闭眼眼罩；白衬衫、
 *   黑束腰、白裙配黑侧片与灰荷叶边、白色系带靴；黑狐尾白尾尖。
 * - grok：金色大卷双马尾及膝、黑色蝙蝠翼大蝴蝶结、金色小王冠、尖耳；
 *   黑金哥特长裙前开露红色内裙、红领、棕色裤袜、黑鞋。
 * - kimi：银白（浅蓝影）蓬松波浪长发、大女仆头饰、右侧黑色三角棱镜 + 彩虹 +
 *   藏青蝴蝶结；藏青短披肩与束腰、白衬衫、藏青星空外裙前开露白荷叶内裙、
 *   白袜、藏青玛丽珍鞋。
 * - qwen：蓝紫波浪长发及踝、侧前麻花辫、藏青贝雷帽配白毛边与星徽流苏；
 *   白色旗袍 + 蓝腰封、藏青金纹长袍敞开、蓝色绑带鞋。
 * - 未知模型（other）：神秘旅人——深紫兜帽斗篷、薄荷银发、金瞳，提着发青光
 *   的提灯，身边漂浮「？」。三视图由 scripts/draw-unknown-persona.py 绘制
 *   （assets/personas/other.png），与其他各家走同一条像素画体素流程；这里的
 *   调色只给网格兜底角色用。
 */

import type { Vendor } from "../office/types.ts";

export type HairStyle = "straight" | "wavy" | "twintails" | "buns" | "braid";
export type Ears = "cat" | "fox" | "foxSide" | "fin" | "elf" | null;
export type Tail = "dragon" | "cat" | "fox" | "whale" | null;
export type Headwear = "maid" | "crown" | "beret" | "flower" | "mask" | "prism" | "hood" | null;
export type Held = "book" | "lantern" | null;

export interface Persona {
  readonly hair: string;
  readonly hairShade: string;
  /** 发梢渐变色。 */
  readonly hairTip?: string | undefined;
  /** 挑染色（内层发丝）。 */
  readonly hairStreak?: string | undefined;
  readonly style: HairStyle;
  /** 旗舰档后发下沿（体素 y，越小越长）。 */
  readonly hairLength?: number | undefined;
  /** 发丝波浪幅度。 */
  readonly wave?: number | undefined;
  readonly eyeL: string;
  readonly eyeR: string;
  readonly skin: string;
  /** 上衣 / 衬衫。 */
  readonly top: string;
  /** 束腰、领结、饰边。 */
  readonly accent: string;
  /** 裙子主体（外裙）。 */
  readonly skirt: string;
  /** 裙摆饰边。 */
  readonly hem: string;
  /** 前片 / 围裙（可选）。 */
  readonly apron?: string | undefined;
  /** 围裙是否通长（女仆装）。 */
  readonly apronFull?: boolean | undefined;
  /** 外裙前开时露出的内裙色。 */
  readonly skirtInner?: string | undefined;
  /** 裙子两侧斜片。 */
  readonly skirtSide?: string | undefined;
  /** 身边漂浮「？」。 */
  readonly question?: boolean | undefined;
  /** 披风 / 披肩（可选）。 */
  readonly cape?: string | undefined;
  readonly sleeve: string;
  readonly legwear: string;
  readonly shoes: string;
  readonly ears: Ears;
  readonly earColor?: string | undefined;
  readonly earInner?: string | undefined;
  readonly horns?: string | undefined;
  readonly tail: Tail;
  readonly tailColor?: string | undefined;
  readonly tailTip?: string | undefined;
  readonly wings?: "dragon" | undefined;
  readonly headwear: Headwear;
  readonly headwearColor?: string | undefined;
  /** 侧边发饰（花、蝴蝶结、玫瑰）颜色。 */
  readonly ornament?: string | undefined;
  readonly batBows?: boolean | undefined;
  readonly sparkles?: boolean | undefined;
  readonly ahoge?: boolean | undefined;
  readonly held: Held;
  /** 快速档主色（简装上衣）。 */
  readonly fastTop: string;
  readonly fastSkirt: string;
}

const SKIN = "#fde4d2";

export const PERSONAS: Record<Vendor, Persona> = {
  claude: {
    hair: "#e8743a",
    hairShade: "#c95a24",
    hairTip: "#ee8a4a",
    style: "wavy",
    hairLength: 9,
    wave: 1.8,
    eyeL: "#d9822a",
    eyeR: "#d9822a",
    skin: SKIN,
    top: "#f7efe4",
    accent: "#2a2326",
    skirt: "#f4ebde",
    hem: "#efe2cf",
    apron: "#e8743a",
    skirtSide: "#2a2326",
    sleeve: "#f7efe4",
    legwear: "#f4ebde",
    shoes: "#eadfcd",
    ears: null,
    tail: null,
    headwear: "flower",
    headwearColor: "#e8743a",
    held: "book",
    fastTop: "#f7efe4",
    fastSkirt: "#e8743a",
  },
  gpt: {
    hair: "#eeecf6",
    hairShade: "#cfc9e2",
    hairTip: "#dcd6f0",
    style: "wavy",
    hairLength: 2,
    wave: 2,
    eyeL: "#7f78d0",
    eyeR: "#7f78d0",
    skin: SKIN,
    top: "#fbfbfd",
    accent: "#d6d0ea",
    skirt: "#f7f6fb",
    hem: "#e6e2f2",
    sleeve: "#fbfbfd",
    legwear: SKIN,
    shoes: "#f1eff8",
    ears: "elf",
    horns: "#ece7f3",
    tail: "dragon",
    tailColor: "#eceaf6",
    tailTip: "#c9c0e0",
    wings: "dragon",
    headwear: null,
    ornament: "#ffffff",
    ahoge: true,
    held: null,
    fastTop: "#ffffff",
    fastSkirt: "#d6d0ea",
  },
  deepseek: {
    hair: "#2c4f9e",
    hairShade: "#1f3a7a",
    hairTip: "#5f95dc",
    style: "wavy",
    hairLength: 16,
    wave: 1.8,
    eyeL: "#3f7fe0",
    eyeR: "#3f7fe0",
    skin: SKIN,
    top: "#1e2a52",
    accent: "#1a2246",
    skirt: "#3d5fae",
    hem: "#ffffff",
    apron: "#ffffff",
    apronFull: true,
    sleeve: "#1e2a52",
    legwear: "#ffffff",
    shoes: "#1a2244",
    ears: "fin",
    earColor: "#24396f",
    earInner: "#3a5698",
    tail: "whale",
    tailColor: "#22346a",
    tailTip: "#3d5596",
    headwear: "maid",
    headwearColor: "#ffffff",
    ornament: "#3f7fe0",
    ahoge: true,
    held: null,
    fastTop: "#1e2a52",
    fastSkirt: "#3d5fae",
  },
  gemini: {
    hair: "#5f6ee6",
    hairShade: "#4a55c4",
    hairTip: "#e08ae6",
    style: "buns",
    hairLength: 10,
    wave: 2,
    eyeL: "#e04a6a",
    eyeR: "#e6b23a",
    skin: SKIN,
    top: "#2d2563",
    accent: "#a98af0",
    skirt: "#2d2563",
    hem: "#ffffff",
    sleeve: "#f1ecfa",
    legwear: "#ffffff",
    shoes: "#3a3486",
    ears: "cat",
    earColor: "#5f6ee6",
    earInner: "#f3b6d0",
    tail: "cat",
    tailColor: "#5f74e6",
    tailTip: "#c08ae6",
    headwear: null,
    sparkles: true,
    ahoge: true,
    held: null,
    fastTop: "#2d2563",
    fastSkirt: "#ffffff",
  },
  glm: {
    hair: "#1b1b24",
    hairShade: "#101016",
    hairTip: "#3a6fd0",
    hairStreak: "#2f5fbf",
    style: "straight",
    hairLength: 12,
    wave: 0.6,
    eyeL: "#4a5a8a",
    eyeR: "#4a5a8a",
    skin: SKIN,
    top: "#f6f6f8",
    accent: "#1d1d24",
    skirt: "#f2f2f5",
    hem: "#8a8d99",
    skirtSide: "#1d1d24",
    sleeve: "#f6f6f8",
    legwear: "#f2f2f5",
    shoes: "#f0f0f0",
    ears: "foxSide",
    earColor: "#1d1d24",
    earInner: "#f2f2f2",
    tail: "fox",
    tailColor: "#25252c",
    tailTip: "#f4f4f4",
    headwear: "mask",
    headwearColor: "#1d1d24",
    held: null,
    fastTop: "#f6f6f8",
    fastSkirt: "#1d1d24",
  },
  grok: {
    hair: "#f0cc72",
    hairShade: "#d6a948",
    hairTip: "#f6dc98",
    style: "twintails",
    wave: 2,
    eyeL: "#3a7be0",
    eyeR: "#3a7be0",
    skin: SKIN,
    top: "#1c1719",
    accent: "#c9a24a",
    skirt: "#1c1719",
    skirtInner: "#9e1f2e",
    hem: "#7a1424",
    sleeve: "#1c1719",
    legwear: "#4a3428",
    shoes: "#1a1416",
    ears: "elf",
    tail: null,
    headwear: "crown",
    headwearColor: "#d4ad4c",
    batBows: true,
    held: null,
    fastTop: "#1c1719",
    fastSkirt: "#9e1f2e",
  },
  kimi: {
    hair: "#eef0f8",
    hairShade: "#cdd2e8",
    hairTip: "#c6d6f6",
    style: "wavy",
    hairLength: 6,
    wave: 2.2,
    eyeL: "#6f80c0",
    eyeR: "#6f80c0",
    skin: SKIN,
    top: "#f8f8fc",
    accent: "#232a52",
    skirt: "#232a52",
    skirtInner: "#f7f7fb",
    hem: "#d9dcec",
    cape: "#232a52",
    sleeve: "#f8f8fc",
    legwear: "#ffffff",
    shoes: "#1e2448",
    ears: null,
    tail: null,
    headwear: "prism",
    headwearColor: "#ffffff",
    ornament: "#232a52",
    held: null,
    fastTop: "#232a52",
    fastSkirt: "#f7f7fb",
  },
  qwen: {
    hair: "#6f80e0",
    hairShade: "#5664c4",
    hairTip: "#b49aea",
    style: "braid",
    hairLength: 4,
    wave: 2,
    eyeL: "#7a64d0",
    eyeR: "#7a64d0",
    skin: SKIN,
    top: "#f6f7fc",
    accent: "#4a6fd0",
    skirt: "#26306e",
    skirtInner: "#f4f5fb",
    hem: "#e8ebf8",
    cape: "#26306e",
    sleeve: "#26306e",
    legwear: "#ffffff",
    shoes: "#2c3486",
    ears: null,
    tail: null,
    headwear: "beret",
    headwearColor: "#26306e",
    ornament: "#26306e",
    held: null,
    fastTop: "#f6f7fc",
    fastSkirt: "#26306e",
  },
  other: {
    hair: "#bfe6dc",
    hairShade: "#94c9bc",
    hairTip: "#e6fbf5",
    style: "straight",
    hairLength: 14,
    wave: 0.5,
    eyeL: "#e6b23a",
    eyeR: "#e6b23a",
    skin: SKIN,
    top: "#2a2140",
    accent: "#4fe0d0",
    skirt: "#2a2140",
    skirtInner: "#3b2f5c",
    hem: "#4fe0d0",
    cape: "#2a2140",
    sleeve: "#2a2140",
    legwear: "#2a2140",
    shoes: "#1a1428",
    ears: null,
    tail: null,
    headwear: "hood",
    headwearColor: "#2a2140",
    held: "lantern",
    question: true,
    fastTop: "#2a2140",
    fastSkirt: "#3b2f5c",
  },
};
