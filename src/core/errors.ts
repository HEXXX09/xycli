// ============================================================================
// 错误类型——对应 DESIGN.md 第 12 节定义的退出码
// ============================================================================

export abstract class XycliError extends Error {
  abstract code: string;
  abstract exitCode: 1 | 2 | 3 | 4 | 5;
  abstract retryable: boolean;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class UserError extends XycliError {
  code = "USER_ERROR";
  exitCode = 1 as const;
  retryable = false;
}

export class ValidationError extends XycliError {
  code = "VALIDATION_ERROR";
  exitCode = 2 as const;
  retryable = false;
}

export class PermissionError extends XycliError {
  code = "PERMISSION_DENIED";
  exitCode = 3 as const;
  retryable = false;
}

export class ProviderError extends XycliError {
  code = "PROVIDER_ERROR";
  exitCode = 4 as const;
  retryable: boolean;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
    this.retryable = typeof details.retryable === "boolean" ? details.retryable : true;
  }
}

export class ToolError extends XycliError {
  code = "TOOL_ERROR";
  exitCode = 5 as const;
  retryable = false;
}

export class ConfigError extends ValidationError {
  code = "CONFIG_ERROR";
}
