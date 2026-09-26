// 封装对微信开发者工具命令行（cli.js）的调用。
// 所有命令都通过安装目录自带的 node.exe 执行，避开 .bat 的引号/安全限制。
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { getDevtoolsDir } from "./config.js";

const execFileP = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;

/** CLI 输出可能是 UTF-8 也可能是 GBK，出现乱码符号时按 GBK 重解码 */
function decode(buf) {
  if (Buffer.isBuffer(buf)) {
    const text = buf.toString("utf8");
    if (!text.includes("\uFFFD")) return text;
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return text;
    }
  }
  return String(buf);
}

/**
 * 运行一条开发者工具 CLI 命令。
 * @param {string[]} args 例如 ["open", "--project", "D:/demo"]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runCli(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dir = getDevtoolsDir();
  const nodeExe = path.join(dir, "node.exe");
  const cliJs = path.join(dir, "cli.js");
  // 参数逐项作为 argv 传给目标程序，不经 shell 解释；
  // 来自 agent 的参数值只会是 CLI 的一个普通选项值。
  const argv = [cliJs].concat(args);

  // stdin 走 ignore（EOF）：CLI 弹出 y/N 交互提问（如首次开启服务端口）时
  // 会立即走默认分支退出并报错，而不是干等输入直到超时。
  const options = {
    cwd: dir,
    shell: false,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  };

  try {
    const { stdout, stderr } = await execFileP(nodeExe, argv, options);
    return { code: 0, stdout: decode(stdout).trim(), stderr: decode(stderr).trim() };
  } catch (error) {
    if (error.killed || error.signal === "SIGKILL") {
      throw new Error(
        `CLI 命令超时（${timeoutMs / 1000} 秒）：cli ${args.join(" ")}`
      );
    }
    // CLI 以非 0 退出码结束时 promisify 的 execFile 会走这里
    const code = typeof error.code === "number" ? error.code : -1;
    return {
      code,
      stdout: decode(error.stdout ?? "").trim(),
      stderr: decode(error.stderr ?? "").trim(),
    };
  }
}

const HINTS = [
  {
    pattern: /服务端口|安全设置|Enable IDE Service|service port disabled/i,
    hint: "请打开微信开发者工具，进入「设置 → 安全设置」，打开「服务端口」开关后重试。",
  },
  {
    pattern: /未登录|not\s*login|需要登录|请登录/i,
    hint: "微信开发者工具尚未登录：请打开开发者工具，用微信扫码登录后重试。",
  },
  {
    pattern: /touristappid|appsecret|无效.*appid|appid.*无效|AppID/i,
    hint: "AppID 相关问题：touristappid（游客模式）不支持预览/上传，请在 project.config.json 里填入真实的小程序 AppID。",
  },
  {
    pattern: /不存在|not\s*exist|找不到|no\s*such/i,
    hint: "请检查项目路径是否正确，且该目录包含 project.config.json。",
  },
];

/** 把 CLI 的报错翻译成"下一步该做什么"的提示 */
export function friendlyError(error) {
  const raw = String(error?.message ?? error);
  for (const { pattern, hint } of HINTS) {
    if (pattern.test(raw)) return `${hint}\n--- 原始报错 ---\n${raw}`;
  }
  return raw;
}
