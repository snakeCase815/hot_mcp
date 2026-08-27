# hot_mcp

[English](./README.md) | [简体中文](./README-zh.md)

**hot_mcp** 是 DeepSeek Harness（DSH）的运行时 MCP 服务器管理插件：在 **运行时** 动态新增、激活、停用、删除、刷新 MCP 服务器——无需重启、不依赖 HMR。服务器激活后，其工具会以 `mcp__<serverName>__<tool>` 的形式注册进模型工具表；停用或删除后全部反注册。

几个值得先了解的设计取向：

- **新增默认未激活**：添加一个服务器只是保存配置——不 spawn 进程、不建立连接，直到你手动激活它。
- **只持久化配置**（单个 JSON 文件 `$DSH_HOME/hot_mcp.json`，零额外依赖）。激活状态只存在于进程内存中：每次重启后，所有服务器都恢复为未激活。
- **双控制面、同一套逻辑**：面向模型的 6 个工具（`mcp_server_*`）+ 面向人的 Web GUI 设置页「MCP 服务器」区块。
- 底层复用 `@deepseek-ai/dsh-mcp-client`，按服务器粒度动态挂载 / 销毁实例。

## 特性

- 运行时全生命周期管理：新增 / 激活 / 停用 / 删除 / 刷新——无需重启 dsh
- 双传输方式：`stdio`（command + args + env + cwd）与 `streamable-http`（url + headers）
- 模型工具与设置页 UI 两个入口，驱动同一套逻辑
- 配置持久化到单个 JSON 文件，原子写入（tmp + rename）
- 安全的失败语义：写失败回滚内存；启动读失败降级为空列表、不阻塞启动
- 主题感知 UI：直接使用 dsh 主题 token，自动跟随明 / 暗主题

## 环境要求

- 已安装 DSH 并使用 `web` profile（GUI 服务于 `http://127.0.0.1:3080`）
- `@deepseek-ai/dsh-mcp-client`——已声明为本包依赖；安装 hot_mcp 时会自动装进 profile 的 `node_modules`

## 安装

```powershell
dsh plugin --profile web add github:snakeCase815/hot_mcp   # 从 GitHub 安装（host 走 main，client 走 dsh.client）
dsh --profile web                                          # 启动；patch 自动应用
```

然后打开 <http://127.0.0.1:3080>，进入 **设置 → MCP 服务器**。

之后升级可重复执行同一条 `add` 命令，或 `dsh plugin --profile web update hot_mcp`。

## 使用

### Web UI

设置页会出现 **「MCP 服务器」** 区块：

- **服务器列表**——每行显示服务器名称、状态圆点（绿色 = 已激活）及行内操作：
  - **激活 / 停用**——连接并注册工具，或断开并反注册工具
  - **刷新**——仅激活行可见；断开后重新连接该服务器
  - **删除**——3 秒内点击两次确认；连同配置一并删除
- **添加服务器** 表单——选择传输方式（stdio / HTTP）后填写：
  - stdio：启动命令、参数、工作目录、环境变量（`KEY=value`，每行一项）
  - HTTP：服务器 URL、附加请求头（`Key=value`，每行一项）
- 新增的服务器默认显示为 **未激活**——激活后才会连接并注册工具。
- 标题栏显示 `n/m 已激活` 及 **刷新列表** 按钮。

### 模型工具

| 工具 | 作用 |
|---|---|
| `mcp_server_list` | 列出已配置的服务器及其状态（`active` / `inactive`） |
| `mcp_server_add` | 新增服务器——默认未激活，配置持久化到磁盘 |
| `mcp_server_activate` | 连接服务器并把其工具注册为 `mcp__<name>__<tool>` |
| `mcp_server_deactivate` | 断开连接并反注册其工具（配置保留） |
| `mcp_server_remove` | 若激活中先断开，再从内存与磁盘删除配置 |
| `mcp_server_refresh` | 重连一个已激活的服务器并重新注册其工具 |

`mcp_server_add` 参数：

| 参数 | 必填 | 适用 | 说明 |
|---|---|---|---|
| `serverName` | ✔ | 两者 | 唯一名称；工具以 `mcp__<serverName>__<tool>` 暴露 |
| `transport` | ✔ | 两者 | `"stdio"` 或 `"streamable-http"` |
| `command` | stdio | stdio | 要 spawn 的可执行文件 |
| `args` | – | stdio | 命令参数数组 |
| `env` | – | stdio | 附加环境变量 |
| `cwd` | – | stdio | 子进程工作目录 |
| `url` | http | streamable-http | MCP 服务器 URL |
| `headers` | – | streamable-http | 附加请求头 |

示例——先新增一个 stdio 服务器，再激活：

1. 调用 `mcp_server_add`，传 `serverName: "fs"`、`transport: "stdio"`、`command: "npx"`、`args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]` → 服务器以未激活状态添加，配置已保存。
2. 调用 `mcp_server_activate`，传 `serverName: "fs"` → 服务器建立连接，其工具以 `mcp__fs__*` 出现在工具表。
3. 调用 `mcp_server_deactivate` → 所有 `mcp__fs__*` 工具消失；配置保留，之后可再次激活。

### 生命周期语义

| 操作 | 效果 |
|---|---|
| 新增 | 校验、保存配置、写入内存——未激活、不连接 |
| 激活 | 挂载一个 `mcp-client` 实例并等待初始连接 + 工具发现；失败则回滚为未激活 |
| 停用 | 销毁实例——关闭连接、反注册全部工具；配置保留 |
| 删除 | 若激活中先销毁，再从内存与磁盘删除配置 |
| 刷新 | 销毁 + 重新挂载（仅对已激活服务器有效） |
| 重启 dsh | 所有已保存配置恢复为未激活 |

## 持久化

- **路径**：`$DSH_HOME/hot_mcp.json`（`DSH_HOME` 未设置时回退到 `~/.dsh/hot_mcp.json`）
- **格式**：

  ```json
  {
    "version": 1,
    "servers": {
      "fs": {
        "serverName": "fs",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      }
    }
  }
  ```

## 开源协议

[MIT](./LICENSE)