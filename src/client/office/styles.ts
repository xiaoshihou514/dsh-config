/**
 * 办公室界面样式：沿用原生的 --dsw-* 配色与字体（明暗主题跟随原生），
 * 加游戏 HUD 的味道——分层面板、角色色描边卡片、发光状态灯、按压感按钮、
 * 任务条与统计格。
 */

export const CSS = String.raw`
/* ---- 办公室模式下原生布局：中央列把对话挤到最右一栏 ---- */
body[data-dsh-office] [class*="_centerCol"] {
  padding-left: max(0px, calc(100% - var(--dsh-office-chat, 480px))) !important;
  box-sizing: border-box !important;
}
body[data-dsh-office-dragging] { cursor: col-resize !important; user-select: none !important; }
body[data-dsh-office-dragging] iframe, body[data-dsh-office-dragging] canvas { pointer-events: none; }

/* ---- 侧边栏开关 ---- */
.dso-side-toggle {
  flex: none; display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 36px; height: 36px; margin: 8px 0 0; padding: 0; box-sizing: border-box;
  border: 0; border-radius: 50%; background: transparent; cursor: pointer; overflow: hidden;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px;
}
.dso-side-toggle.wide {
  justify-content: flex-start; width: calc(100% + 8px); height: 34px; margin: 4px -4px 0;
  padding: 6px 2px 6px 10px; border-radius: 12px;
}
.dso-side-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dso-side-toggle span { white-space: nowrap; overflow: hidden; }

/* ---- 覆盖层 ---- */
.dso-root {
  position: fixed; left: 0; top: 0; bottom: 0; z-index: 40; pointer-events: auto;
  display: flex; color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px;
  background: var(--dsw-alias-bg-base);
  box-shadow: 4px 0 18px rgba(0,0,0,.12);
}
.dso-splitter {
  position: absolute; top: 0; bottom: 0; right: -4px; width: 8px; cursor: col-resize; z-index: 5;
}
.dso-splitter::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px;
  background: var(--dsw-alias-border-l2); transition: background .15s;
}
.dso-splitter:hover::after, body[data-dsh-office-dragging] .dso-splitter::after {
  background: var(--dsw-alias-state-business-primary);
}
.dso-office { flex: 1; min-width: 0; display: flex; flex-direction: column; }

/* ---- 顶部 HUD ---- */
.dso-hud {
  flex: none; height: 54px; display: flex; align-items: center; gap: 10px; padding: 0 12px 0 14px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  position: relative; z-index: 3;
}
.dso-logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; white-space: nowrap; letter-spacing: .02em; }
.dso-logo-mark {
  width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: #3a2a08;
  background: linear-gradient(160deg, #ffd76a, #e3a52e); box-shadow: inset 0 -2px 0 rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.2);
}
.dso-stats { display: flex; gap: 6px; }
.dso-stat {
  display: inline-flex; align-items: baseline; gap: 4px; padding: 3px 9px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap;
}
.dso-stat b { font-size: 14px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dso-stat.good b { color: var(--dsw-alias-state-success-primary); }
.dso-tabs {
  display: flex; padding: 3px; gap: 2px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
}
.dso-tabs button {
  border: 0; background: transparent; padding: 5px 12px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 600;
}
.dso-tabs button.on {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 0 rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.12), inset 0 -2px 0 #f2b632;
}
.dso-icon-btn {
  width: 32px; height: 32px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px;
}
.dso-icon-btn:hover { color: var(--dsw-alias-label-primary); }

/* ---- 按钮 ---- */
.dso-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 12px;
  border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); cursor: pointer; white-space: nowrap;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; font-weight: 600;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,.08); transition: transform .06s, filter .15s;
}
.dso-btn:hover { filter: brightness(1.04); }
.dso-btn:active { transform: translateY(1px); box-shadow: none; }
.dso-btn:disabled { opacity: .55; cursor: default; }
.dso-btn.primary {
  border-color: transparent; color: #fff;
  background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-state-business-primary) 85%, #fff), var(--dsw-alias-state-business-primary));
  box-shadow: inset 0 -2px 0 rgba(0,0,0,.22), 0 1px 3px rgba(0,0,0,.18);
}
.dso-btn.ghost { background: transparent; box-shadow: none; }
.dso-btn.sm { height: 26px; padding: 0 10px; font-size: 11px; }
.dso-link { border: 0; background: transparent; padding: 0; cursor: pointer; font: inherit; font-size: 11px; color: var(--dsw-alias-state-business-primary); }

/* ---- 项目选择 ---- */
.dso-picker-wrap { position: relative; min-width: 0; }
.dso-project {
  display: flex; align-items: center; gap: 9px; min-width: 0; max-width: 380px; height: 38px; padding: 0 10px 0 6px;
  border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); color: inherit; font: inherit; text-align: left;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,.06);
}
.dso-project:hover, .dso-project.open { border-color: color-mix(in srgb, #f2b632 60%, var(--dsw-alias-border-l2)); }
.dso-project-flag {
  flex: none; width: 8px; height: 26px; border-radius: 3px;
  background: linear-gradient(180deg, #ffd76a, #e3a52e); box-shadow: 0 0 6px rgba(242,182,50,.45);
}
.dso-project-text { display: flex; flex-direction: column; min-width: 0; line-height: 15px; }
.dso-project-text b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dso-project-text small, .dso-team-text small, .dso-team-meta small {
  color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dso-caret { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-left: auto; }
.dso-picker {
  position: absolute; top: 44px; left: 0; z-index: 20; width: 440px; max-height: min(600px, 78vh); overflow-y: auto;
  padding: 8px; border-radius: 14px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent);
  animation: dso-pop .14s ease-out;
}
@keyframes dso-pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
.dso-picker-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 6px 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; color: var(--dsw-alias-label-tertiary);
}
.dso-picker-head em { font-style: normal; font-weight: 500; letter-spacing: 0; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dso-cards { display: flex; flex-direction: column; gap: 6px; }
.dso-team-card {
  display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 10px;
  border-radius: 11px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: inherit; font: inherit; text-align: left; cursor: pointer; transition: transform .08s, border-color .15s;
}
.dso-team-card:hover { transform: translateY(-1px); border-color: var(--dsw-alias-border-l3); }
.dso-team-card.on { border-color: #f2b632; box-shadow: 0 0 0 1px #f2b632 inset, 0 2px 10px rgba(242,182,50,.18); }
.dso-team-card.new { cursor: default; }
.dso-team-card.new:hover { transform: none; }
.dso-team-card.add { justify-content: center; border-style: dashed; color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.dso-team-badge {
  flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
  font-weight: 800; font-size: 15px; color: #3a2a08;
  background: linear-gradient(160deg, #ffd76a, #e3a52e); box-shadow: inset 0 -2px 0 rgba(0,0,0,.16);
}
.dso-team-badge.ghost { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2); }
.dso-team-text { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 17px; }
.dso-team-text b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dso-team-meta { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.dso-pill {
  padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 700;
  background: color-mix(in srgb, #f2b632 22%, transparent); color: color-mix(in srgb, #b07a10 80%, var(--dsw-alias-label-primary));
}
.dso-prompt {
  margin: 0 4px 8px; padding: 9px 11px; border-radius: 10px; font-size: 12px; line-height: 19px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  border-left: 3px solid #f2b632;
}

/* ---- 主体 ---- */
.dso-body { flex: 1; min-height: 0; display: flex; }
.dso-side {
  width: 316px; flex: none; overflow-y: auto; box-sizing: border-box; padding: 12px 12px 24px;
  background: var(--dsw-alias-bg-layer-2); border-right: 1px solid var(--dsw-alias-border-l2);
}
.dso-stage { flex: 1; min-width: 0; position: relative; background: linear-gradient(180deg, #cfe3f5 0%, #eef3f8 60%, #f5efe6 100%); }
.dso-scene { position: absolute; inset: 0; }
.dso-notice {
  position: absolute; left: 50%; top: 16px; transform: translateX(-50%); padding: 7px 14px; border-radius: 10px;
  background: rgba(20,24,33,.8); color: #fff; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.2);
}
.dso-hint { position: absolute; left: 12px; bottom: 10px; font-size: 11px; color: rgba(30,40,55,.55); pointer-events: none; }

.dso-section {
  display: flex; align-items: center; gap: 8px; margin: 16px 2px 8px; font-size: 11px; font-weight: 800;
  letter-spacing: .1em; color: var(--dsw-alias-label-tertiary);
}
.dso-section::after { content: ""; flex: 1; height: 1px; background: var(--dsw-alias-border-l2); }
.dso-section small { font-size: 11px; font-weight: 600; letter-spacing: 0; padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
.dso-section:first-child { margin-top: 2px; }
.dso-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; padding: 8px 6px; }
.dso-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; padding: 6px 6px; }
.dso-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dso-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* ---- 角色卡 ---- */
.dso-roster { display: flex; flex-direction: column; gap: 8px; }
.dso-card {
  position: relative; display: flex; align-items: stretch; border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: inset 4px 0 0 var(--role), 0 1px 2px rgba(0,0,0,.05); transition: transform .08s, box-shadow .15s;
}
.dso-card:hover { transform: translateY(-1px); box-shadow: inset 4px 0 0 var(--role), 0 4px 12px rgba(0,0,0,.1); }
.dso-card-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px;
  border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dso-card-chat {
  flex: none; width: 38px; border: 0; border-left: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  background: transparent; font-size: 15px; filter: grayscale(.3);
}
.dso-card-chat:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); filter: none; }
.dso-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dso-card-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dso-card-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dso-role-tag {
  flex: none; padding: 0 6px; border-radius: 6px; font-size: 10px; font-weight: 800; line-height: 17px; color: #1b1b1b;
  background: var(--role); box-shadow: inset 0 -1px 0 rgba(0,0,0,.15);
}
.dso-card-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dso-card-status { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dso-led { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.good .dso-led { background: #3fd07a; box-shadow: 0 0 0 2px rgba(63,208,122,.2), 0 0 8px #3fd07a; animation: dso-blink 1.6s infinite; }
.info .dso-led { background: #5b9bf0; box-shadow: 0 0 8px #5b9bf0; animation: dso-blink 1s infinite; }
.bad .dso-led { background: #e04f4f; box-shadow: 0 0 8px #e04f4f; }
@keyframes dso-blink { 50% { opacity: .45; } }
.good .dso-card-status span:last-child { color: var(--dsw-alias-label-primary); }

/* ---- 头像 ---- */
.dso-avatar { position: relative; flex: none; display: inline-block; }
.dso-avatar-frame {
  position: absolute; inset: 0; border-radius: 12px; overflow: hidden; display: grid; place-items: center;
  background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--role) 26%, var(--dsw-alias-bg-layer-2)), color-mix(in srgb, var(--role) 8%, var(--dsw-alias-bg-layer-1)));
  box-shadow: 0 0 0 2px var(--role), inset 0 -3px 0 rgba(0,0,0,.08);
}
.dso-avatar-frame img { width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; }
.dso-avatar-letter { font-weight: 800; color: var(--role); }
.dso-avatar-badge {
  position: absolute; right: -6px; bottom: -6px; width: 44%; height: 44%; border-radius: 8px;
  display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 0 0 2px var(--role), 0 2px 4px rgba(0,0,0,.18);
}
.dso-avatar-badge img { width: 84%; height: 84%; image-rendering: pixelated; }

/* ---- 详情 ---- */
.dso-back {
  border: 0; background: transparent; padding: 2px 4px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700;
  color: var(--dsw-alias-label-tertiary);
}
.dso-back:hover { color: var(--dsw-alias-label-primary); }
.dso-hero {
  margin-top: 8px; display: flex; align-items: center; gap: 14px; padding: 14px 12px 14px 14px; border-radius: 14px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--role) 16%, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-1) 70%);
  border: 1px solid color-mix(in srgb, var(--role) 45%, var(--dsw-alias-border-l2));
}
.dso-hero-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dso-hero-name { display: flex; align-items: center; gap: 6px; }
.dso-hero-name b { font-size: 16px; }
.dso-desc { margin: 10px 2px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dso-quest {
  margin-top: 10px; padding: 7px 10px; border-radius: 9px; font-size: 12px; font-weight: 600;
  background: repeating-linear-gradient(-45deg, color-mix(in srgb, #3fd07a 14%, transparent) 0 8px, color-mix(in srgb, #3fd07a 7%, transparent) 8px 16px);
  border: 1px solid color-mix(in srgb, #3fd07a 40%, transparent); animation: dso-scroll 1.2s linear infinite; background-size: 200% 100%;
}
@keyframes dso-scroll { to { background-position: -22px 0; } }
.dso-actions { display: flex; gap: 8px; margin-top: 12px; }
.dso-actions .dso-btn { flex: 1; }
.dso-statgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 12px; }
.dso-statgrid div {
  display: flex; flex-direction: column; align-items: center; padding: 7px 4px; border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
}
.dso-statgrid b { font-size: 15px; font-variant-numeric: tabular-nums; }
.dso-statgrid span { font-size: 10px; color: var(--dsw-alias-label-tertiary); }

/* ---- 自绘下拉 ---- */
.dso-picks { display: flex; flex-direction: column; gap: 6px; }
.dso-pick { position: relative; display: flex; align-items: center; gap: 10px; }
.dso-pick-label { width: 36px; flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dso-pick-btn {
  flex: 1; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: inherit;
  font: inherit; font-size: 12px; cursor: pointer; text-align: left; box-shadow: inset 0 -2px 0 rgba(0,0,0,.05);
}
.dso-pick-btn small { color: var(--dsw-alias-label-tertiary); font-size: 10px; padding: 0 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2); }
.dso-pick-btn.open, .dso-pick-btn:hover { border-color: var(--dsw-alias-border-l3); }
.dso-pick-menu {
  position: absolute; left: 46px; right: 0; top: 34px; z-index: 10; max-height: 260px; overflow-y: auto; padding: 5px;
  border-radius: 11px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-prominent); animation: dso-pop .12s ease-out;
}
.dso-pick-menu button {
  display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; text-align: left;
}
.dso-pick-menu button:hover { background: var(--dsw-alias-bg-layer-1); }
.dso-pick-menu button.on { background: color-mix(in srgb, #f2b632 18%, transparent); font-weight: 700; }
.dso-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; box-shadow: inset 0 -1px 0 rgba(0,0,0,.2); }

/* ---- 交流日志 ---- */
.dso-logs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.dso-log {
  padding: 7px 9px 7px 11px; border-radius: 9px; cursor: pointer; background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 3px 0 0 var(--kind);
}
.dso-log:hover { background: color-mix(in srgb, var(--kind) 7%, var(--dsw-alias-bg-layer-1)); }
.dso-log-head { display: flex; align-items: center; gap: 5px; font-size: 12px; min-width: 0; }
.dso-log-kind {
  flex: none; font-size: 10px; font-weight: 800; padding: 0 5px; border-radius: 5px; line-height: 16px;
  color: var(--kind); background: color-mix(in srgb, var(--kind) 14%, transparent);
}
.dso-log-time { margin-left: auto; flex: none; font-size: 11px; }
.dso-log-preview { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dso-log-full {
  margin: 5px 0 0; max-height: 280px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
  font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
`;
