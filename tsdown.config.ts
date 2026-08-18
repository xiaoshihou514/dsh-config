import { defineConfig } from "tsdown";

const clientExternals = ["react", "react/jsx-runtime"];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "usage-api": "src/usage-api.ts",
      "approval-review": "src/approval-review.ts",
      opencode: "src/opencode-provider.ts",
      "codex-provider": "src/codex-provider.ts"
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    outDir: "lib",
    platform: "node",
    splitting: false
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
