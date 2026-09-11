# hot_mcp —— 运行时 MCP 管理器（单插件，host + client 双端）

> 本文件是 hot_mcp 的**维护文档**。
> 文中 `<仓库路径>` 指本仓库在你自己机器上的绝对路径（例如 `D:/.../hot_mcp`）。

## 1. 项目是什么

复用 `@deepseek-ai/dsh-mcp-client`，在 **运行时** 动态新增/激活/停用/删除/刷新 MCP 服务器，把服务器提供的工具注册/反注册进工具表。**新增的服务器默认「未激活」**——只保存配置、不连接，需手动激活后才连接并注册工具。**不依赖 HMR**。**持久化：只持久化服务器配置，不持久化激活状态**——配置写入 `$DSH_HOME/hot_mcp.json`（JSON，零额外依赖），每次启动默认全部未激活（见 §9）。

**当前状态（已端到端验证）**：

- host 端：`mcp_server_list / add / activate / deactivate / remove / refresh` 6 个模型工具可用。
- client 端：设置页「MCP 服务器」区块支持新增（默认未激活）、激活/停用、刷新、删除；激活后工具以 `mcp__<serverName>__<tool>` 出现在工具表，停用/删除后全部消失。
- `/api/hot-mcp` 精确 Fetch 路由（`connection.fetch.register`）：继承框架的 Host/Origin 栅栏 + 浏览器会话认证，返回标准 JSON 信封。

## 2. 架构：单插件双端

`hot_mcp` 是**一个包、一个 insert、一套 plugin**（host 端 + client 端，不再拆 `hot_mcp_ui`）：

```
┌── 浏览器 (client 端) ──────────────────────────────┐
│  设置页 settings.section 列表                      │
│    └─ hot_mcp 区块「MCP 服务器」(ui/client.js)      │
│         └─ fetch POST /api/hot-mcp (JSON 信封)   │
└───────────────┬───────────────────────────────────┘
                │  HTTP（仅 JSON 跨域）
┌───────────────┴───────────────────────────────────┐
│  Node (host 端, lib/index.js)                     │
│    ├─ inject: ['tools', 'connection']             │
│    ├─ 6 个模型工具 + /api/hot-mcp 路由            │
│    ├─ Map<serverName, {config, fiber?}> ← 仅内存     │
│    └─ ctx.plugin(mcp-client, config) / dispose    │
│         └─ @deepseek-ai/dsh-mcp-client             │
│              ├─ ctx.tools.register(每个 MCP 工具)   │
│              └─ dispose → 断开 + 反注册所有工具      │
└──────────────────────────────────────────────────┘
```

- **host 端** = 包入口 `main: lib/index.js`：6 个模型工具（list/add/activate/deactivate/remove/refresh）+ `/api/hot-mcp` connection Fetch 路由 + 动态挂载/销毁 mcp-client。
- **client 端** = 同一包的 `dsh.client` + `exports["./client"]` → `ui/client.js`：client-modules 按 entry name（`hot_mcp`）解析该包 package.json，把 `ui/client.js` 作为浏览器 bundle 服务到设置页 `settings.section` 的「MCP 服务器」区块。
- 所以 patch 只需**一个 insert**（`name: hot_mcp`），同时满足 host 模块加载与 client bundle 发现。

## 3. 文件清单

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 端（包 `main`）：6 工具 + `/api/hot-mcp` Fetch 路由 + 动态挂载 |
| `ui/client.js` | client 端（浏览器 bundle）：设置页「MCP 服务器」区块，走 dsh 主题 token 样式 |
| `ui/index.js` | 遗留 noop（旧独立 UI 包方案的残留，无运行时作用，可删；`files` 里仍列着） |
| `mcp.patch.yml` | 一个 insert：`{ id: hot_mcp, name: 'hot_mcp' }` |
| `package.json` | 包元数据：`exports`（`.` / `./client` / `./package.json`）+ `dsh.client` + `dsh.bundle.patch` |

## 4. 组成 / 安装 / 启动

`web` profile 组成（`~/.dsh/profiles/web/package.json`）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "hot_mcp"] } },
"dependencies": { "hot_mcp": "link:<仓库路径>" }
```

```powershell
cd <仓库路径>
dsh plugin --profile web add link:<仓库路径>   # 装根包（host 走 main，client 走 dsh.client）
dsh --profile web                              # 无需 --patch
```

- `dsh.bundle.patch: "./mcp.patch.yml"` 使 hot_mcp 作为 profile bundle 挂进 `dsh.profile.bundles`，启动时**自动应用** `mcp.patch.yml`。
- **不要再传 `--patch ./mcp.patch.yml`**（会把同一 insert 重复应用，根列表出现两个 `id: hot_mcp`）。若偏好显式 `--patch`，需移除 `dsh.bundle.patch`（二选一，别混）。
- 打开 `http://127.0.0.1:3080` → 设置页 → 「MCP 服务器」。
- **残留清理**：profile node_modules 里若还有旧 `hot_mcp_ui` 链接（指向本仓库的 `ui/` 目录），执行 `dsh plugin --profile web remove hot_mcp_ui`。

## 5. 工作原理

- **动态挂载/两态生命周期**：内存态是 `Map<serverName, { config, fiber? }>`，`fiber` 仅激活时存在。**新增只存配置（未激活）**；**激活**= `ctx.plugin(mcp-client, config)` 并 await ready（失败回滚为未激活）；**停用** = `fiber.dispose()`（自动反注册工具，配置保留）；**删除** = 若激活先 dispose 再删配置；**刷新** = dispose + 重新 mount（仅已激活有效）。
- **host→client RPC**：host `connection.fetch.register({ path: "/api/hot-mcp", methods: ["POST"], requestBody: "buffered", fetch })`；client 发 `{type:'client-request',rpcId,method,payload}` 到 `/api/hot-mcp`，收到 `{type:'server-response',rpcId,result}`。handler 返回 `{ ok, value }` 或 `{ ok:false, error }`。方法：`list / add / activate / deactivate / remove / refresh`。
- **client slot 注入**：client 插件 `inject: ['slots']`，`ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id:'mcp', order:25, label, inject }, McpSection))`。
- **样式**：`ui/client.js` 直接引用 dsh 主题 token CSS 变量（`--dsw-alias-bg-layer-*`、`--dsw-alias-border-l1`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/secondary`、`--dsw-alias-state-success/error/warn`），自动跟随明/暗主题。
- **持久化（仅配置）**：激活/停用状态只在 host 进程内存 `Map<serverName, { config, fiber? }>`；**仅配置**写入 `$DSH_HOME/hot_mcp.json`，启动恢复为未激活列表，读写失败降级纯内存不阻塞（见 §9）。

## 6. 关键踩坑（重要，改前必读）

以下六条是本项目从踩坑中确认的硬约束：

1. **`exports` 必须带 `"./package.json"`**。client-modules 用 `require.resolve("<pkg>/package.json")` 读取包的 `dsh.client` 声明；`exports` 一旦存在就是封装边界，不列出 `./package.json` 时该解析直接失败，hot_mcp 被**静默**判为"非客户端包"，UI 永不出现（`/plugins/hot_mcp/client.js` 404，但 GUI 其余正常）。全部官方客户端包都显式加 `"./package.json": "./package.json"`。
2. **`exports["."]` 优先于 `main`**。存在 `exports` 时裸包名按 `exports` 解析；`"."` 曾指向 noop 的 `ui/index.js`，导致 host 不加载 `lib/index.js`（工具/通道全无）。修法：`"."` 指向 `./lib/index.js`，且**不能删掉 `"."` 键**（没有 `"."` 时裸包名导入直接失败，不会回退 `main`）。
3. **host 必须 `inject: ['connection']`**。不声明时 apply 在 connection 服务就绪前就跑，`ctx.get('connection')` 拿到 undefined → `/api/hot-mcp` 路由从未注册 → POST `/api/hot-mcp` 落到前端静态 fallback，返回 **405**。声明后 Cordis 让 fiber 等 connection 就绪再 apply，路由稳定注册。
4. **不要再用 `connection.rpc.handle`**（新 dsh ≥ 0.1.5-rc.1 已不适用）。新版 `dsh-client-connection`（commit `3e24087bfa`）的 `handle(channel, handler)` 会把通道路由注册在 `owner.webServer` 上——`owner` 经 Cordis traceable/shadow 绑定到 **connection 插件的 fiber**，而该插件的 `inject` 已从 `['webServer']` 改为 `['credentials']`（webServer 只在内部 `ctx.inject(['webServer'], …)` 派生上下文里注入、仅用于内置 `/api`），祖先链上找不到 webServer，于是任何插件调用 `rpc.handle` 都会在**加载时**抛 `cannot get property "webServer" without inject`（hot_mcp 曾因此整个 host 端加载失败、6 个工具与 UI 后端全无）。**给 hot_mcp 自己的 `inject` 加 `'webServer'` 也无效**（fiber 游走起点在 connection fiber，不在调用方 fiber，已实测）。第三参 `{ authority: "loopback" }` 亦已移除（信任策略统一为 Host/Origin 栅栏 + 浏览器会话认证，对所有 `/api` 请求生效）。插件自有 HTTP 端点一律改用 `connection.fetch.register({ path: "/api/<name>", methods, requestBody, fetch })`：不读 webServer，走 `/api` 载体继承框架信任与认证，且 `/api` 分发时**精确路由优先于 gateway 拦截器**（`/api` 的 rpc 拦截器已被 API gateway 独占，`rpc.intercept('/api', …)` 会因重复注册抛错，不可用）。
5. **client 插件需 `inject: ['slots']`**：否则 `ctx.slots` 为 undefined，apply 抛错。
6. **UI 改动即时生效无需重启**：client bundle 由 client-modules 按文件原样服务（`cache-control: no-cache`），改完 `ui/client.js` 整页刷新即可；只有改动 host（`lib/index.js`）/ package.json / profile 组成才需重启 dsh。

## 7. 测试 / 验证

- **UI**：设置页新增（stdio：command/args/cwd/env；HTTP：url/headers，默认未激活）、行内激活/停用、刷新、删除二次确认、刷新列表。
- **模型工具**：`mcp_server_list / add / activate / deactivate / remove / refresh`（与 UI 走同一套 `/api/hot-mcp` 逻辑）。
- **工具注册验证**：新增后不出现工具（未激活）；激活后 `mcp__<serverName>__*` 出现在模型工具表，停用/删除后全部消失（`mcp_server_list` 的 `servers` 状态随之 active/inactive）。
- **持久化**：新增后 `$DSH_HOME/hot_mcp.json` 出现该配置；重启 dsh 后配置仍在、但全部未激活；删除后文件记录消失。

## 8. 参考（框架内部文件，精读用）

- client 端注入范例：`node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`（`inject` + `apply` + `settings.section` 注册）
- client-modules 发现逻辑：`node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`（`resolveMeta` / `processOne` / `serveBundle`）
- Fetch 路由契约：`node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts`（`HostConnectionFetch.register`，path 必须在 `/api/` 下、endpoint 段限 `[A-Za-z0-9_$.-]+`）、`lib/index.js`（`bridge` / `createSharedFetchHandler`，`/api` 分发时精确路由优先于 gateway 拦截器）
- 主题 token：client 侧 Theme Inspect Provider `listTokens`
- 动态挂载：`@deepseek-ai/dsh-cordis-host-runner`（`ctx.plugin` + `fiber.dispose`）
- MCP 底层：`@deepseek-ai/dsh-mcp-client`（`startConnection` / `syncTools` / `apply`）

## 9. 持久化（配置落盘）—— 已实现（JSON 文件，$DSH_HOME/hot_mcp.json）

> 只持久化服务器配置，不持久化激活状态；每次启动默认全部未激活，激活/停用纯内存。
> 早期曾用 storageDomain 域层方案（需额外依赖 + profile 重装），因依赖安装失败（`ERR_MODULE_NOT_FOUND`）与日志可见性问题弃用；改为**直接读写 JSON 文件，零额外依赖**。

### 9.1 存储位置与格式

- **路径**：`$DSH_HOME/hot_mcp.json`（`$DSH_HOME` 未设置时回退 `~/.dsh`），即 dsh 数据根目录下的 `hot_mcp.json`。
- **格式**：`{ "version": 1, "servers": { "<serverName>": {config} } }`；config 即归一化后的 `{ serverName, transport, command?, args?, env?, cwd?, url?, headers? }`。
- **写盘**：先写 `hot_mcp.json.tmp` 再 `rename` 原子替换；每次 add/remove 全量重写（数据量小，够用）。

### 9.2 读写时机

- **启动**（`loadConfigs`）：读文件 → `servers.set(name, { config, fiber: undefined })`（全部未激活）；文件不存在 = 首次运行；读失败（非 ENOENT）warn 后空列表启动，**不阻塞**。
- **add**（async）：校验 → 写内存 → `saveConfigs()` 落盘；**写失败回滚内存并报错**。
- **remove**（async）：激活先 dispose → 删内存 → 落盘；写失败恢复内存记录并报错。
- **activate / deactivate / refresh**：纯内存，不落盘。

### 9.3 代码要点

- 顶部静态导入 Node 内建模块：`import { homedir } from "node:os"` / `import { join } from "node:path"` / `import { readFile, rename, writeFile } from "node:fs/promises"`（host 静态插件可直接使用，零依赖）。
- 路径：`filePath = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "hot_mcp.json")`。
- 两个辅助函数：`saveConfigs()` / `loadConfigs()`；`addServer` / `removeServer` 改 async；`mcp_server_add` 工具与 RPC `add/remove` 等待其完成。
- 不依赖 `@deepseek-ai/dsh-storage-domain`，**无需 profile 重装任何新依赖**。

### 9.4 失败语义

- **启动读失败** → warn + 空列表（不阻塞启动，配置丢了只需重加）。
- **写失败** → add/remove 返回错误、内存回滚（内存与磁盘保持一致）。
- **结构变化** → bump `version` 字段。
- **配置含 secret**（如 headers 里的 token）→ JSON 明文落盘，与 dsh 其它持久化一致（无加密层）。
