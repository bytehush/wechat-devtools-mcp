// 官方 cli.bat 引导脚本的文件版（新版开发者工具 ≥2.02.x 的 CLI 启动方式）。
// 官方以 `electron -e "<脚本>" "<CLI入口>" <参数>` 启动：脚本重建 process.argv
// 后加载 CLI 入口。这里改为文件形式由 Electron-as-node 直接执行，
// argv 重建逻辑与官方逐字等价；唯一写法差异是按变量加载入口时用
// createRequire（node:module 的标准 API，语义与官方 require(e) 一致）。
"use strict";
const { createRequire } = require("node:module");

const entry = process.argv[2];
const rest = process.argv.slice(3).filter((x) => x !== "--electron");
if (!entry) {
  console.error("cli-bootstrap: missing CLI entry path");
  process.exit(1);
}
if (!process.env.cwd) process.env.cwd = process.cwd();
process.argv = [
  process.execPath,
  "--ms-enable-electron-run-as-node",
  entry,
  "--electron",
].concat(rest);
createRequire(__filename)(entry);
