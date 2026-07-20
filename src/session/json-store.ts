// ============================================================================
// JSON 会话存储——M1 使用的本地文件持久化实现
// ============================================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { validate as validateUuid } from "uuid";
import type { Session, SessionStore } from "./types.js";

// ---------------------------------------------------------------------------
// 默认路径
// ---------------------------------------------------------------------------

const DEFAULT_SESSIONS_DIR = ".xycli/sessions/json";

// ---------------------------------------------------------------------------
// JSON 会话存储实现
// ---------------------------------------------------------------------------

export class JsonSessionStore implements SessionStore {
  private sessionsDir: string;

  constructor(cwd: string, sessionsDir?: string) {
    this.sessionsDir = path.resolve(cwd, sessionsDir ?? DEFAULT_SESSIONS_DIR);
  }

  // -----------------------------------------------------------------------
  // 创建会话
  // -----------------------------------------------------------------------

  async create(session: Session): Promise<void> {
    this.assertSessionId(session.id);
    await this.ensureDir();
    const filePath = this.sessionPath(session.id);

    const data = JSON.stringify(session, null, 2);
    await this.atomicWrite(filePath, data);
  }

  // -----------------------------------------------------------------------
  // 更新会话——原子覆盖已有文件
  // -----------------------------------------------------------------------

  async update(session: Session): Promise<void> {
    this.assertSessionId(session.id);
    await this.ensureDir();
    const filePath = this.sessionPath(session.id);

    session.updatedAt = new Date().toISOString();
    const data = JSON.stringify(session, null, 2);
    await this.atomicWrite(filePath, data);
  }

  // -----------------------------------------------------------------------
  // 按 ID 读取会话
  // -----------------------------------------------------------------------

  async get(sessionId: string): Promise<Session | null> {
    if (!validateUuid(sessionId)) return null;
    const filePath = this.sessionPath(sessionId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as Session;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // 列出最近更新的会话
  // -----------------------------------------------------------------------

  async list(limit = 50): Promise<Session[]> {
    try {
      await this.ensureDir();
      const entries = await fs.readdir(this.sessionsDir);

      const jsonFiles = entries
        .filter((e) => e.endsWith(".json"));

      const sessions: Session[] = [];
      for (const file of jsonFiles) {
        try {
          const data = await fs.readFile(
            path.join(this.sessionsDir, file),
            "utf-8"
          );
          sessions.push(JSON.parse(data) as Session);
        } catch {
          // 忽略损坏或无法读取的会话文件。
        }
      }

      // 按 updatedAt 降序排列，再截取指定数量。
      sessions.sort((a, b) => {
        const aTime = new Date(a.updatedAt).getTime();
        const bTime = new Date(b.updatedAt).getTime();
        return bTime - aTime;
      });

      return sessions.slice(0, limit);
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // 内部辅助方法
  // -----------------------------------------------------------------------

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private assertSessionId(sessionId: string): void {
    if (!validateUuid(sessionId)) {
      throw new Error(`非法会话 ID：${sessionId}`);
    }
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    // 唯一临时文件名可以避免同一会话并发写入时互相覆盖。
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, data, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // 临时文件可能尚未创建或已经完成重命名。
      }
      throw error;
    }
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }
}
