// 冒烟测试：把 src/index.js 当作真实 MCP server 拉起，
// 用 JSON-RPC over stdio 模拟 agent 的完整调用路径。
// 用法：node test/smoke.mjs
// （open_project / check_login 属于真实运行：会拉起微信开发者工具，请保持工具可用）
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_PROJECT = path.join(ROOT, "fixtures", "demo-miniprogram");
const EXPECTED_TOOLS = [
  "open_project",
  "check_login",
  "preview",
  "upload",
  "automation_start",
  "automation_stop",
  "navigate",
  "get_page_info",
  "call_method",
  "wx_method",
  "screenshot",
  "console_logs",
];

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

// —— 极简 JSON-RPC 客户端 ——
const server = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  // 白名单显式给到 fixtures 目录：既放行测试项目，也覆盖"白名单内但目录不存在"的错误路径
  env: {
    ...process.env,
    WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS: path.dirname(DEMO_PROJECT),
  },
});

const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;
let buffer = "";

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }
});

server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

function request(method, params) {
  const id = nextId++;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(message + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }
    }, 240_000);
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function callTool(name, args = {}) {
  const result = await request("tools/call", { name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  return { result, text, isError: result.isError === true };
}

try {
  // 1. initialize 握手
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  console.log("\n[1] initialize 握手");
  check("返回正确的 serverInfo.name", init.serverInfo?.name === "wechat-devtools-mcp", JSON.stringify(init));
  check("声明了 tools 能力", init.capabilities?.tools != null);
  notify("notifications/initialized", {});

  // 2. tools/list
  const list = await request("tools/list", {});
  const names = (list.tools ?? []).map((t) => t.name).sort();
  console.log("\n[2] tools/list");
  check(
    `暴露 ${EXPECTED_TOOLS.length} 个工具且名字一致`,
    JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    `实际：${names.join(", ")}`
  );

  // 3a. 错误路径：白名单外的路径必须在探测存在性之前就被拒绝
  console.log("\n[3a] 错误路径（open_project 传入白名单外的目录）");
  const outside = await callTool("open_project", { projectPath: "D:/surely/not/exist" });
  check("返回 isError=true", outside.isError, outside.text);
  check("错误信息提到白名单", /白名单/.test(outside.text), outside.text);

  // 3b. 错误路径：白名单内但目录不存在
  console.log("\n[3b] 错误路径（白名单内不存在的目录）");
  const bad = await callTool("open_project", {
    projectPath: path.join(DEMO_PROJECT, "no-such-subdir"),
  });
  check("返回 isError=true", bad.isError, bad.text);
  check(
    "错误信息说明目录不存在或缺 project.config.json",
    /项目目录不存在|project\.config\.json/.test(bad.text),
    bad.text
  );

  // 4. 真实运行：check_login
  console.log("\n[4] 真实运行：check_login（调用开发者工具 CLI）");
  const login = await callTool("check_login");
  check("返回了工具结果", login.text.length > 0, "结果为空");
  console.log(`     状态：${login.text.split("\n")[0]}`);
  check("CLI 调用成功（无 isError）", !login.isError, login.text);

  // 5. 真实运行：open_project 打开测试小程序
  console.log("\n[5] 真实运行：open_project 打开测试小程序");
  const opened = await callTool("open_project", { projectPath: DEMO_PROJECT });
  check("返回成功", !opened.isError, opened.text);
  check("结果包含项目路径", opened.text.includes(DEMO_PROJECT), opened.text);

  // 6. 错误路径：preview 用 touristappid（游客 AppID 无法预览）
  console.log("\n[6] 错误路径：preview + touristappid 应给出 AppID 提示");
  const preview = await callTool("preview", { projectPath: DEMO_PROJECT });
  check("返回 isError=true（游客 AppID 被拒绝）", preview.isError, preview.text);
  check(
    "错误信息包含 AppID/登录 类提示",
    /AppID|登录/.test(preview.text),
    preview.text
  );

  // 7. 安全路径：qrOutput 越出项目目录必须被拒绝（任意位置写文件）
  console.log("\n[7] 安全路径：qrOutput 写到项目目录外应被拒绝");
  const qrOutside = await callTool("preview", {
    projectPath: DEMO_PROJECT,
    qrOutput: "C:\\Windows\\Temp\\evil-qr.png",
  });
  check("返回 isError=true", qrOutside.isError, qrOutside.text);
  check("错误信息说明必须在项目目录内", /项目目录内/.test(qrOutside.text), qrOutside.text);

  // 8. 未建会话时自动化工具必须给出可读指引
  console.log("\n[8] 错误路径：未启动会话就调 navigate");
  const noSession = await callTool("navigate", { url: "/pages/index/index" });
  check("返回 isError=true", noSession.isError, noSession.text);
  check("错误信息指引先调 automation_start", /automation_start/.test(noSession.text), noSession.text);

  // 9. 自动化全链路：启动会话 → 导航 → 取数据 → 点击 → 截图 → 控制台 → 断开
  console.log("\n[9] 自动化：automation_start 并导航到测试页面");
  const started = await callTool("automation_start", { projectPath: DEMO_PROJECT });
  check("automation_start 成功", !started.isError, started.text);

  const nav = await callTool("navigate", { url: "/pages/index/index" });
  check("navigate 成功", !nav.isError, nav.text);

  const info = await callTool("get_page_info", {});
  check(
    "页面 data 包含欢迎语",
    /Hello, wechat-devtools-mcp!/.test(info.text),
    info.text
  );

  console.log("\n[10] 自动化：call_method 模拟点击 + 状态验证");
  const tap = await callTool("call_method", { method: "onTap" });
  check("call_method 成功", !tap.isError, tap.text);

  const infoAfterTap = await callTool("get_page_info", {});
  check(
    "调用 onTap 后 tapCount 变为 1",
    /"tapCount"\s*:\s*1/.test(infoAfterTap.text),
    infoAfterTap.text
  );

  console.log("\n[11] 自动化：evaluate / wx_method / screenshot / console_logs");
  const sysInfo = await callTool("wx_method", { method: "getSystemInfoSync" });
  check(
    "wx_method 返回平台信息",
    !sysInfo.isError && /devtools|platform/i.test(sysInfo.text),
    sysInfo.text
  );

  const shot = await callTool("screenshot", {});
  check(
    "截图成功且落在项目目录",
    !shot.isError && /automation-screenshot\.png/.test(shot.text),
    shot.text
  );

  const logs = await callTool("console_logs", { clear: "true" });
  check(
    "控制台捕获到页面加载日志",
    /demo page loaded/.test(logs.text),
    logs.text
  );

  console.log("\n[12] 自动化：automation_stop 断开会话");
  const stopped = await callTool("automation_stop", {});
  check("automation_stop 成功", !stopped.isError, stopped.text);
} finally {
  server.kill();
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
