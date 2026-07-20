// ============================================================================
// PermissionGuard 测试
// ============================================================================

import { describe, it, expect } from "vitest";
import { PermissionGuard } from "./permission-guard.js";
import type { PermissionMode } from "./permission-guard.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// 测试辅助数据
// ---------------------------------------------------------------------------

const ALL_LEVELS = [
  "read-only",
  "write-files",
  "run-safe-commands",
  "network",
  "full-access",
] as const;

describe("PermissionGuard", () => {
  // -------------------------------------------------------------------------
  // 1. read-only 模式
  // -------------------------------------------------------------------------

  describe("read-only mode", () => {
    it("allows read-only", () => {
      expect(PermissionGuard.check("read-only", "read-only")).toBe(true);
    });

    it("rejects write-files (evaluate)", () => {
      const decision = PermissionGuard.evaluate("write-files", "read-only");
      expect(decision.allowed).toBe(false);
      expect(decision.allowedLevels).toEqual(["read-only"]);
      expect(decision.mode).toBe("read-only");
      expect(decision.reason).not.toBeNull();
      expect(decision.reason).toContain("read-only");
    });

    it("rejects run-safe-commands", () => {
      expect(PermissionGuard.check("run-safe-commands", "read-only")).toBe(false);
    });

    it("rejects network", () => {
      expect(PermissionGuard.check("network", "read-only")).toBe(false);
    });

    it("rejects full-access", () => {
      expect(PermissionGuard.check("full-access", "read-only")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. auto-safe 模式
  // -------------------------------------------------------------------------

  describe("auto-safe mode", () => {
    it("allows read-only", () => {
      expect(PermissionGuard.check("read-only", "auto-safe")).toBe(true);
    });

    it("allows write-files", () => {
      expect(PermissionGuard.check("write-files", "auto-safe")).toBe(true);
    });

    it("allows run-safe-commands", () => {
      expect(PermissionGuard.check("run-safe-commands", "auto-safe")).toBe(true);
    });

    it("rejects network", () => {
      const decision = PermissionGuard.evaluate("network", "auto-safe");
      expect(decision.allowed).toBe(false);
      expect(decision.allowedLevels).toEqual([
        "read-only",
        "write-files",
        "run-safe-commands",
      ]);
    });

    it("rejects full-access (check)", () => {
      expect(PermissionGuard.check("full-access", "auto-safe")).toBe(false);
    });

    it("deniedPayload returns correct structure for network", () => {
      const payload = PermissionGuard.deniedPayload({
        toolName: "fetch_url",
        requiredLevel: "network",
        mode: "auto-safe",
      });
      expect(payload.code).toBe("PERMISSION_DENIED");
      expect(payload.retryable).toBe(false);
      expect(payload.details.toolName).toBe("fetch_url");
      expect(payload.details.requiredLevel).toBe("network");
      expect(payload.details.permissionMode).toBe("auto-safe");
      expect(payload.details.allowedLevels).toEqual([
        "read-only",
        "write-files",
        "run-safe-commands",
      ]);
      expect(payload.message).toContain("fetch_url");
      expect(payload.message).toContain("network");
      expect(payload.message).toContain("auto-safe");
    });
  });

  // -------------------------------------------------------------------------
  // 3. full-access 模式
  // -------------------------------------------------------------------------

  describe("full-access mode", () => {
    it("allows all permission levels", () => {
      for (const level of ALL_LEVELS) {
        expect(PermissionGuard.check(level, "full-access")).toBe(true);
      }
    });

    it("evaluate returns allowed:true for all levels", () => {
      for (const level of ALL_LEVELS) {
        const decision = PermissionGuard.evaluate(level, "full-access");
        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. 默认模式
  // -------------------------------------------------------------------------

  describe("default mode", () => {
    it("defaults to auto-safe when no mode provided (static check)", () => {
      expect(PermissionGuard.check("read-only")).toBe(true);
      expect(PermissionGuard.check("write-files")).toBe(true);
      expect(PermissionGuard.check("network")).toBe(false);
      expect(PermissionGuard.check("full-access")).toBe(false);
    });

    it("new PermissionGuard() defaults to auto-safe", () => {
      const guard = new PermissionGuard();
      expect(guard.mode).toBe("auto-safe");
      expect(guard.check("write-files")).toBe(true);
      expect(guard.check("network")).toBe(false);
    });

    it("new PermissionGuard(undefined) defaults to auto-safe", () => {
      const guard = new PermissionGuard(undefined);
      expect(guard.mode).toBe("auto-safe");
    });
  });

  // -------------------------------------------------------------------------
  // 5. 非法模式
  // -------------------------------------------------------------------------

  describe("invalid mode", () => {
    it("normalizeMode throws for unknown value", () => {
      expect(() => PermissionGuard.normalizeMode("readonly")).toThrow(
        ValidationError
      );
    });

    it("normalizeMode throws for empty string", () => {
      expect(() => PermissionGuard.normalizeMode("")).toThrow(ValidationError);
    });

    it("normalizeMode throws for arbitrary string", () => {
      expect(() => PermissionGuard.normalizeMode("super-admin")).toThrow(
        ValidationError
      );
    });

    it("normalizeMode returns valid modes unchanged", () => {
      const modes: PermissionMode[] = ["read-only", "auto-safe", "full-access"];
      for (const mode of modes) {
        expect(PermissionGuard.normalizeMode(mode)).toBe(mode);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. 实例方法
  // -------------------------------------------------------------------------

  describe("instance methods", () => {
    it("instance check() uses constructor mode", () => {
      const guard = new PermissionGuard("read-only");
      expect(guard.check("read-only")).toBe(true);
      expect(guard.check("write-files")).toBe(false);
    });

    it("instance evaluate() returns mode from constructor", () => {
      const guard = new PermissionGuard("read-only");
      const decision = guard.evaluate("write-files");
      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe("read-only");
    });

    it("instance deniedPayload() uses constructor mode", () => {
      const guard = new PermissionGuard("read-only");
      const payload = guard.deniedPayload({
        toolName: "write_file",
        requiredLevel: "write-files",
      });
      expect(payload.details.permissionMode).toBe("read-only");
      expect(payload.code).toBe("PERMISSION_DENIED");
    });
  });

  // -------------------------------------------------------------------------
  // 7. allowedLevelsFor 映射
  // -------------------------------------------------------------------------

  describe("allowedLevelsFor", () => {
    it("returns correct lists for each mode", () => {
      expect(PermissionGuard.allowedLevelsFor("read-only")).toEqual([
        "read-only",
      ]);
      expect(PermissionGuard.allowedLevelsFor("auto-safe")).toEqual([
        "read-only",
        "write-files",
        "run-safe-commands",
      ]);
      expect(PermissionGuard.allowedLevelsFor("full-access")).toEqual(
        ALL_LEVELS
      );
    });
  });
});
