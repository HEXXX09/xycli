// ============================================================================
// PermissionGuard — agent-loop level permission enforcement (M1-T09)
// ============================================================================

import type { PermissionLevel } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
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
// Allow-list matrix — explicit, not numeric comparison
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
// PermissionGuard
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
  // Static helpers
  // -------------------------------------------------------------------------

  /** Normalize a raw value to a valid PermissionMode. Throws on invalid input. */
  static normalizeMode(mode: unknown): PermissionMode {
    if (typeof mode === "string" && VALID_MODES.has(mode)) {
      return mode as PermissionMode;
    }
    throw new ValidationError(
      `Invalid permission mode: ${JSON.stringify(mode)}. ` +
        `Valid modes: read-only, auto-safe, full-access.`
    );
  }

  /** Return the explicit list of allowed levels for a given mode. */
  static allowedLevelsFor(mode: PermissionMode): readonly PermissionLevel[] {
    return ALLOWED_LEVELS[mode];
  }

  /** Static check — returns true if the required level is allowed under the mode. */
  static check(requiredLevel: PermissionLevel, mode?: PermissionMode): boolean {
    const m = mode ?? "auto-safe";
    return (ALLOWED_LEVELS[m] as readonly string[]).includes(requiredLevel);
  }

  /** Static evaluate — returns a full decision object. */
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
        : `Permission denied: current mode "${m}" only allows ${allowedLevels.join(", ")}.`,
    };
  }

  /** Build a structured denied payload for session records and tool messages. */
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
        `Permission denied: tool "${toolName}" requires "${requiredLevel}" ` +
        `but current permission mode "${mode}" allows only: ${allowedList}.`,
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
  // Instance methods
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
        : `Permission denied: current mode "${this.#mode}" only allows ${allowedLevels.join(", ")}.`,
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
