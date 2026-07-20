// 为 npm 脚本定位 Cargo，兼容 rustup 默认目录、系统 PATH 和显式 CARGO 路径。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const executableName = process.platform === "win32" ? "cargo.exe" : "cargo";
const rustupCargo = join(homedir(), ".cargo", "bin", executableName);
const cargo = process.env.CARGO || (existsSync(rustupCargo) ? rustupCargo : executableName);

const result = spawnSync(cargo, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`无法启动 Cargo：${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
