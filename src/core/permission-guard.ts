// ============================================================================
// PermissionGuard——Agent 循环层的权限强制检查（M1-T09）
// ============================================================================

import type { PermissionLevel } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type PermissionMode = "read-only" | "auto-safe" | "full-access";

export interface PermissionDecision {
  allowed: boolean;
  mode: PermissionMode;
  requiredLevel: PermissionLevel;
  allowedLevels: readonly PermissionLevel[];
  reason: string | null;
}

export interface PermissionDeniedPayload {
  code: "PERMISSION_DENIED";
  message: string;
  retryable: false;
  details: {
    toolName: string;
    requiredLevel: PermissionLevel;
    permissionMode: PermissionMode;
    allowedLevels: readonly PermissionLevel[];
  };
}

// ---------------------------------------------------------------------------
// 显式允许矩阵——不使用容易误放行的数值比较
// ---------------------------------------------------------------------------

const ALLOWED_LEVELS: Record<PermissionMode, readonly PermissionLevel[]> = {
  "read-only": ["read-only"],
  "auto-safe": ["read-only", "write-files", "run-safe-commands"],
  "full-access": [
    "read-only",
    "write-files",
    "run-safe-commands",
    "network",
    "full-access",
  ],
};

const VALID_MODES = new Set<string>(["read-only", "auto-safe", "full-access"]);

// ---------------------------------------------------------------------------
// 权限守卫
// ---------------------------------------------------------------------------

export class PermissionGuard {
  #mode: PermissionMode;

  constructor(mode?: PermissionMode) {
    this.#mode = mode ?? "auto-safe";
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  // -------------------------------------------------------------------------
  // 静态辅助方法
  // -------------------------------------------------------------------------

  /** 将外部输入归一化为有效权限模式，非法输入直接抛错。 */
  static normalizeMode(mode: unknown): PermissionMode {
    if (typeof mode === "string" && VALID_MODES.has(mode)) {
      return mode as PermissionMode;
    }
    throw new ValidationError(
      `非法权限模式：${JSON.stringify(mode)}。` +
        `可选值：read-only、auto-safe、full-access。`
    );
  }

  /** 返回指定模式显式允许的权限级别。 */
  static allowedLevelsFor(mode: PermissionMode): readonly PermissionLevel[] {
    return ALLOWED_LEVELS[mode];
  }

  /** 判断指定模式是否允许目标权限级别。 */
  static check(requiredLevel: PermissionLevel, mode?: PermissionMode): boolean {
    const m = mode ?? "auto-safe";
    return (ALLOWED_LEVELS[m] as readonly string[]).includes(requiredLevel);
  }

  /** 返回包含原因和允许列表的完整权限决策。 */
  static evaluate(
    requiredLevel: PermissionLevel,
    mode?: PermissionMode
  ): PermissionDecision {
    const m = mode ?? "auto-safe";
    const allowedLevels = ALLOWED_LEVELS[m];
    const allowed = (allowedLevels as readonly string[]).includes(requiredLevel);

    return {
      allowed,
      mode: m,
      requiredLevel,
      allowedLevels,
      reason: allowed
        ? null
        : `权限不足：当前模式“${m}”只允许 ${allowedLevels.join("、")}。`,
    };
  }

  /** 构造供会话审计与工具消息共用的结构化拒绝信息。 */
  static deniedPayload(params: {
    toolName: string;
    requiredLevel: PermissionLevel;
    mode: PermissionMode;
  }): PermissionDeniedPayload {
    const { toolName, requiredLevel, mode } = params;
    const allowedLevels = ALLOWED_LEVELS[mode];
    const allowedList = allowedLevels.join(", ");

    return {
      code: "PERMISSION_DENIED",
      message:
        `权限不足：工具“${toolName}”需要“${requiredLevel}”，` +
        `当前模式“${mode}”只允许：${allowedList}。`,
      retryable: false,
      details: {
        toolName,
        requiredLevel,
        permissionMode: mode,
        allowedLevels,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 实例方法
  // -------------------------------------------------------------------------

  check(requiredLevel: PermissionLevel): boolean {
    return (ALLOWED_LEVELS[this.#mode] as readonly string[]).includes(requiredLevel);
  }

  evaluate(requiredLevel: PermissionLevel): PermissionDecision {
    const allowedLevels = ALLOWED_LEVELS[this.#mode];
    const allowed = (allowedLevels as readonly string[]).includes(requiredLevel);

    return {
      allowed,
      mode: this.#mode,
      requiredLevel,
      allowedLevels,
      reason: allowed
        ? null
        : `权限不足：当前模式“${this.#mode}”只允许 ${allowedLevels.join("、")}。`,
    };
  }

  deniedPayload(params: {
    toolName: string;
    requiredLevel: PermissionLevel;
  }): PermissionDeniedPayload {
    return PermissionGuard.deniedPayload({
      ...params,
      mode: this.#mode,
    });
  }
}
