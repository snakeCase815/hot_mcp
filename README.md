# hot_mcp

[English](./README.md) | [简体中文](./README-zh.md)

**hot_mcp** is a runtime MCP server manager for DeepSeek Harness (DSH): add, activate, deactivate, remove, and refresh MCP servers **while the harness is running** — no restart, no HMR. When a server is activated, its tools are registered into the model tool table as `mcp__<serverName>__<tool>`; deactivating or removing the server unregisters them all.

A few design choices worth knowing up front:

- **New servers are added inactive.** Adding a server only saves its configuration — nothing is spawned or connected until you explicitly activate it.
- **Only configurations are persisted** (a single JSON file, `$DSH_HOME/hot_mcp.json`, zero extra dependencies). Activation state lives in process memory: after every restart, all servers come back inactive.
- **Two control surfaces, one code path**: six model tools (`mcp_server_*`) for the agent, and an "MCP Servers" section on the web GUI settings page for humans.
- Under the hood it reuses `@deepseek-ai/dsh-mcp-client`, dynamically mounting and disposing one instance per active server.

## Features

- Runtime lifecycle management: add / activate / deactivate / remove / refresh — no dsh restart
- Two transports: `stdio` (command + args + env + cwd) and `streamable-http` (url + headers)
- Agent-facing model tools **and** a human-facing settings UI, both driving the same logic
- Configuration persistence in one JSON file with atomic writes (tmp + rename)
- Safe failure semantics: write failures roll back in memory; startup read failures degrade to an empty list without blocking startup
- Theme-aware UI: styled with dsh theme tokens, follows light/dark mode automatically

## Requirements

- A DSH installation with the `web` profile (GUI served at `http://127.0.0.1:3080`)
- `@deepseek-ai/dsh-mcp-client` — declared as a dependency of this package; installing hot_mcp pulls it into the profile's `node_modules` automatically

## Install

```powershell
dsh plugin --profile web add github:snakeCase815/hot_mcp   # install from GitHub (host main + client half)
dsh --profile web                                          # start; the patch is applied automatically
```

Then open <http://127.0.0.1:3080> and go to **Settings → MCP Servers**.

To upgrade later, re-run the same `add` command, or `dsh plugin --profile web update hot_mcp`.

## Usage

### Web UI

The settings page gains an **MCP Servers** section:

- **Server list** — each row shows the server name, a status dot (green = active), and inline actions:
  - **Activate** / **Deactivate** — connect and register tools, or disconnect and unregister them
  - **Refresh** — visible on active rows only; disconnects and reconnects the server
  - **Delete** — click twice within 3 seconds to confirm; removes the config entirely
- **Add server** form — pick a transport (stdio / HTTP) and fill in:
  - stdio: launch command, args, working directory, environment variables (`KEY=value`, one per line)
  - HTTP: server URL, extra headers (`Key=value`, one per line)
- Newly added servers appear as **inactive** — activate them to connect and register tools.
- The header shows `n/m active` and a **Refresh list** button.

### Model tools

| Tool | What it does |
|---|---|
| `mcp_server_list` | List configured servers with status (`active` / `inactive`) |
| `mcp_server_add` | Add a server — inactive by default, config persisted to disk |
| `mcp_server_activate` | Connect a server and register its tools as `mcp__<name>__<tool>` |
| `mcp_server_deactivate` | Disconnect and unregister its tools (config kept) |
| `mcp_server_remove` | Disconnect if active, then delete the config from memory and disk |
| `mcp_server_refresh` | Reconnect an active server and re-register its tools |

`mcp_server_add` parameters:

| Parameter | Required | Applies to | Description |
|---|---|---|---|
| `serverName` | ✔ | both | Unique name; tools are exposed as `mcp__<serverName>__<tool>` |
| `transport` | ✔ | both | `"stdio"` or `"streamable-http"` |
| `command` | stdio | stdio | Executable to spawn |
| `args` | – | stdio | Argument array |
| `env` | – | stdio | Extra environment variables |
| `cwd` | – | stdio | Working directory for the child process |
| `url` | http | streamable-http | MCP server URL |
| `headers` | – | streamable-http | Extra request headers |

Example — add a stdio server, then activate it:

1. Call `mcp_server_add` with `serverName: "fs"`, `transport: "stdio"`, `command: "npx"`, `args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]` → the server is added as inactive and its config is saved.
2. Call `mcp_server_activate` with `serverName: "fs"` → the server connects and its tools appear in the tool table as `mcp__fs__*`.
3. Call `mcp_server_deactivate` → all `mcp__fs__*` tools disappear; the config is kept for later re-activation.

### Lifecycle semantics

| Operation | Effect |
|---|---|
| add | Validate, save config, register in memory — inactive, no connection |
| activate | Mount an `mcp-client` instance and wait for the initial connection + tool discovery; on failure, roll back to inactive |
| deactivate | Dispose the instance — connection closed, all tools unregistered; config kept |
| remove | Dispose if active, then delete the config from memory and disk |
| refresh | Dispose + re-mount (active servers only) |
| restart dsh | All saved configs reload as inactive |

## Persistence

- **Path**: `$DSH_HOME/hot_mcp.json` (falls back to `~/.dsh/hot_mcp.json` when `DSH_HOME` is unset)
- **Format**:

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

## License

[MIT](./LICENSE)
