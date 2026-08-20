import { defineConfig } from "tsdown";

const clientExternals = ["react", "react/jsx-runtime"];

/**
 * pi-ai 必须保持 external：它的 OAuth 加载器用变量动态 import
 * `importOAuthModule("./openai-codex.ts")` 相对自身包内解析，打进插件 bundle
 * 后相对路径会指向插件 lib/（找不到 openai-codex.js）。运行时从 node_modules
 * 加载 pi-ai 即可让该相对导入落在 pi-ai 自己的 dist/auth/oauth/ 下。
 */
const nodeExternal = (id: string): boolean =>
  id === "@earendil-works/pi-ai" || id.startsWith("@earendil-works/pi-ai/");

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "usage-api": "src/usage-api.ts",
      "approval-review": "src/approval-review.ts",
      opencode: "src/opencode-provider.ts",
      "codex-provider": "src/codex-provider.ts",
      "inject-once": "src/inject-once.ts",
      "overflow-recovery": "src/overflow-recovery.ts",
      bilibili: "src/bilibili/index.ts"
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    outDir: "lib",
    platform: "node",
    splitting: false,
    external: nodeExternal
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
    noExternal: (id: string) => clientExternals.includes(id) ? undefined : true,
    outputOptions: {
      entryFileNames: "client.js",
      banner: "window.__ModuleLoader__.load({ id: 'dsh-config', factory: (require) => {",
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;"
    }
  }
]);
