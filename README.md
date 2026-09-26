# wechat-devtools-mcp

让 AI agent（ZCode / Claude 等）通过 [MCP 协议](https://modelcontextprotocol.io) 直接操控**微信开发者工具**：
打开项目、查登录状态、生成预览二维码、上传代码，甚至**直接操控运行中的小程序**（读页面数据、
调用页面方法、截图、读控制台日志）——用自然语言驱动小程序开发。

```
AI agent ──stdio(MCP 协议)──> 本 MCP server ──命令行──> 微信开发者工具 CLI ──> IDE
                             └─自动化──────> miniprogram-automator（WebSocket）──┘
        命令行双布局自适应：旧版经自带 node.exe 执行 cli.js；
        新版（≥2.02，无 node.exe）经 Electron-as-node 运行官方 CLI 入口
```

## 前提条件

1. **Node.js ≥ 18**（本机 v24 已满足）
2. **微信开发者工具** 已安装，并且至少手动打开、扫码登录过一次
3. **服务端口已开启**：打开开发者工具 →「设置 → 安全设置」→ 打开「服务端口」
   （首次用命令行调用时工具也会弹窗询问，输入 y 确认即可）
4. 如果工具没装在常见路径，设置环境变量 `WECHAT_DEVTOOLS_CLI` 指向安装目录
   （即包含 `cli.js` 的目录，例如 `D:\程序员工具包\微信web开发者工具`）
5. **（重要）目录白名单**：MCP 只会操作白名单内的项目目录。通过环境变量
   `WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS` 配置，多个目录用分号 `;` 分隔；
   **未配置时默认只允许自带的测试项目**。这样即使 agent 被恶意内容诱导，也动不了白名单外的目录。

## 安装

```bash
npm install
```

## 接入 AI agent（MCP 客户端配置）

在 MCP 客户端的配置中加入（把路径换成你的实际路径）：

```json
{
  "mcpServers": {
    "wechat-devtools": {
      "command": "node",
      "args": ["D:\\A-Project-Search\\ZCode\\微信开发者工具MCP\\src\\index.js"],
      "env": {
        "WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS": "D:\\my-miniprogram-projects;D:\\works"
      }
    }
  }
}
```

## 提供给 agent 的工具

**基础操作（v0.1）**

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `open_project` | 在开发者工具中打开一个小程序项目 | `projectPath`（含 project.config.json 的目录绝对路径） |
| `check_login` | 查询开发者工具是否已登录微信 | 无 |
| `preview` | 编译并生成预览二维码，微信扫码真机体验 | `projectPath`，可选 `qrOutput`（默认存 `preview-qr.png`） |
| `upload` | 上传代码到公众平台「版本管理」（对外动作） | `projectPath`、`version`（x.y.z），可选 `desc` |

**自动化操控（v0.2，先 `automation_start` 建立会话）**

| 工具 | 作用 |
|---|---|
| `automation_start` / `automation_stop` | 建立/断开与运行中小程序的自动化会话 |
| `navigate` | 跳转到指定页面（reLaunch，路径以 / 开头） |
| `get_page_info` | 当前页面路径、页面栈、完整 data |
| `call_method` | 调用页面方法（WXML 事件绑定的处理函数），模拟点击等交互 |
| `wx_method` | 调用 wx.* API（如 getSystemInfoSync） |
| `screenshot` | 截图保存到项目目录内 |
| `console_logs` | 读取小程序控制台输出与未捕获异常（调试报错先看这里） |

典型调试循环：`automation_start` → `navigate` → `get_page_info` 看状态 →
`call_method` 触发交互 → `get_page_info` 验证变化 → `console_logs` 看有没有报错 →
`screenshot` 留档。

> **已知限制**：
> - 元素级 DOM 操作（按选择器查元素/点击/输入）依赖 automator 的 `Page.getElements`
>   等命令，实测在 IDE 2.01/2.02 + automator npm 0.12.1 组合下会挂死或报错（官方 npm
>   SDK 已三年未更新，与新版 IDE 存在协议代差）。因此页面读取与交互走
>   `get_page_info` / `call_method`（appservice 通道），实测可靠。
> - 另：未提供"在 AppService 执行任意 JS"的工具——那是教科书级的代码注入面，
>   结构化的 `call_method` / `wx_method` 已覆盖绝大多数调试需求。
>
> **自动化端口按项目路径哈希分配**（同一项目恒定，不同项目互不冲突），
> 可用 `WECHAT_DEVTOOLS_AUTOMATION_PORT` 强制指定。`open_project` 与
> `automation_start` 会带 `--enable-service-port` 启动参数（服务端口开关改配置
> 文件无效——渲染进程 localStorage 会覆盖——这是官方正确姿势；旧版 CLI 不认识
> 该参数时自动去掉重试）。

接入后就可以这样对话：

> “帮我把 D:\works\my-app 这个小程序在开发者工具里打开，看看登录了没，然后传一个 1.0.1 版本，描述写‘修复首页白屏’。”

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 报错提示“服务端口已关闭” | 开发者工具 →「设置 → 安全设置」→ 打开「服务端口」 |
| 报错提示未登录 | 打开开发者工具，微信扫码登录；或先调 `check_login` 确认 |
| 预览报 AppID 相关错误 | `touristappid`（游客模式）不能预览/上传，需在 `project.config.json` 填真实 AppID |
| CLI 命令超时 | 开发者工具卡死时重启它；若刚被强制结束过进程，服务端口设置可能回落为关闭，重新开启即可 |
| 报错"项目路径不在允许的目录白名单内" | 把项目所在目录加进 `WECHAT_DEVTOOLS_MCP_ALLOWED_ROOTS`（分号分隔多个），改完重启 MCP server / 重启对话 |
| 找不到工具安装目录 | 设 `WECHAT_DEVTOOLS_CLI` 环境变量，或把路径加进 `src/config.js` 的 `COMMON_DIRS` |

## 开发与测试

```bash
npm run check    # 语法检查（node --check 所有源码）
npm run smoke    # 冒烟测试：拉起 server，走完 MCP 握手 + 真实 CLI 全链路
```

- `fixtures/demo-miniprogram/` 是用于测试的 Hello World 小程序（官方游客 AppID，可打开但不可预览/上传）
- 反证关：把 `test/smoke.mjs` 里的 `EXPECTED_TOOLS` 改错一个名字，测试必须变红

## 当前边界（v0.2）

- 仅支持 Windows（其他平台需补充各自的安装路径探测）
- 预览/上传的**成功路径**需要真实 AppID 才能验证，当前仅验证了错误路径与前置检查
- 元素级 DOM 操作不可用（见上文已知限制），页面交互走 `call_method`
- v0.3 备选：真实 AppID 项目下验证 preview/upload 全链路；编译错误读取；npm 构建
