import { defineConfig } from "tsdown";

const clientExternals = ["react", "react/jsx-runtime", "react-dom"];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "usage-api": "src/usage-api.ts",
      opencode: "src/opencode-provider.ts",
      "opencode-backend": "src/opencode-backend.ts",
      "inject-once": "src/inject-once.ts",
      "overflow-recovery": "src/overflow-recovery.ts",
      "session-activity": "src/session-activity.ts",
      "agent-office": "src/agent-office.ts",
      "team-model": "src/team-model.ts",
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    outDir: "lib",
    platform: "node",
    splitting: false,
  },
  {
    // 办公室 3D 场景：浏览器 ESM，由宿主路由按需提供，不进主 client bundle。
    entry: { "office-scene": "src/office-scene/index.ts" },
    outDir: "lib",
    format: "esm",
    platform: "browser",
    dts: false,
    clean: false,
    splitting: false,
    minify: true,
    noExternal: () => true,
  },
  {
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    splitting: false,
    external: clientExternals,
    noExternal: (id: string) =>
      clientExternals.includes(id) ? undefined : true,
    outputOptions: {
      entryFileNames: "client.js",
      banner:
        "window.__ModuleLoader__.load({ id: 'dsh-config', factory: (require) => {",
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
]);
