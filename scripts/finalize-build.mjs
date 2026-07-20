// 保证 npm bin 入口在类 Unix 系统中具有可执行权限。
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

await chmod(resolve("dist/cli.js"), 0o755);
