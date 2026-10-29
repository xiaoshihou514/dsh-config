/** dsh → opencode 会话映射的持久化：读回、损坏降级、原子写。 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionMap, writeSessionMap } from "../src/opencode-session-map.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dsh-opencode-map-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("opencode 会话映射文件", () => {
  it("写回后能读回同一份映射，并自动建父目录", async () => {
    const file = join(await temporaryDirectory(), "nested", "sessions.json");
    const map = new Map([
      ["ses_dsh_1", "ses_opencode_1"],
      ["ses_dsh_2", "ses_opencode_2"],
    ]);

    writeSessionMap(file, map);

    expect(readSessionMap(file)).toEqual(map);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("文件不存在或 JSON 损坏时返回空映射", async () => {
    const file = join(await temporaryDirectory(), "sessions.json");
    expect(readSessionMap(file).size).toBe(0);

    await writeFile(file, "{not json");
    expect(readSessionMap(file).size).toBe(0);
  });

  it("忽略非字符串值与非对象根节点", async () => {
    const file = join(await temporaryDirectory(), "sessions.json");
    await writeFile(
      file,
      JSON.stringify({ good: "ses_1", bad: 42, alsoBad: null, nested: { id: "x" } }),
    );
    expect([...readSessionMap(file)]).toEqual([["good", "ses_1"]]);

    await writeFile(file, JSON.stringify(["ses_1"]));
    expect(readSessionMap(file).size).toBe(0);
  });

  it("覆盖写不会残留临时文件", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    const file = join(directory, "sessions.json");
    writeSessionMap(file, new Map([["a", "b"]]));
    writeSessionMap(file, new Map([["a", "c"]]));

    expect(readSessionMap(file).get("a")).toBe("c");
    await expect(readFile(`${file}.tmp`, "utf8")).rejects.toThrow();
  });
});
