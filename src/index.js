// 微信开发者工具 MCP server
// 基础工具（v0.1）：
//   open_project  —— 在开发者工具里打开一个小程序项目
//   check_login   —— 查询开发者工具的登录状态
//   preview       —— 生成预览二维码（手机扫码真机预览）
//   upload        —— 上传代码到微信后台（版本号必填，属于对外动作）
// 自动化工具（v0.2，基于官方 miniprogram-automator）：
//   automation_start / automation_stop / navigate / get_page_info /
//   call_method / wx_method / screenshot / console_logs
//   （元素级 DOM 操作与任意代码执行工具均不提供，见 docs 决策记录）
//
// 传输方式：stdio（由 ZCode / Claude 等 agent 以子进程方式拉起，无需监听端口）。
// 注意：本文件不做任何文件系统访问——外部路径的白名单校验与存在性检查
// 全部集中在 config.js（resolveProjectPath / fileExists）。
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as automation from "./automation.js";
import { friendlyError, runCli } from "./cli.js";
import { fileExists, resolveProjectPath } from "./config.js";

const SERVER_INFO = { name: "wechat-devtools-mcp", version: "0.2.0" };

/** 校验 filePath 落在 dirPath 目录内，防止工具被用来写项目目录之外的文件 */
function assertInsideDir(filePath, dirPath, label) {
  const relative = path.relative(path.resolve(dirPath), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于项目目录内，收到：${filePath}`);
  }
}

const TOOLS = [
  {
    name: "open_project",
    description:
      "在微信开发者工具中打开一个小程序项目（会拉起/复用开发者工具窗口）。" +
      "这是后续预览、上传、调试前的第一步。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "小程序项目根目录的绝对路径（包含 project.config.json 的目录）",
        },
      },
      required: ["projectPath"],
    },
    async run({ projectPath: rawPath }) {
      const projectPath = resolveProjectPath(rawPath);
      const { code, stdout, stderr } = await runCli([
        "open",
        "--project",
        projectPath,
      ]);
      if (code !== 0) {
        throw new Error(stderr || stdout || `cli open 退出码 ${code}`);
      }
      return `已在微信开发者工具中打开项目：${projectPath}`;
    },
  },
  {
    name: "check_login",
    description:
      "查询微信开发者工具当前是否已登录微信账号。预览和上传前建议先调用确认。",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      const { stdout, stderr } = await runCli(["islogin"]);
      const output = stdout || stderr;
      // CLI 实际输出形如 {"login":true} 或 {"login":false}
      const loggedIn = /"login"\s*:\s*true/.test(output);
      const loggedOut = /"login"\s*:\s*false/.test(output);
      const status = loggedIn ? "已登录" : loggedOut ? "未登录" : "状态未知";
      return `登录状态：${status}\nCLI 原始输出：${output}`;
    },
  },
  {
    name: "preview",
    description:
      "对小程序项目执行预览编译，并生成一张二维码图片。用微信扫码即可在手机上体验。" +
      "要求：开发者工具已登录，且项目使用真实 AppID（touristappid 不支持）。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "小程序项目根目录的绝对路径",
        },
        qrOutput: {
          type: "string",
          description:
            "二维码图片保存路径（.png），必须位于项目目录内。不填时默认保存为项目目录下的 preview-qr.png",
        },
      },
      required: ["projectPath"],
    },
    async run({ projectPath: rawPath, qrOutput }) {
      const projectPath = resolveProjectPath(rawPath);
      const qrPath = path.resolve(
        qrOutput || path.join(projectPath, "preview-qr.png")
      );
      assertInsideDir(qrPath, projectPath, "qrOutput");
      const { code, stdout, stderr } = await runCli(
        [
          "preview",
          "--project",
          projectPath,
          "--qr-format",
          "image",
          "--qr-output",
          qrPath,
        ],
        { timeoutMs: 180_000 } // 预览要完整编译，首次可能较慢
      );
      if (code !== 0) {
        throw new Error(stderr || stdout || `cli preview 退出码 ${code}`);
      }
      if (!fileExists(qrPath)) {
        throw new Error(`预览命令已执行但未生成二维码文件：${qrPath}\n${stdout}`);
      }
      return `预览成功！二维码已保存到：${qrPath}\n用微信扫码即可在手机上预览。\n${stdout}`;
    },
  },
  {
    name: "upload",
    description:
      "把小程序代码上传到微信公众平台（版本管理后台）。" +
      "这是对外动作：上传后可在 mp.weixin.qq.com 的「版本管理」里提交审核。" +
      "要求：已登录 + 真实 AppID。version 建议用 x.y.z 格式。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "小程序项目根目录的绝对路径",
        },
        version: {
          type: "string",
          description: "版本号，例如 1.0.0（会显示在公众平台版本管理里）",
        },
        desc: {
          type: "string",
          description: "版本描述，例如：修复首页白屏问题",
        },
      },
      required: ["projectPath", "version"],
    },
    async run({ projectPath: rawPath, version, desc }) {
      const projectPath = resolveProjectPath(rawPath);
      if (!/^\d+(\.\d+){1,2}$/.test(version)) {
        throw new Error(
          `版本号格式应为 x.y.z（如 1.0.0），收到：${version}`
        );
      }
      const { code, stdout, stderr } = await runCli(
        ["upload", "--project", projectPath, "-v", version, "-d", desc ?? ""],
        { timeoutMs: 180_000 }
      );
      if (code !== 0) {
        throw new Error(stderr || stdout || `cli upload 退出码 ${code}`);
      }
      return `上传成功！版本 ${version} 已进入微信公众平台「版本管理 → 开发版本」。\n${stdout}`;
    },
  },
  {
    name: "automation_start",
    description:
      "建立与小程序的自动化会话（开启开发者工具的自动化端口并连接）。" +
      "这是使用 navigate/get_page_info/tap_element 等自动化工具前的第一步。" +
      "同一时间只有一个会话；换项目时重新调用即可自动切换。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "小程序项目根目录的绝对路径",
        },
      },
      required: ["projectPath"],
    },
    async run({ projectPath }) {
      return automation.startSession(projectPath);
    },
  },
  {
    name: "automation_stop",
    description: "断开自动化会话（开发者工具保持运行，只是停止自动化控制）。",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      return automation.stopSession();
    },
  },
  {
    name: "navigate",
    description:
      "让小程序跳转到指定页面（reLaunch，会重置页面栈）。路径以 / 开头，" +
      "例如 /pages/index/index。跳转后可用 get_page_info 查看页面状态。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "页面路径，以 / 开头，如 /pages/index/index",
        },
      },
      required: ["url"],
    },
    async run({ url }) {
      return automation.reLaunch(url);
    },
  },
  {
    name: "get_page_info",
    description:
      "获取当前页面信息：页面路径、页面栈深度、完整的 data 数据。" +
      "判断 UI 状态、验证操作效果时用它。",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      return automation.getPageInfo();
    },
  },
  {
    name: "call_method",
    description:
      "调用当前页面的方法（即 WXML 里 bindtap/bindinput 等绑定的处理函数）。" +
      "这是模拟用户交互（如点按钮）的主要方式：先看 WXML 找到事件绑定的方法名再调用，" +
      "调用后用 get_page_info 验证状态变化。",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "页面方法名，例如 onTap、onSubmit",
        },
        args: {
          type: "string",
          description: "传给方法的参数列表（JSON 数组字符串），通常不需要",
        },
      },
      required: ["method"],
    },
    async run({ method, args }) {
      let parsed = [];
      if (args && args.trim()) {
        try {
          parsed = JSON.parse(args);
          if (!Array.isArray(parsed)) throw new Error("不是数组");
        } catch {
          throw new Error(`args 必须是 JSON 数组字符串，例如 ["a", 1]，收到：${args}`);
        }
      }
      return automation.callMethod(method, parsed);
    },
  },
  {
    name: "wx_method",
    description:
      "调用 wx.* API 并返回结果，例如 getSystemInfoSync、getStorageInfoSync。" +
      "args 是传给 API 的参数数组（JSON 数组字符串）。",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "wx API 方法名，不含 wx. 前缀",
        },
        args: {
          type: "string",
          description: "参数列表（JSON 数组字符串），通常不需要",
        },
      },
      required: ["method"],
    },
    async run({ method, args }) {
      let parsed = [];
      if (args && args.trim()) {
        try {
          parsed = JSON.parse(args);
          if (!Array.isArray(parsed)) throw new Error("不是数组");
        } catch {
          throw new Error(`args 必须是 JSON 数组字符串，收到：${args}`);
        }
      }
      return automation.callWxMethod(method, parsed);
    },
  },
  {
    name: "screenshot",
    description:
      "对当前小程序画面截图，保存到项目目录内（默认 automation-screenshot.png）。" +
      "可用 output 指定项目目录内的其他文件名。",
    inputSchema: {
      type: "object",
      properties: {
        output: {
          type: "string",
          description: "截图保存路径（.png），必须位于项目目录内",
        },
      },
      required: [],
    },
    async run({ output }) {
      return automation.screenshot(output);
    },
  },
  {
    name: "console_logs",
    description:
      "读取自会话建立以来小程序的控制台输出（console.*）与未捕获异常。" +
      "调试报错时先看这里。clear=true 表示读取后清空缓存。",
    inputSchema: {
      type: "object",
      properties: {
        clear: {
          type: "string",
          description: "传 true 表示读取后清空缓存",
        },
      },
      required: [],
    },
    async run({ clear }) {
      return automation.getConsoleLogs(clear === "true");
    },
  },
];

function toolErrorResult(text) {
  // MCP 约定：工具执行失败用 isError=true 的正常结果返回，
  // 让 agent 能读到错误内容，而不是协议层面的报错。
  return { content: [{ type: "text", text }], isError: true };
}

const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return toolErrorResult(
      `未知工具：${name}。可用工具：${TOOLS.map((t) => t.name).join(", ")}`
    );
  }

  try {
    const missing = (tool.inputSchema.required ?? []).filter(
      (key) => typeof args[key] !== "string" || args[key].trim() === ""
    );
    if (missing.length > 0) {
      return toolErrorResult(`缺少必填参数：${missing.join(", ")}`);
    }
    const text = await tool.run(args);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return toolErrorResult(friendlyError(error));
  }
});

// MCP 的 stdio 传输：协议消息走 stdout，任何日志只能写 stderr，
// 否则会污染协议通道导致 agent 解析失败。
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[wechat-devtools-mcp] ${SERVER_INFO.version} 已启动（stdio）\n`);
