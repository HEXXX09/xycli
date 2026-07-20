// ============================================================================
// JSON 会话存储测试
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { JsonSessionStore } from "./json-store.js";
import type { Session } from "./types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    title: "Test Session",
    cwd: "/tmp/test",
    status: "running",
    currentState: "IDLE",
    plan: {},
    providerName: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    messages: [],
    toolCalls: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

describe("JsonSessionStore", () => {
  let store: JsonSessionStore;
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xycli-store-test-"));
    store = new JsonSessionStore(cwd);
  });

  it("creates and retrieves a session", async () => {
    const session = makeSession();
    await store.create(session);

    const loaded = await store.get(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.title).toBe("Test Session");
    expect(loaded?.status).toBe("running");
  });

  it("returns null for non-existent session", async () => {
    const loaded = await store.get("nonexistent-id");
    expect(loaded).toBeNull();
  });

  it("updates an existing session", async () => {
    const session = makeSession();
    await store.create(session);

    session.status = "completed";
    session.totalInputTokens = 500;
    await store.update(session);

    const loaded = await store.get(session.id);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.totalInputTokens).toBe(500);
  });

  it("lists sessions in reverse chronological order", async () => {
    const s1 = makeSession({ title: "Session 1" });
    const s2 = makeSession({
      title: "Session 2",
      updatedAt: new Date(Date.now() + 1000).toISOString(), // 明确晚于第一个会话。
    });

    await store.create(s1);
    await store.create(s2);

    const list = await store.list();
    expect(list.length).toBe(2);
    // 更新时间较晚的 s2 应排在首位。
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it("persists messages and tool calls", async () => {
    const session = makeSession({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          sequence: 0,
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hi! How can I help?",
          sequence: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      toolCalls: [
        {
          id: "tc-1",
          toolName: "file_read",
          input: { path: "test.txt" },
          output: { content: "file content" },
          error: null,
          status: "succeeded",
          durationMs: 100,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        },
      ],
    });

    await store.create(session);

    const loaded = await store.get(session.id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.toolCalls).toHaveLength(1);
    expect(loaded?.toolCalls[0].toolName).toBe("file_read");
  });

  it("uses atomic writes (no partial files)", async () => {
    const session = makeSession();
    await store.create(session);

    // 验证没有遗留临时文件。
    const dir = path.join(cwd, ".xycli", "sessions", "json");
    const files = await fs.readdir(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    // 全部会话文件都必须是有效 JSON。
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const f of jsonFiles) {
      const content = await fs.readFile(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.id).toBeDefined();
    }
  });

  it("list returns empty array when no sessions exist", async () => {
    const list = await store.list();
    expect(list).toEqual([]);
  });
});
