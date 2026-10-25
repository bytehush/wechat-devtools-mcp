// 定位微信开发者工具的安装目录，并描述"如何调用它的 CLI"。
// 两种官方布局（2026-09 实测）：
//   旧版（≤2.01.x）：自带 node.exe + 根目录 cli.js，用 node.exe 执行 cli.js；
//   新版（≥2.02.x）：不再自带 node.exe，改用 Electron 主程序以
//     ELECTRON_RUN_AS_NODE=1 充当 Node 运行时，CLI 入口在
//     resources/app.asar.unpacked/js/common/cli/index.js。
// 新版的调用方式与官方 cli.bat 等价（引导脚本、参数形态一致），
// 但保持参数数组直达进程、不经 shell——沿用本项目一贯的调用纪律。
import { existsSync, readdirSync, statSync } from "node:fs";
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

const NEW_CLI_ENTRY = path.join(
  "resources",
  "app.asar.unpacked",
  "js",
  "common",
  "cli",
  "index.js"
);

// 官方 cli.bat 在安装目录挑 Electron 主程序的办法：>50MB 且不在排除名单的 .exe。
// 名单与阈值对照 cli.bat，主程序换名字也能自动找到。
const EXE_EXCLUDE = new Set([
  "node.exe",
  "node-18.exe",
  "wxfilewatcher.exe",
  "wxfilewatcher_x64.exe",
  "notification_helper.exe",
  "wechatdevtools.exe",
]);
const EXE_MIN_BYTES = 50 * 1024 * 1024;

// 官方 cli.bat 引导脚本的文件版随本项目分发（src/cli-bootstrap.cjs）：
// 以文件形式执行时 require/createRequire 都是标准用法，
// argv 重建逻辑与官方 `-e` 内联脚本逐字等价。
const BOOTSTRAP_FILE = path.join(THIS_DIR, "cli-bootstrap.cjs");

function findElectronExe(dir) {
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".exe") || EXE_EXCLUDE.has(lower)) continue;
    try {
      if (statSync(path.join(dir, name)).size > EXE_MIN_BYTES) return name;
    } catch {
      // 读不到大小的文件跳过
    }
  }
  return null;
}

/**
 * 探测安装目录属于哪种布局。
 * @returns {{ kind: "node"|"electron"|"broken", reason?: string,
 *             file: string, baseArgs: string[], extraEnv: Record<string,string> }}
 */
function probeLayout(dir) {
  const nodeExe = path.join(dir, "node.exe");
  const oldCli = path.join(dir, "cli.js");
  if (existsSync(nodeExe) && existsSync(oldCli)) {
    return {
      kind: "node",
      file: nodeExe,
      baseArgs: [oldCli],
      extraEnv: {},
    };
  }

  const newEntry = path.join(dir, NEW_CLI_ENTRY);
  if (existsSync(newEntry)) {
    const exe = findElectronExe(dir);
    if (exe) {
      return {
        kind: "electron",
        file: path.join(dir, exe),
        baseArgs: [BOOTSTRAP_FILE, newEntry],
        extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
    return { kind: "broken", reason: "目录里有新版 CLI 入口，但找不到 Electron 主程序 exe" };
  }

  return {
    kind: "broken",
    reason:
      "目录里既没有 node.exe + cli.js（旧布局），也没有 " +
      NEW_CLI_ENTRY +
      "（新布局）",
  };
}

function isValidDevtoolsDir(dir) {
  try {
    return probeLayout(dir).kind !== "broken";
  } catch {
    return false;
  }
}

let cachedDir = null;
let cachedInvocation = null;

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
        `环境变量 WECHAT_DEVTOOLS_CLI 指向的位置不像微信开发者工具目录：${fromEnv}`
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
      "（即包含 cli.bat 的那个目录），或把安装路径加进 src/config.js 的 COMMON_DIRS。"
  );
}

/**
 * 描述如何发起一次 CLI 调用：可执行文件 + 固定前缀参数 + 需要追加的环境变量。
 * @returns {{ dir: string, kind: "node"|"electron",
 *             file: string, baseArgs: string[], extraEnv: Record<string,string> }}
 */
export function getCliInvocation() {
  if (cachedInvocation) return cachedInvocation;
  const dir = getDevtoolsDir();
  const layout = probeLayout(dir);
  if (layout.kind === "broken") {
    throw new Error(`开发者工具安装目录不完整（${dir}）：${layout.reason}`);
  }
  cachedInvocation = { dir, ...layout };
  return cachedInvocation;
}

/**
 * 返回 IDE 主程序 exe 的绝对路径（用于让 Explorer 代启 IDE）。
 * electron 布局下 CLI 的宿主程序就是 IDE 主程序；旧版布局下另找 >50MB 的 exe。
 * 找不到时返回 null——调用方据此给出"请手动打开开发者工具"的指引。
 */
export function getIdeExePath() {
  const dir = getDevtoolsDir();
  const layout = probeLayout(dir);
  if (layout.kind === "electron") return layout.file;
  const exe = findElectronExe(dir);
  return exe ? path.join(dir, exe) : null;
}

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
