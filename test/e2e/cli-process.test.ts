import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cliPath = path.resolve("src/cli.ts");
const tsxLoaderPath = path.resolve("node_modules/tsx/dist/loader.mjs");
const mockFetchPath = path.resolve("test/fixtures/mock-fetch.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-process-e2e-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  input = ""
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      tsxLoaderPath,
      "--import",
      mockFetchPath,
      cliPath,
      ...args,
    ], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("CLI 真实进程 E2E", () => {
  it("通过本地兼容 API 完成 list files 并保存会话", async () => {
    const cwd = await temporaryDirectory();
    await fs.writeFile(path.join(cwd, "README.md"), "# 测试项目");
    const result = await runCli(
      ["--provider", "deepseek", "list files"],
      cwd,
      {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://xycli.test/v1",
        XYCLI_E2E_MOCK_FETCH: "1",
      }
    );

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("已完成真实 CLI 文件列表测试");
    expect(result.stderr).toBe("");
    const sessionDirectory = path.join(cwd, ".xycli", "sessions", "json");
    const sessionFiles = await fs.readdir(sessionDirectory);
    expect(sessionFiles.some((file) => file.endsWith(".json"))).toBe(true);
  });

  it("Provider 参数非法时返回校验退出码且不打印堆栈", async () => {
    const cwd = await temporaryDirectory();
    const result = await runCli(["--provider", "unknown", "测试"], cwd);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("不支持的 Provider");
    expect(result.stderr).not.toContain("at Command");
  });

  it("缺少 Provider Key 时返回退出码 4", async () => {
    const cwd = await temporaryDirectory();
    const result = await runCli(["测试"], cwd, { ANTHROPIC_API_KEY: undefined });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    expect(result.stderr).not.toContain("at Command");
  });

  it("REPL 串行处理输入、更新 turns 并复用同一会话", async () => {
    const cwd = await temporaryDirectory();
    const result = await runCli(
      ["--provider", "deepseek"],
      cwd,
      {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://xycli.test/v1",
        XYCLI_E2E_MOCK_FETCH: "1",
      },
      "第一条消息\n/turns 2\n第二条消息\n/exit\n"
    );

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toContain("最大循环次数: 2");
    const sessionDirectory = path.join(cwd, ".xycli", "sessions", "json");
    const sessionFiles = (await fs.readdir(sessionDirectory)).filter((file) => file.endsWith(".json"));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(
      await fs.readFile(path.join(sessionDirectory, sessionFiles[0]), "utf-8")
    ) as { messages: Array<{ role: string }> };
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });
});
