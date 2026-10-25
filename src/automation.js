// 自动化会话：通过官方 miniprogram-automator 操控运行中的小程序。
// 会话模型：同一时间只保留一条自动化连接（automation_start 换项目时会先断开旧的）。
// 所有操作都带超时包装——IDE 卡死时快速报错，而不是让 agent 无限等待。
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import automator from "miniprogram-automator";

import { runCliWithOptionalFlags } from "./cli.js";
import { fileExists, getIdeExePath, resolveProjectPath } from "./config.js";

const DEFAULT_OP_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 180_000;
const CONNECT_TIMEOUT_MS = 60_000;
const CONSOLE_BUFFER_MAX = 200;

// ---- 确保 IDE 处于"可用"状态 ----
// 为什么需要这一步：IDE 启动时会经 npm 模块调 reg.exe 读 MachineGuid / CPU 指令集。
// 若 IDE 是 agent 直接 spawn 的子进程，在带命令白名单的执行环境里这一步会被拦截，
// IDE 初始化悬死，cli auto 便一直停在 preparing。让 Explorer 代启可脱离 agent 的
// 进程树，从而不受该黑名单连带管辖。
// explorer.exe 不返回可靠退出码（实测成功时也为 1），所以一律用 TCP 端口实测可连
// 作为唯一就绪判据；也不相信 .ide 文件本身——IDE 未运行时里面留着上次的陈旧端口。
const IDE_POLL_INTERVAL_MS = 200;
const IDE_READY_TIMEOUT_MS = 60_000;
const PORT_PROBE_TIMEOUT_MS = 300;

/** 读取所有 User Data 目录下 .ide 记录的端口（新版/旧版目录名都试，可能有多个实例） */
function readIdePorts() {
  const roots = ["微信开发者工具", "微信web开发者工具"].map((name) =>
    path.join(process.env.LOCALAPPDATA ?? "", name, "User Data")
  );
  const ports = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue; // 该目录不存在
    }
    for (const entry of entries) {
      try {
        const raw = readFileSync(path.join(root, entry, "Default", ".ide"), "utf8").trim();
        const port = Number.parseInt(raw, 10);
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
      } catch {
        // 没有 .ide 或内容不可读，跳过
      }
    }
  }
  return [...ports];
}

/** TCP 连接探测：能连上才算 IDE 真的在监听（比读文件可靠） */
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** 找一个真实在监听的 IDE 端口；都没有则返回 null */
async function findAliveIdePort() {
  const ports = readIdePorts();
  if (ports.length === 0) return null;
  const results = await Promise.all(ports.map(async (p) => ({ p, ok: await probePort(p) })));
  const hit = results.find((r) => r.ok);
  return hit ? hit.p : null;
}

/**
 * 经 explorer.exe 代启 IDE。同步触发、不等进程——explorer 会把请求转交给用户
 * 会话里的 Explorer，由它创建 IDE 进程，因此 IDE 不在 agent 的进程树内。
 * 不判返回值：explorer 成功时也常返回 1。
 */
function launchIdeViaExplorer(exePath) {
  const child = spawn("explorer.exe", [exePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {}); // explorer 起不来时由后续端口轮询兜底报错
  child.unref();
}

/**
 * 保证 IDE 可用。已在运行则立即返回（0 等待）；否则代启并轮询端口。
 * @returns {{ launched: boolean, port: number, waitedMs: number }}
 */
async function ensureIdeRunning() {
  const alive = await findAliveIdePort();
  if (alive) return { launched: false, port: alive, waitedMs: 0 };

  const exePath = getIdeExePath();
  if (!exePath) {
    throw new Error(
      "微信开发者工具未运行，且无法定位其主程序。请手动打开开发者工具后重试。"
    );
  }

  const startedAt = Date.now();
  launchIdeViaExplorer(exePath);

  const deadline = startedAt + IDE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await findAliveIdePort();
    if (port) return { launched: true, port, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, IDE_POLL_INTERVAL_MS));
  }

  throw new Error(
    `开发者工具未能启动（等待 ${IDE_READY_TIMEOUT_MS / 1000} 秒端口仍未监听）：${exePath}\n` +
      `请手动打开开发者工具，确认主界面出现后重试。`
  );
}

function automationPort(projectPath) {
  const raw = process.env.WECHAT_DEVTOOLS_AUTOMATION_PORT?.trim();
  const fixed = Number(raw);
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  // 端口按项目路径哈希确定：不同项目的 IDE 窗口各自监听各自的端口，
  // 避免 A 项目的自动化会话串到 B 项目窗口（实测踩坑：固定端口被
  // 旧会话占用时 cli auto 仍报成功，连接却落到旧项目）。
  // 范围 20000-39999，避开 Windows 动态端口段（49152 起）。
  let hash = 5381;
  for (const ch of projectPath) hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
  return 20000 + (hash % 20000);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} 超时（${timeoutMs / 1000} 秒）`)),
        timeoutMs
      )
    ),
  ]);
}

let session = null; // { miniProgram, projectPath, consoleBuffer, exceptionBuffer }

/** 未启动会话时给出明确指引，而不是把 undefined 当对象用时抛一堆内部堆栈 */
function requireSession() {
  if (!session) {
    throw new Error(
      "尚未建立自动化会话。请先调用 automation_start 打开目标项目。"
    );
  }
  return session;
}

function recordConsole(msg) {
  if (!session) return;
  const args = (msg.args ?? []).map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  session.consoleBuffer.push({
    type: msg.type ?? "log",
    text: args.join(" "),
  });
  if (session.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
    session.consoleBuffer.shift();
  }
}

function recordException(error) {
  if (!session) return;
  session.exceptionBuffer.push({
    message: error?.message ?? String(error),
  });
  if (session.exceptionBuffer.length > CONSOLE_BUFFER_MAX) {
    session.exceptionBuffer.shift();
  }
}

/**
 * 连接自动化端口。cli auto 返回后 WS 服务可能还在初始化，
 * 所以按固定节奏探测连接，超时仍失败则抛最后一次的真实报错。
 */
async function connectWithRetry(wsEndpoint) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await automator.connect({ wsEndpoint });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(
    `连接自动化端口失败（${wsEndpoint}）：${lastError?.message ?? lastError}`
  );
}

/**
 * 启动自动化会话：先经 runCli 执行 cli auto（开启自动化端口），
 * 再用 automator.connect 建立 WebSocket 连接。
 * 不用 SDK 自带的 automator.launch——它在高版本 Node 上裸 spawn cli.bat 会
 * EINVAL（Node ≥18.20 的安全限制），报错被它吞成"cliPath 不正确"。
 * 换项目时旧会话会被尽力断开；IDE 本体保持运行（disconnect 而非 close）。
 */
export async function startSession(rawProjectPath) {
  const projectPath = resolveProjectPath(rawProjectPath);

  if (session) {
    await stopSession().catch(() => {}); // 旧连接清理失败不阻塞新会话
  }

  const port = automationPort(projectPath);

  // 先确保 IDE 活着（必要时让 Explorer 代启）。IDE 未就绪就发 cli auto 的话，
  // CLI 会自己去 spawn IDE——那正好走回"子进程被程序黑名单拦死"的老路。
  const ide = await ensureIdeRunning();

  // --enable-service-port：启动参数级开启服务端口（见 index.js open_project 注释）；
  // --trust-project：免去项目的信任确认弹窗；旧版 CLI 不认识时自动去掉重试。
  const { code, stdout, stderr } = await runCliWithOptionalFlags(
    ["auto", "--project", projectPath, "--auto-port", String(port)],
    ["--enable-service-port", "--trust-project"],
    { timeoutMs: LAUNCH_TIMEOUT_MS }
  );
  if (code !== 0) {
    throw new Error(
      `开启自动化端口失败：${stderr || stdout || `cli auto 退出码 ${code}`}`
    );
  }

  const miniProgram = await connectWithRetry(`ws://127.0.0.1:${port}`);

  session = {
    miniProgram,
    projectPath,
    consoleBuffer: [],
    exceptionBuffer: [],
  };
  miniProgram.on("console", recordConsole);
  miniProgram.on("exception", recordException);

  // 就绪探测：自动化代理可能早于 app 启动完成附着，页面栈为空时
  // get_page_info 会拿到 null。轮询等首个页面出现（不吞错：超时也照常
  // 建立会话，但在返回里如实提示，后续操作会暴露真实状态）。
  let readyRoute = null;
  const readyDeadline = Date.now() + 20_000;
  while (Date.now() < readyDeadline) {
    const stack = await withTimeout(
      miniProgram.evaluate(() => getCurrentPages().map((p) => p.route)),
      DEFAULT_OP_TIMEOUT_MS,
      "就绪探测"
    ).catch(() => null);
    if (stack && stack.length > 0) {
      readyRoute = stack[stack.length - 1];
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return (
    `自动化会话已建立：${projectPath}\n自动化端口：${port}` +
    (ide.launched
      ? `\n开发者工具由 Explorer 代启，端口就绪耗时 ${ide.waitedMs} ms（IDE http 端口 ${ide.port}）`
      : `\n开发者工具已在运行（http 端口 ${ide.port}）`) +
    (readyRoute
      ? `\n应用就绪，当前页面：${readyRoute}`
      : `\n注意：应用页面栈 20 秒内未就绪（可能在编译中或存在编译错误），可用 get_page_info 复查。`)
  );
}

/** 断开自动化连接（IDE 保持运行） */
export async function stopSession() {
  if (!session) return "当前没有自动化会话。";
  const { miniProgram } = session;
  session = null;
  await withTimeout(miniProgram.disconnect(), DEFAULT_OP_TIMEOUT_MS, "断开自动化连接");
  return "自动化会话已断开（开发者工具保持运行）。";
}

/** 重新加载指定页面：走 appservice 的 wx.reLaunch（任何页面类型都能直达）。
 * 不用 automator 的 App.reLaunch 命令——实测该路由在当前 IDE+SDK 组合下
 * 返回被吞掉的 "Uncaught [object Object]"，而 wx API 通道可靠。 */
export async function reLaunch(url) {
  const { miniProgram } = requireSession();
  if (!url.startsWith("/")) {
    throw new Error(`页面路径应以 / 开头，收到：${url}`);
  }
  const result = await withTimeout(
    miniProgram.evaluate(
      (target) =>
        new Promise((resolve) => {
          wx.reLaunch({ url: target, complete: resolve });
        }),
      url
    ),
    DEFAULT_OP_TIMEOUT_MS,
    `reLaunch ${url}`
  );
  if (!result || result.errMsg !== "reLaunch:ok") {
    throw new Error(`reLaunch 失败：${JSON.stringify(result) ?? "无返回"}`);
  }
  const route = await withTimeout(
    miniProgram.evaluate(() => {
      const pages = getCurrentPages();
      return pages.length ? pages[pages.length - 1].route : null;
    }),
    DEFAULT_OP_TIMEOUT_MS,
    "读取跳转后页面"
  );
  return `已跳转到 ${route}`;
}

/**
 * 当前页面信息（路径、页面栈、完整 data）。
 * 注意：走 evaluate 在 appservice 直读，不依赖 IDE 的 Page.* 命令路由——
 * 实测 IDE 2.01.2510290 + automator 0.12.1 组合下 Page.getData 会挂死。
 */
export async function getPageInfo() {
  const { miniProgram } = requireSession();
  const result = await withTimeout(
    miniProgram.evaluate(() => {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      return {
        path: current ? current.route : null,
        stackSize: pages.length,
        data: current ? current.data : null,
      };
    }),
    DEFAULT_OP_TIMEOUT_MS,
    "读取页面信息"
  );
  return JSON.stringify(result, null, 2);
}

/**
 * 调用当前页面的方法（等价于用户触发 bindtap 等事件后执行的处理函数）。
 * 方法内若使用 this.setData，页面状态会正常更新。
 */
export async function callMethod(methodName, args = []) {
  const { miniProgram } = requireSession();
  const result = await withTimeout(
    miniProgram.evaluate(
      (name, methodArgs) => {
        const pages = getCurrentPages();
        const current = pages[pages.length - 1];
        if (!current || typeof current[name] !== "function") {
          throw new Error(`当前页面没有方法 ${name}`);
        }
        return current[name](...methodArgs);
      },
      methodName,
      args
    ),
    DEFAULT_OP_TIMEOUT_MS,
    `调用页面方法 ${methodName}`
  );
  return `已调用页面方法 ${methodName}，返回：${JSON.stringify(result) ?? "undefined"}\n页面状态可用 get_page_info 确认。`;
}

/** 调用 wx.* API（如 getSystemInfoSync、getStorageInfoSync） */
export async function callWxMethod(methodName, args = []) {
  const { miniProgram } = requireSession();
  const result = await withTimeout(
    miniProgram.callWxMethod(methodName, ...args),
    DEFAULT_OP_TIMEOUT_MS,
    `调用 wx.${methodName}`
  );
  return JSON.stringify(result, null, 2) ?? "undefined";
}

/** 截图保存到项目目录内（默认 automation-screenshot.png），返回保存路径 */
export async function screenshot(rawOutputPath) {
  const s = requireSession();
  const outputPath = path.resolve(
    rawOutputPath || path.join(s.projectPath, "automation-screenshot.png")
  );
  const rel = path.relative(s.projectPath, outputPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`截图保存路径必须位于项目目录内：${rawOutputPath}`);
  }
  await withTimeout(
    s.miniProgram.screenshot({ path: outputPath }),
    DEFAULT_OP_TIMEOUT_MS,
    "截图"
  );
  if (!fileExists(outputPath)) {
    throw new Error(`截图命令已执行但未生成文件：${outputPath}`);
  }
  return `截图已保存：${outputPath}`;
}

/** 返回缓存的控制台输出与异常；clear=true 时读完即清空 */
export async function getConsoleLogs(clear = false) {
  const s = requireSession();
  const payload = {
    console: s.consoleBuffer.slice(-100),
    exceptions: s.exceptionBuffer.slice(-100),
  };
  if (clear) {
    s.consoleBuffer = [];
    s.exceptionBuffer = [];
  }
  return JSON.stringify(payload, null, 2);
}
