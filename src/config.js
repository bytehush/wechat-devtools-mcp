// 定位微信开发者工具的安装目录。
// 优先级：环境变量 WECHAT_DEVTOOLS_CLI > 常见安装路径探测。
// 注意：本项目的所有 CLI 调用都依赖这里的 node.exe + cli.js 组合，
// 不走 cli.bat —— 因为 Windows 上 Node 直接 spawn .bat 会报 EINVAL，
// 且 .bat 经过 cmd.exe 转发后参数引号容易出错。
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

const COMMON_DIRS = [
  "D:\\程序员工具包\\微信web开发者工具", // 本机实测安装位置
  "C:\\Program Files (x86)\\Tencent\\微信web开发者工具",
  "C:\\Program Files\\Tencent\\微信web开发者工具",
  "D:\\Program Files (x86)\\Tencent\\微信web开发者工具",
  "D:\\Program Files\\Tencent\\微信web开发者工具",
];

function isValidDevtoolsDir(dir) {
  return (
    existsSync(path.join(dir, "node.exe")) &&
    existsSync(path.join(dir, "cli.js"))
  );
}

let cachedDir = null;

/**
 * 允许本 MCP 操作的项目根目录白名单。
 * 环境变量 WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS：多个目录用分号分隔。
 * 未配置时默认只放行自带的测试项目——工具不该能碰任意目录。
 */
export function getAllowedRoots() {
  const raw = env.WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS?.trim();
  if (raw) {
    return raw
      .split(";")
      .map((item) => path.resolve(item.trim()))
      .filter((item) => item.length > 0);
  }
  return [path.resolve(THIS_DIR, "..", "fixtures", "demo-miniprogram")];
}

/** 校验项目路径在白名单内；白名单外的路径一律不碰（不探测存在性） */
function assertAllowedPath(projectPath) {
  const roots = getAllowedRoots();
  const allowed = roots.some((root) => {
    const rel = path.relative(root, projectPath);
    return rel === "" || !(rel.startsWith("..") || path.isAbsolute(rel));
  });
  if (!allowed) {
    throw new Error(
      `项目路径不在允许的目录白名单内：${projectPath}\n` +
        `当前白名单：\n${roots.map((r) => `- ${r}`).join("\n")}\n` +
        `如需操作其他项目，请设置环境变量 WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS` +
        `（多个目录用分号分隔）后重启 MCP server。`
    );
  }
}

/**
 * 校验参数里的项目路径：规范化后必须在白名单内、真实存在、且含
 * project.config.json。返回规范化后的绝对路径，调用方之后只使用该值。
 * 本项目所有针对外部路径的文件系统访问都集中在本模块。
 */
export function resolveProjectPath(rawPath) {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`projectPath 必须是绝对路径，收到：${rawPath}`);
  }
  const projectPath = path.resolve(rawPath);
  assertAllowedPath(projectPath);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`项目目录不存在：${projectPath}`);
  }
  if (!existsSync(path.join(projectPath, "project.config.json"))) {
    throw new Error(
      `${projectPath} 下没有 project.config.json，不是小程序项目根目录。` +
        `请传入包含该文件的目录。`
    );
  }
  return projectPath;
}

/** 检查文件是否已生成（供 preview 确认二维码落盘） */
export function fileExists(filePath) {
  return existsSync(filePath);
}

/** 返回开发者工具安装目录；找不到时抛出带指引的错误 */
export function getDevtoolsDir() {
  if (cachedDir) return cachedDir;

  const fromEnv = env.WECHAT_DEVTOOLS_CLI;
  if (fromEnv) {
    // 允许填安装目录本身，或目录下的 cli.js / cli.bat
    const base = path.basename(fromEnv);
    const dir = /\.(bat|js)$/i.test(base) ? path.dirname(fromEnv) : fromEnv;
    if (!isValidDevtoolsDir(dir)) {
      throw new Error(
        `环境变量 WECHAT_DEVTOOLS_CLI 指向的位置缺少 node.exe / cli.js：${fromEnv}`
      );
    }
    cachedDir = dir;
    return cachedDir;
  }

  for (const dir of COMMON_DIRS) {
    if (isValidDevtoolsDir(dir)) {
      cachedDir = dir;
      return cachedDir;
    }
  }

  throw new Error(
    "找不到微信开发者工具。请在环境变量 WECHAT_DEVTOOLS_CLI 中指定安装目录" +
      "（即包含 cli.js 的那个目录），或把安装路径加进 src/config.js 的 COMMON_DIRS。"
  );
}
