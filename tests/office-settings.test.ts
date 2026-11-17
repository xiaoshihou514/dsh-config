import { describe, expect, it, vi } from "vitest";
import { nativeSettingsOpener } from "../src/client/office/OfficeShell.tsx";

describe("办公室「设置」打开原生设置", () => {
  it("调 sidebar.settings 槽位上设置外壳仓库的同一个实例的 open（与侧边栏设置按钮一致）", () => {
    const open = vi.fn();
    const instance = { actions: { open } };
    const slots = {
      entries: (key: string) =>
        key === "sidebar.settings" ? [{ options: { id: "other" } }, { options: { store: { create: () => instance } } }] : [],
    };
    nativeSettingsOpener(slots).open();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("找不到原生设置外壳时报错（由调用方退出办公室，而不是去点别的弹窗）", () => {
    expect(() => nativeSettingsOpener({ entries: () => [] }).open()).toThrow("找不到原生设置外壳");
  });
});
