import { useEffect, useState, type CSSProperties } from "react";
import { IconCloseOutline16, IconDataOutline16 } from "./icons.tsx";
import { UsageSection } from "./UsageSection.tsx";

/** 侧边栏底部入口（设置上方）：用自己的图标打开用量弹窗。 */
export function UsageTrigger({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="用量"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: wide ? "calc(100% + 8px)" : 36,
          height: wide ? 34 : 36,
          margin: wide ? "4px -4px 4px" : "8px 0 10px",
          padding: wide ? "6px 2px 6px 10px" : 0,
          boxSizing: "border-box",
          border: "none",
          borderRadius: wide ? 12 : "50%",
          background: hover
            ? "var(--dsw-alias-interactive-bg-hover)"
            : "transparent",
          color: "var(--dsw-alias-label-primary)",
          cursor: "pointer",
          overflow: "hidden",
          justifyContent: wide ? "flex-start" : "center",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 22,
        }}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide && (
          <span style={{ overflow: "hidden", whiteSpace: "nowrap" }}>用量</span>
        )}
      </button>
      {open && <UsageModal onClose={() => setOpen(false)} />}
    </>
  );
}

/** 用量弹窗：全屏遮罩 + 居中面板，外壳与设置弹窗（SettingsRoot）逐项对齐。 */
function UsageModal({ onClose }: { onClose: () => void }) {
  const [closeHover, setCloseHover] = useState(false);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--dsw-alias-bg-mask-1)",
          backdropFilter: "var(--dsw-mask-blur)",
        }}
        onClick={onClose}
      />
      <div
        style={
          {
            position: "relative",
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            width: 800,
            maxWidth: "calc(100vw - 48px)",
            height: "min(800px, calc(100vh - 48px))",
            borderRadius: 24,
            overflow: "hidden",
            background: "var(--dsw-alias-bg-layer-2)",
            boxShadow: "var(--dsw-shadow-lv3)",
            "--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
            "--dsh-scrollbar-thumb-hover":
              "var(--dsw-alias-scrollbar-hover-l2)",
          } as CSSProperties
        }
      >
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "flex-end",
            gap: 8,
            height: 54,
            padding: "20px 14px 8px 10px",
            boxSizing: "border-box",
          }}
        >
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              border: "none",
              borderRadius: 28,
              background: closeHover
                ? "var(--dsw-alias-interactive-bg-hover)"
                : "transparent",
              cursor: "pointer",
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "0 24px 24px",
          }}
        >
          <UsageSection />
        </div>
      </div>
    </div>
  );
}
