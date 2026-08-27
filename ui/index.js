/**
 * 遗留 noop（旧“独立 UI 包”方案的残留，合并后不再是加载单元）。
 *
 * 单插件合并后：host 半由包 main（lib/index.js）承担，client 半由同一包的
 * dsh.client + exports["./client"]（ui/client.js）承担，本文件没有运行时作用。
 * 它目前仍被 package.json 的 exports["."] 引用；修复 exports（把 "." 指向
 * lib/index.js；注意不能删掉 "."，exports 无 "." 时裸包名导入会失败）后，
 * 本文件与 "hot_mcp_ui" 命名可一并删除。
 */
export const name = "hot_mcp_ui";
export const inject = [];
export function apply() {}
