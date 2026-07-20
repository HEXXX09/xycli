// dist 只包含构建产物，可以在每次生产构建前安全重建。
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve("dist"), { recursive: true, force: true });
