// 封装对微信开发者工具命令行（CLI）的调用。
// 不直接执行 cli.bat：Windows 上 Node 裸 spawn .bat 会 EINVAL，
// 且经 cmd.exe 转发后引号易错。改为按 config.js 探测出的布局
// 直接调用底层运行时（旧版 node.exe / 新版 Electron-as-node），
// 与官方 cli.bat 行为等价且参数不经 shell。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getCliInvocation } from "./config.js";

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
  const invocation = getCliInvocation();
  // 参数逐项作为 argv 传给目标程序，不经 shell 解释；
  // 来自 agent 的参数值只会是 CLI 的一个普通选项值。
  const argv = invocation.baseArgs.concat(args);

  // stdin 走 ignore（EOF）：CLI 弹出 y/N 交互提问时
  // 会立即走默认分支退出并报错，而不是干等输入直到超时。
  const options = {
    cwd: invocation.dir,
    shell: false,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...invocation.extraEnv,
      // 官方 cli.bat 会把调用方 cwd 透传给 CLI（env.cwd），这里保持一致
      cwd: process.cwd(),
    },
  };

  try {
    const { stdout, stderr } = await execFileP(invocation.file, argv, options);
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

/**
 * 带"新版才支持的参数"地调用 CLI：先用全量参数执行；
 * 仅当失败输出点名了某个参数（旧版 CLI 不认识）时，去掉这些参数重试一次。
 * 两次都失败时以最后一次的真实报错为准，不做任何吞错。
 */
export async function runCliWithOptionalFlags(args, flags, options) {
  const first = await runCli(args.concat(flags), options);
  if (first.code === 0) return first;

  const output = `${first.stderr}\n${first.stdout}`;
  const blamed = flags.some((flag) => output.includes(flag));
  if (!blamed) return first; // 与参数无关的业务错误，原样返回

  return runCli(args, options);
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
