/**
 * hot_mcp — host 半：运行时动态新增/激活/停用/删除/刷新 MCP 服务器。
 *
 * 复用 @deepseek-ai/dsh-mcp-client 做动态挂载/销毁：激活时把它提供的工具注册进工具表，
 * 停用/删除时反注册。新增的服务器默认「未激活」，需手动激活后才连接、注册工具。
 *
 * 持久化：**只持久化服务器配置，不持久化激活状态**。add/remove 时把配置写入
 * `$DSH_HOME/hot_mcp.json`（JSON，直接放在 .dsh 目录），启动时读回并全部置为未激活；
 * activate/deactivate/refresh 纯内存。读写失败不阻塞启动（降级为纯内存），写失败会让
 * add/remove 返回错误并回滚内存。
 *
 * 不依赖 HMR。单插件设计：本文件是包 `hot_mcp` 的 host 入口（包 `main` 指向它）。
 * mcp.patch.yml 里一个 insert `name: 'hot_mcp'` 加载本包；client 半由同一包的
 * dsh.client + exports["./client"] 提供（ui/client.js）。
 * 注意：Node 解析裸包名时 exports["."] 优先于 main——只要 exports 存在且 "." 指到别处，
 * host 就不会走到本文件（见 AGENTS.md「关键踩坑」）。
 * 依赖的 @deepseek-ai/dsh-mcp-client 在启动时从 ctx.baseUrl（= profile 目录）的
 * node_modules 解析。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";

/** 持久化文件：$DSH_HOME/hot_mcp.json（DSH_HOME 缺省时回退到 ~/.dsh）。 */
const dshHome =
  (typeof process !== "undefined" && process.env.DSH_HOME) || join(homedir(), ".dsh");
const filePath = join(dshHome, "hot_mcp.json");

export const name = "hot_mcp";
export const inject = ["tools", "connection"];

/** 输出 schema + 渲染：把 execute 返回的对象转成模型可见文本。 */
const TEXT_OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render(_args, value) {
    return [{ type: "text", text: JSON.stringify(value, null, 2) }];
  },
};

const ok = (message, extra = {}) => ({ ok: true, message, ...extra });
const bad = (message) => ({ ok: false, message });

/** 从已启动 profile 的 node_modules 解析 dsh-mcp-client（ctx.baseUrl = profile 目录）。 */
async function loadMcpClient(ctx) {
  const candidate = new URL(
    "node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js",
    ctx.baseUrl,
  ).href;
  try {
    return await import(candidate);
  } catch (error) {
    throw new Error(
      `hot_mcp: 无法解析 @deepseek-ai/dsh-mcp-client (${candidate}): ${String(error)}`,
    );
  }
}

/** 把工具的宽松参数规整成 dsh-mcp-client 的 Config 形状。 */
function normalizeConfig(args) {
  const config = { serverName: args.serverName, transport: args.transport };
  if (args.transport === "stdio") {
    config.command = args.command;
    if (args.args !== undefined) config.args = args.args;
    if (args.env !== undefined) config.env = args.env;
    if (args.cwd !== undefined) config.cwd = args.cwd;
  } else {
    config.url = args.url;
    if (args.headers !== undefined) config.headers = args.headers;
  }
  return config;
}

export async function apply(ctx) {
  const mcp = await loadMcpClient(ctx);

  /**
   * 内存态：serverName -> { config, fiber? }。激活状态不落盘。
   * fiber 仅在该服务器「激活」时存在；未激活时只有配置，不连接、不注册工具。
   */
  const servers = new Map();

  /** 把当前所有服务器配置序列化并原子写入 $DSH_HOME/hot_mcp.json。失败抛出。 */
  async function saveConfigs() {
    const configs = {};
    for (const [name, record] of servers) configs[name] = record.config;
    const data = { version: 1, servers: configs };
    const tmp = filePath + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, filePath);
  }

  /** 启动恢复：读取 JSON，全部以「未激活」载入内存。读失败不阻塞启动。 */
  async function loadConfigs() {
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      const configs = data && typeof data === "object" ? data.servers ?? {} : {};
      for (const [name, config] of Object.entries(configs)) {
        if (config && typeof config === "object" && typeof config.serverName === "string") {
          servers.set(name, { config, fiber: undefined });
        }
      }
      console.log(`[hot_mcp] 已从 ${filePath} 恢复 ${servers.size} 个服务器配置（均未激活）`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[hot_mcp] 读取持久化文件失败（${filePath}），以空列表启动：${String(error?.message ?? error)}`);
      }
    }
  }

  await loadConfigs();

  // 卸载时 dispose 所有已激活的 mcp-client 实例。
  ctx.effect(() => () => {
    for (const record of servers.values()) {
      if (record.fiber) record.fiber.dispose().catch(() => {});
    }
    servers.clear();
  }, "hot_mcp.servers");

  /** 挂载（激活）一个 mcp-client 实例并等待初始连接 + 工具发现。失败时回滚为未激活。 */
  async function mount(record) {
    const fiber = ctx.plugin({
      name: "mcp-client",
      inject: ["tools"],
      apply: mcp.apply,
      Config: mcp.Config,
    }, record.config);
    record.fiber = fiber;
    try {
      await fiber;
    } catch (error) {
      record.fiber = undefined;
      await fiber.dispose().catch(() => {});
      throw error;
    }
  }

  /** 新增：校验、写入内存、落盘（先落盘后提交，写失败回滚内存）。默认未激活。 */
  async function addServer(config) {
    const serverName = config.serverName;
    if (!serverName) throw new Error("缺少 serverName");
    if (servers.has(serverName)) {
      throw new Error(`serverName "${serverName}" 已存在，请先删除或换个名字`);
    }
    if (config.transport === "stdio" && !config.command) {
      throw new Error("stdio 需要 command");
    }
    if (config.transport === "streamable-http" && !config.url) {
      throw new Error("streamable-http 需要 url");
    }
    servers.set(serverName, { config, fiber: undefined });
    try {
      await saveConfigs();
    } catch (error) {
      servers.delete(serverName);
      throw new Error(`保存配置失败: ${String(error?.message ?? error)}`);
    }
    return { config, fiber: undefined };
  }

  function recordOf(serverName) {
    const record = servers.get(serverName);
    if (!record) throw new Error(`未找到服务器 "${serverName}"`);
    return record;
  }

  async function activate(serverName) {
    const record = recordOf(serverName);
    if (record.fiber) throw new Error(`服务器 "${serverName}" 已激活`);
    await mount(record);
  }

  async function deactivate(serverName) {
    const record = recordOf(serverName);
    if (!record.fiber) throw new Error(`服务器 "${serverName}" 未激活，无需停用`);
    await record.fiber.dispose();
    record.fiber = undefined;
  }

  /** 移除：激活中先断开，删内存、落盘；写失败回滚内存并抛出。 */
  async function removeServer(serverName) {
    const record = recordOf(serverName);
    if (record.fiber) await record.fiber.dispose();
    servers.delete(serverName);
    try {
      await saveConfigs();
    } catch (error) {
      servers.set(serverName, record);
      throw new Error(`保存配置失败: ${String(error?.message ?? error)}`);
    }
  }

  async function refresh(serverName) {
    const record = recordOf(serverName);
    if (!record.fiber) throw new Error(`服务器 "${serverName}" 未激活，无需刷新`);
    const { config } = record;
    await record.fiber.dispose();
    record.fiber = undefined;
    await mount(record);
  }

  const snapshot = () =>
    [...servers.entries()].map(([serverName, record]) => ({
      serverName,
      status: record.fiber ? "active" : "inactive",
    }));

  ctx.tools.register({
    name: "mcp_server_list",
    description: "列出当前已通过 mcp_server_add 添加的 MCP 服务器及其状态（active=已激活 / inactive=未激活）。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute: () => Promise.resolve({ ok: true, servers: snapshot() }),
  });

  ctx.tools.register({
    name: "mcp_server_add",
    description: "运行时新增一个 MCP 服务器（默认未激活，不会连接；需调用 mcp_server_activate 激活后才连接并注册工具）。配置会保存到 $DSH_HOME/hot_mcp.json，重启后仍保留（但保持未激活）。stdio 需 command（可带 args/env/cwd）；streamable-http 需 url（可带 headers）。",
    parameters: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "唯一命名空间，工具将以 mcp__<serverName>__<tool> 暴露" },
        transport: { type: "string", enum: ["stdio", "streamable-http"] },
        command: { type: "string", description: "stdio：要 spawn 的可执行文件" },
        args: { type: "array", items: { type: "string" }, description: "stdio：命令参数数组" },
        env: { type: "object", additionalProperties: { type: "string" }, description: "stdio：附加环境变量对象" },
        cwd: { type: "string", description: "stdio：子进程工作目录" },
        url: { type: "string", description: "streamable-http：MCP 服务器 URL" },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "streamable-http：附加请求头对象" },
      },
      required: ["serverName", "transport"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        await addServer(normalizeConfig(args));
        return ok(`MCP 服务器 "${args.serverName}" 已添加（未激活，配置已保存），调用 mcp_server_activate 激活`, { serverName: args.serverName, status: "inactive" });
      } catch (error) {
        return bad(String(error?.message ?? error));
      }
    },
  });

  ctx.tools.register({
    name: "mcp_server_activate",
    description: "激活一个已添加但未激活的 MCP 服务器：连接它并把它的工具注册进工具表（激活状态不持久化，重启后回到未激活）。",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" } },
      required: ["serverName"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        await activate(args.serverName);
        return ok(`MCP 服务器 "${args.serverName}" 已激活并注册工具`, { serverName: args.serverName, status: "active" });
      } catch (error) {
        return bad(String(error?.message ?? error));
      }
    },
  });

  ctx.tools.register({
    name: "mcp_server_deactivate",
    description: "停用一个已激活的 MCP 服务器：断开连接并从工具表反注册它带来的全部工具（配置保留，可再次激活）。",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" } },
      required: ["serverName"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        await deactivate(args.serverName);
        return ok(`MCP 服务器 "${args.serverName}" 已停用，其工具已反注册`, { serverName: args.serverName, status: "inactive" });
      } catch (error) {
        return bad(String(error?.message ?? error));
      }
    },
  });

  ctx.tools.register({
    name: "mcp_server_remove",
    description: "运行时移除一个 MCP 服务器（激活中会先断开连接并反注册其工具），配置一并删除（含持久化文件中的记录）。",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" } },
      required: ["serverName"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        await removeServer(args.serverName);
        return ok(`MCP 服务器 "${args.serverName}" 已移除`);
      } catch (err) {
        return bad(`移除失败: ${String(err?.message ?? err)}`);
      }
    },
  });

  ctx.tools.register({
    name: "mcp_server_refresh",
    description: "刷新一个已激活的 MCP 服务器：断开并重新连接，重新发现并注册其工具（未激活的服务器无需刷新）。",
    parameters: {
      type: "object",
      properties: { serverName: { type: "string" } },
      required: ["serverName"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const serverName = args.serverName;
      try {
        await refresh(serverName);
        return ok(`MCP 服务器 "${serverName}" 已刷新（断开 + 重连）`);
      } catch (err) {
        return bad(`刷新失败: ${String(err?.message ?? err)}`);
      }
    },
  });

  // ── /mcp connection RPC 通道（供浏览器设置页 UI 调用）────────────
  const connection = ctx.get("connection");
  if (connection?.rpc) {
    const rpcHandler = async (method, payload) => {
      try {
        switch (method) {
          case "list":
            return { ok: true, value: { servers: snapshot() } };
          case "add": {
            await addServer(normalizeConfig(payload ?? {}));
            return { ok: true, value: { message: `MCP 服务器 "${payload?.serverName}" 已添加（未激活，配置已保存），请手动激活` } };
          }
          case "activate": {
            await activate(payload?.serverName);
            return { ok: true, value: { message: `MCP 服务器 "${payload?.serverName}" 已激活并注册工具` } };
          }
          case "deactivate": {
            await deactivate(payload?.serverName);
            return { ok: true, value: { message: `MCP 服务器 "${payload?.serverName}" 已停用` } };
          }
          case "remove": {
            await removeServer(payload?.serverName);
            return { ok: true, value: { message: `MCP 服务器 "${payload?.serverName}" 已移除` } };
          }
          case "refresh": {
            await refresh(payload?.serverName);
            return { ok: true, value: { message: `MCP 服务器 "${payload?.serverName}" 已刷新` } };
          }
          default:
            return { ok: false, error: { code: "bad-request", message: `未知方法 "${method}"`, details: {} } };
        }
      } catch (error) {
        return {
          ok: false,
          error: { code: "internal", message: String(error?.message ?? error), details: {} },
        };
      }
    };
    connection.rpc.handle("/mcp", rpcHandler, { authority: "loopback" });
  }
}
