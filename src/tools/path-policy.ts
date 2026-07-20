import * as fs from "node:fs/promises";
import * as path from "node:path";

/** 工作区路径校验失败。 */
export class WorkspacePathError extends Error {
  readonly code = "PATH_OUTSIDE_WORKSPACE";

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realWorkspaceRoot(cwd: string): Promise<string> {
  return fs.realpath(path.resolve(cwd));
}

function assertWithin(root: string, target: string, originalPath: string): void {
  if (!isWithin(root, target)) {
    throw new WorkspacePathError(`路径超出工作区，已拒绝访问: ${originalPath}`);
  }
}

/** 解析一个必须已经存在的工作区内路径，并阻止符号链接逃逸。 */
export async function resolveExistingWorkspacePath(
  inputPath: string,
  cwd: string
): Promise<string> {
  const root = await realWorkspaceRoot(cwd);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);
  const realTarget = await fs.realpath(candidate);
  assertWithin(root, realTarget, inputPath);
  return realTarget;
}

/** 解析一个可创建的工作区内路径，并检查最近的已存在父目录。 */
export async function resolveWritableWorkspacePath(
  inputPath: string,
  cwd: string
): Promise<string> {
  const root = await realWorkspaceRoot(cwd);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(root, inputPath);

  let existing = candidate;
  let realExisting = "";
  while (true) {
    try {
      realExisting = await fs.realpath(existing);
      assertWithin(root, realExisting, inputPath);
      break;
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  const suffix = path.relative(existing, candidate);
  const resolvedTarget = path.resolve(realExisting, suffix);
  assertWithin(root, resolvedTarget, inputPath);
  return resolvedTarget;
}

/** 解析并验证工具使用的工作目录。 */
export async function resolveWorkspaceDirectory(
  inputPath: string,
  cwd: string
): Promise<string> {
  const resolved = await resolveExistingWorkspacePath(inputPath, cwd);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new WorkspacePathError(`工作目录不是文件夹: ${inputPath}`);
  }
  return resolved;
}
