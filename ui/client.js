// hot_mcp - client half for the MCP settings section.
window.__ModuleLoader__.load({
  id: "hot_mcp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const { useState, useEffect, useCallback, useRef } = react;
    const { jsx, jsxs, Fragment } = jsxRuntime;

    const C = {
      surface: "var(--dsw-alias-bg-layer-1)",
      input: "#f5f6f7",
      border: "var(--dsw-alias-border-l1)",
      brand: "var(--dsw-alias-brand-primary)",
      text: "var(--dsw-alias-label-primary)",
      muted: "var(--dsw-alias-label-secondary)",
      ok: "var(--dsw-alias-state-success-primary)",
      err: "var(--dsw-alias-state-error-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
    };

    const inputStyle = {
      boxSizing: "border-box",
      width: "100%",
      minWidth: 0,
      height: 36,
      padding: "0 10px",
      border: "1px solid " + C.border,
      borderRadius: 6,
      background: C.input,
      color: C.text,
      fontSize: 13,
      fontFamily: "inherit",
      outline: "none",
      boxShadow: "0 0 0 1px " + C.border,
    };

    const buttonStyle = {
      height: 32,
      padding: "0 11px",
      border: "1px solid " + C.border,
      borderRadius: 6,
      background: "transparent",
      color: C.text,
      fontSize: 12,
      fontFamily: "inherit",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    function call(method, payload) {
      const rpcId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
      return fetch("/api/hot-mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: payload ?? {} }),
      })
        .then((res) => res.ok ? res.json() : res.text().then((text) => { throw new Error(text); }))
        .then((envelope) => envelope && envelope.result);
    }

    function parsePairs(text) {
      const out = {};
      String(text || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).forEach((pair) => {
        const index = pair.indexOf("=");
        if (index > 0) out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
      });
      return out;
    }

    function McpSection() {
      const [servers, setServers] = useState([]);
      const [loading, setLoading] = useState(true);
      const [busyKey, setBusyKey] = useState(null);
      const [confirmRemove, setConfirmRemove] = useState(null);
      const [message, setMessage] = useState(null);
      const confirmTimer = useRef(null);
      const [form, setForm] = useState({
        serverName: "", transport: "stdio", command: "", args: "", cwd: "", env: "", url: "", headers: "",
      });

      useEffect(() => () => {
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
      }, []);

      const flash = (kind, text) => setMessage({ kind, text });
      const load = useCallback((busy) => {
        if (busy) setBusyKey("list");
        setLoading(true);
        return call("list", {})
          .then((res) => {
            if (res && res.ok) setServers(res.value.servers || []);
            else flash("err", (res && res.error && res.error.message) || "加载失败");
          })
          .catch((error) => flash("err", "加载失败: " + error))
          .finally(() => { setLoading(false); if (busy) setBusyKey(null); });
      }, []);

      useEffect(() => { load(false); }, [load]);

      const run = (method, payload, key) => {
        setBusyKey(key);
        setMessage(null);
        return call(method, payload)
          .then((res) => {
            if (res && res.ok) flash("ok", (res.value && res.value.message) || "操作成功");
            else flash("err", (res && res.error && res.error.message) || "操作失败");
          })
          .catch((error) => flash("err", "操作失败: " + error))
          .finally(() => { setBusyKey(null); load(false); });
      };

      const doAdd = () => {
        const f = form;
        if (!f.serverName.trim()) return flash("err", "请填写服务器名称");
        if (f.transport === "stdio" && !f.command.trim()) return flash("err", "请填写启动命令");
        if (f.transport === "streamable-http" && !f.url.trim()) return flash("err", "请填写 URL");
        const config = { serverName: f.serverName.trim(), transport: f.transport };
        if (f.transport === "stdio") {
          config.command = f.command.trim();
          if (f.args.trim()) config.args = f.args.split(/[\s,]+/).filter(Boolean);
          if (f.cwd.trim()) config.cwd = f.cwd.trim();
          const env = parsePairs(f.env);
          if (Object.keys(env).length) config.env = env;
        } else {
          config.url = f.url.trim();
          const headers = parsePairs(f.headers);
          if (Object.keys(headers).length) config.headers = headers;
        }
        setBusyKey("add");
        setMessage(null);
        call("add", config)
          .then((res) => {
            if (res && res.ok) {
              flash("ok", (res.value && res.value.message) || "服务器已添加");
              setForm({ ...f, serverName: "", command: "", args: "", cwd: "", env: "", url: "", headers: "" });
            } else flash("err", (res && res.error && res.error.message) || "添加失败");
          })
          .catch((error) => flash("err", "添加失败: " + error))
          .finally(() => { setBusyKey(null); load(false); });
      };

      const doRemove = (name) => {
        if (confirmRemove !== name) {
          setConfirmRemove(name);
          if (confirmTimer.current) clearTimeout(confirmTimer.current);
          confirmTimer.current = setTimeout(() => setConfirmRemove(null), 3000);
          return;
        }
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        setConfirmRemove(null);
        run("remove", { serverName: name }, "remove:" + name);
      };

      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
      const activeCount = servers.filter((server) => server.status === "active").length;
      const disabled = busyKey !== null;
      const label = (text, node) => jsxs("label", {
        style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
        children: [jsx("span", { style: { color: C.text, fontSize: 12, fontWeight: 600 }, children: text }), node],
      });

      const serverRows = servers.map((server) => {
        const active = server.status === "active";
        const key = server.serverName;
        const working = busyKey === "activate:" + key || busyKey === "deactivate:" + key || busyKey === "refresh:" + key || busyKey === "remove:" + key;
        const confirming = confirmRemove === key;
        return jsxs("div", {
          key,
          style: {
            display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "8px 0",
            borderBottom: "1px solid " + C.border, opacity: working ? 0.55 : 1,
          },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 0 }, children: jsxs("div", {
              style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
              children: [
                jsx("span", { style: { width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: active ? C.ok : C.muted } }),
                jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.text, fontSize: 13, fontWeight: 600 }, children: key }),
                jsx("span", { style: { color: active ? C.ok : C.muted, fontSize: 12, whiteSpace: "nowrap" }, children: active ? "已激活" : "未激活" }),
              ],
            }) }),
            jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }, children: [
              active
                ? jsx("button", { disabled, onClick: () => run("deactivate", { serverName: key }, "deactivate:" + key), style: { ...buttonStyle, color: C.warn }, children: busyKey === "deactivate:" + key ? "停用中" : "停用" })
                : jsx("button", { disabled, onClick: () => run("activate", { serverName: key }, "activate:" + key), style: { ...buttonStyle, color: C.ok, borderColor: C.ok }, children: busyKey === "activate:" + key ? "激活中" : "激活" }),
              active && jsx("button", { disabled, onClick: () => run("refresh", { serverName: key }, "refresh:" + key), style: buttonStyle, children: busyKey === "refresh:" + key ? "刷新中" : "刷新" }),
              jsx("button", { disabled, onClick: () => doRemove(key), style: { ...buttonStyle, color: confirming ? "#fff" : C.err, background: confirming ? C.err : "transparent", borderColor: confirming ? C.err : C.border }, children: busyKey === "remove:" + key ? "删除中" : confirming ? "再次点击确认" : "删除" }),
            ] }),
          ],
        });
      });

      const transportButton = (value, text) => jsx("button", {
        onClick: () => setForm({ ...form, transport: value }),
        style: {
          ...buttonStyle, height: 30, padding: "0 12px", background: form.transport === value ? C.text : "transparent",
          color: form.transport === value ? C.surface : C.text,
        },
        children: text,
      });

      const fields = form.transport === "stdio"
        ? jsxs(Fragment, { children: [
            label("启动命令", jsx("input", { style: inputStyle, placeholder: "例如 uvx mcp-server", value: form.command, onChange: set("command") })),
            label("参数（可选）", jsx("input", { style: inputStyle, placeholder: "例如 --transport stdio", value: form.args, onChange: set("args") })),
            label("工作目录（可选）", jsx("input", { style: inputStyle, placeholder: "服务器工作目录", value: form.cwd, onChange: set("cwd") })),
            label("环境变量（可选）", jsx("textarea", { style: { ...inputStyle, height: 72, padding: "8px 10px", resize: "vertical" }, placeholder: "KEY=value，每行一项", value: form.env, onChange: set("env") })),
          ] })
        : jsxs(Fragment, { children: [
            label("服务器 URL", jsx("input", { style: inputStyle, placeholder: "https://example.com/mcp", value: form.url, onChange: set("url") })),
            label("请求头（可选）", jsx("textarea", { style: { ...inputStyle, height: 72, padding: "8px 10px", resize: "vertical" }, placeholder: "Authorization=Bearer ...", value: form.headers, onChange: set("headers") })),
          ] });

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 22, padding: "6px 0 24px", maxWidth: 680 },
        children: [
          jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, minHeight: 32 }, children: [
            jsx("h3", { style: { margin: 0, color: C.text, fontSize: 16, fontWeight: 700 }, children: "MCP 服务器" }),
            jsx("span", { style: { color: C.muted, fontSize: 12 }, children: activeCount + "/" + servers.length + " 已激活" }),
            jsx("div", { style: { flex: 1 } }),
            jsx("button", { disabled: busyKey === "list", onClick: () => load(true), style: buttonStyle, children: busyKey === "list" ? "刷新中" : "刷新列表" }),
          ] }),
          message && jsx("div", { style: { padding: "9px 11px", borderRadius: 6, color: message.kind === "ok" ? C.ok : C.err, background: C.surface, border: "1px solid " + (message.kind === "ok" ? C.ok : C.err), fontSize: 12 }, children: message.text }),
          jsxs("section", { style: { padding: "0 14px", border: "1px solid " + C.border, borderRadius: 8, background: C.surface }, children: [
            jsx("div", { style: { padding: "13px 0 4px", color: C.text, fontSize: 13, fontWeight: 700 }, children: "已配置服务器" }),
            servers.length ? serverRows : jsx("div", { style: { padding: "22px 0 24px", color: C.muted, fontSize: 13, textAlign: "center" }, children: loading ? "加载中" : "暂无服务器" }),
          ] }),
          jsxs("section", { style: { padding: 16, border: "1px solid " + C.border, borderRadius: 8, background: C.surface }, children: [
            jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 9, marginBottom: 14 }, children: [
              jsx("h4", { style: { margin: 0, color: C.text, fontSize: 14 }, children: "添加服务器" }),
              jsx("span", { style: { color: C.muted, fontSize: 12 }, children: "添加后默认未激活" }),
            ] }),
            jsxs("div", { style: { display: "grid", gridTemplateColumns: "minmax(180px, 1fr) auto", gap: 12, alignItems: "end", marginBottom: 14 }, children: [
              label("名称", jsx("input", { style: inputStyle, placeholder: "例如 my-server", value: form.serverName, onChange: set("serverName") })),
              jsxs("div", { style: { display: "flex", gap: 6, paddingBottom: 3 }, children: [transportButton("stdio", "stdio"), transportButton("streamable-http", "HTTP")] }),
            ] }),
            jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }, children: fields }),
            jsxs("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 }, children: [
              jsx("button", { disabled, onClick: doAdd, style: { ...buttonStyle, height: 34, padding: "0 16px", background: C.brand, borderColor: C.brand, color: "#fff", fontWeight: 600 }, children: busyKey === "add" ? "添加中" : "添加服务器" }),
            ] }),
          ] }),
        ],
      });
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "mcp", order: 25, label: () => "MCP 服务器", inject: () => ({}),
      }, McpSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
