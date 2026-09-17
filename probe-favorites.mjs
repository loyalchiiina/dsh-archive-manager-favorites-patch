#!/usr/bin/env node
/**
 * 归档会话「收藏 / 复制 ID / 复制文件路径」补丁的 DOM-stub 探针回归。
 *
 * 覆盖：
 *   1. bundle 能被 __ModuleLoader__.load 捕获，factory 执行期（模块级代码）不抛错；
 *   2. 收藏纯函数与共享 store（含 localStorage 持久化、订阅通知、无变化不通知）；
 *   3. 侧栏会话菜单项：4 项、id 正确、收藏态标签切换、图标 filled 跟随；
 *   4. apply(ctx) 注册 sidebar.workspaces 与 settings.section，且新增代码不抛错。
 *
 * 用法：node probe-favorites.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BUNDLE = join(
  process.env.DSH_ARCHIVE_MANAGER_DIR ?? join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "@michengai", "dsh-archive-manager"),
  "lib",
  "client.js"
);

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: condition === true, detail });
}
function section(title) {
  results.push({ section: title });
}

// ---------- 浏览器环境 stub ----------
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key)
};
function domNode() {
  const node = {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, append() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, insertBefore() {}, after() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, removeChild() {}
  };
  return node;
}
globalThis.document = {
  documentElement: { lang: "zh-CN" },
  body: domNode(),
  head: domNode(),
  createElement: () => domNode(),
  createElementNS: () => domNode(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
// Node 24 的 globalThis.navigator 是只读 getter，改用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => void 0 } },
  configurable: true,
  writable: true
});
globalThis.window = globalThis;

function jsxStub(type, props) {
  return { type, props: props ?? {} };
}
const reactStub = {
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: jsxStub,
  Fragment: Symbol("Fragment")
};
const primitivesStub = new Proxy(
  { Button: jsxStub, Menu: jsxStub, Modal: jsxStub, HoverCard: jsxStub, Pill: jsxStub },
  { get: (target, key) => (key in target ? target[key] : jsxStub) }
);
const moduleStubs = {
  "@deepseek-ai/dsh-client-store": { createStore: () => ({}) },
  "react/jsx-runtime": { jsx: jsxStub, jsxs: jsxStub, Fragment: Symbol("Fragment") },
  react: reactStub,
  "@deepseek-ai/dsh-client-ui-primitives": primitivesStub
};
function requireStub(id) {
  if (id in moduleStubs) return moduleStubs[id];
  throw new Error(`probe: unexpected module request "${id}"`);
}

// ---------- 加载 bundle ----------
let entry;
globalThis.__ModuleLoader__ = { load: (value) => { entry = value; } };
const source = readFileSync(BUNDLE, "utf8");
new Function("window", "document", "globalThis", source)(globalThis, globalThis.document, globalThis);

section("bundle 加载");
check("__ModuleLoader__.load 被调用", entry !== void 0);
check("bundle id = 包名", entry?.id === "@michengai/dsh-archive-manager", String(entry?.id));

let exports2;
let factoryError;
try {
  exports2 = entry.factory(requireStub);
} catch (error) {
  factoryError = error;
}
section("factory 执行（模块级代码）");
check("factory 执行无异常", factoryError === void 0, factoryError === void 0 ? "" : String(factoryError));

const test = exports2?.__test ?? {};
if (factoryError !== void 0 || Object.keys(test).length === 0) {
  console.error("[diag] factoryError =", factoryError);
  console.error("[diag] exports keys =", Object.keys(exports2 ?? {}));
  console.error("[diag] __test keys =", Object.keys(test));
}
section("测试钩子导出");
for (const key of [
  "deriveUnfavoritedSessionIds",
  "toggleFavoriteSessionId",
  "readFavoriteSessionIds",
  "writeFavoriteSessionIds",
  "sessionClipboardMenuItems",
  "archiveFavoriteStore",
  "ARCHIVE_FAVORITES_STORAGE_KEY",
  "SESSION_PATH_ENDPOINT"
]) {
  check(`__test.${key} 已导出`, key in test, typeof test[key]);
}

const KEY = test.ARCHIVE_FAVORITES_STORAGE_KEY;
section("存储键与路由常量");
check("存储键前缀正确", typeof KEY === "string" && KEY.startsWith("dsham."), String(KEY));
check("路径路由与宿主一致", test.SESSION_PATH_ENDPOINT === "/api/michengai/dsh-archive-manager/session-path", String(test.SESSION_PATH_ENDPOINT));

section("收藏纯函数");
check("toggle 添加", JSON.stringify(test.toggleFavoriteSessionId([], "a")) === '["a"]');
check("toggle 移除", JSON.stringify(test.toggleFavoriteSessionId(["a", "b"], "a")) === '["b"]');
check("toggle 不重复添加", JSON.stringify(test.toggleFavoriteSessionId(["a"], "a")) === "[]");
check(
  "未收藏集合 = 归档集合 - 收藏",
  JSON.stringify(test.deriveUnfavoritedSessionIds(["a", "b", "c", "b"], new Set(["b"]))) === '["a","c"]',
  JSON.stringify(test.deriveUnfavoritedSessionIds(["a", "b", "c", "b"], new Set(["b"])))
);
check("未收藏集合（空收藏 = 全部）", JSON.stringify(test.deriveUnfavoritedSessionIds(["a"], [])) === '["a"]');
check("未收藏集合容忍 undefined 输入", JSON.stringify(test.deriveUnfavoritedSessionIds(void 0, ["a"])) === "[]");

section("localStorage 持久化");
test.writeFavoriteSessionIds(["x", "y", "x"]);
check("写入去重", storage.get(KEY) === '["x","y"]', String(storage.get(KEY)));
check("读取还原", JSON.stringify(test.readFavoriteSessionIds()) === '["x","y"]');
storage.set(KEY, "{ not json");
check("损坏数据回退空数组", JSON.stringify(test.readFavoriteSessionIds()) === "[]");
storage.set(KEY, JSON.stringify(["ok", 42, "", null, "ok"]));
check("非法条目被过滤", JSON.stringify(test.readFavoriteSessionIds()) === '["ok"]');

section("共享 store（设置页与侧栏同源）");
storage.set(KEY, JSON.stringify(["s1"]));
const store = test.archiveFavoriteStore;
// 模块级 store 在 factory 执行时已初始化，这里直接验证其行为
let notifications = 0;
const unsubscribe = store.subscribe(() => {
  notifications += 1;
});
const before = store.getSnapshot();
store.toggle("s2");
const after = store.getSnapshot();
check("toggle 后快照变化（新引用）", before !== after);
check("toggle 后包含新 id", after.includes("s2"), JSON.stringify(after));
check("toggle 已持久化", String(storage.get(KEY)).includes("s2"), String(storage.get(KEY)));
check("订阅者被通知", notifications === 1, String(notifications));
store.prune(["nonexistent-id"]);
check("prune 无变化时不通知", notifications === 1, String(notifications));
store.prune(new Set(["s2"]));
check("prune 移除目标", store.getSnapshot().includes("s2") === false, JSON.stringify(store.getSnapshot()));
check("prune 后通知订阅者", notifications === 2, String(notifications));
unsubscribe();
store.toggle("s3");
check("退订后不再通知", notifications === 2, String(notifications));
store.prune(["s3"]);

section("侧栏会话菜单项");
const fakeT = (key, params) => (params === void 0 ? key : `${key}(${JSON.stringify(params)})`);
const items = test.sessionClipboardMenuItems(fakeT, false, false);
check("菜单项 5 个", items.length === 5, String(items.length));
check(
  "菜单项 id 顺序",
  JSON.stringify(items.map((item) => item.id)) === '["pin","favorite","copy-id","copy-path","copy-both"]',
  JSON.stringify(items.map((item) => item.id))
);
check("未置顶时标签为置顶会话", items[0].label === "menu.pin", items[0].label);
check("未收藏时标签为收藏", items[1].label === "menu.favorite", items[1].label);
check("复制项标签正确", items[2].label === "menu.copySessionId" && items[3].label === "menu.copySessionPath" && items[4].label === "menu.copySessionIdAndPath");
check("每项均有图标", items.every((item) => item.icon !== void 0));
const favItems = test.sessionClipboardMenuItems(fakeT, true, true);
check("已收藏时标签为取消收藏", favItems[1].label === "menu.unfavorite", favItems[1].label);
check("已收藏时星标为实心", favItems[1].icon?.props?.filled === true, JSON.stringify(favItems[1].icon?.props));
check("未收藏时星标为空心", items[1].icon?.props?.filled === false, JSON.stringify(items[1].icon?.props));
check("已置顶时标签为取消置顶", favItems[0].label === "menu.unpin", favItems[0].label);
check("已置顶时图钉为实心", favItems[0].icon?.props?.filled === true, JSON.stringify(favItems[0].icon?.props));

section("会话置顶");
check("导出 archivePinStore", typeof test.archivePinStore === "object");
check("导出 sortPinnedFirst", typeof test.sortPinnedFirst === "function");
check(
  "置顶存储键独立于收藏",
  test.ARCHIVE_PINNED_STORAGE_KEY === "dsham.pinnedSessions.v1" && test.ARCHIVE_PINNED_STORAGE_KEY !== test.ARCHIVE_FAVORITES_STORAGE_KEY,
  String(test.ARCHIVE_PINNED_STORAGE_KEY)
);
const pinStore = test.archivePinStore;
for (const sessionId of [...pinStore.getSnapshot()]) pinStore.toggle(sessionId);
check("起始置顶集合为空", pinStore.getSnapshot().length === 0, JSON.stringify(pinStore.getSnapshot()));
const pinInput = [{ id: "a" }, { id: "b" }, { id: "c" }];
check("空置顶集合返回原数组引用", test.sortPinnedFirst(pinInput) === pinInput);
check("undefined 输入容错", test.sortPinnedFirst(void 0) === void 0);
check("空数组容错", test.sortPinnedFirst([]).length === 0);
pinStore.toggle("b");
check("置顶项前置且其余保持原序", JSON.stringify(test.sortPinnedFirst(pinInput).map((item) => item.id)) === '["b","a","c"]', JSON.stringify(test.sortPinnedFirst(pinInput).map((item) => item.id)));
check("原数组未被就地修改", JSON.stringify(pinInput.map((item) => item.id)) === '["a","b","c"]', JSON.stringify(pinInput.map((item) => item.id)));
check("置顶已写入 localStorage", String(storage.get(test.ARCHIVE_PINNED_STORAGE_KEY)).includes("b"), String(storage.get(test.ARCHIVE_PINNED_STORAGE_KEY)));
let pinNotifications = 0;
const unsubscribePin = pinStore.subscribe(() => {
  pinNotifications += 1;
});
pinStore.toggle("c");
check("置顶变更通知订阅者", pinNotifications === 1, String(pinNotifications));
check("两个置顶项都在最前", JSON.stringify(test.sortPinnedFirst(pinInput).map((item) => item.id)) === '["b","c","a"]', JSON.stringify(test.sortPinnedFirst(pinInput).map((item) => item.id)));
unsubscribePin();
pinStore.prune(["b", "c"]);
check("prune 清空置顶", pinStore.getSnapshot().length === 0, JSON.stringify(pinStore.getSnapshot()));
check("取消置顶后恢复原序", JSON.stringify(test.sortPinnedFirst(pinInput).map((item) => item.id)) === '["a","b","c"]');
storage.set(test.ARCHIVE_PINNED_STORAGE_KEY, "{ not json");
check("损坏数据回退空数组", JSON.stringify(test.readPinnedSessionIds()) === "[]", JSON.stringify(test.readPinnedSessionIds()));

section("一句话 todo 摘要");
check("导出 todoDigestFromProjection", typeof test.todoDigestFromProjection === "function");
check("导出 todoDigestText", typeof test.todoDigestText === "function");
check("导出 archiveDigestStore", typeof test.archiveDigestStore === "object");
check(
  "摘要端点常量与宿主一致",
  test.SESSION_DIGEST_ENDPOINT === "/api/michengai/dsh-archive-manager/session-digest",
  String(test.SESSION_DIGEST_ENDPOINT)
);
check("摘要缓存键独立", test.ARCHIVE_DIGEST_STORAGE_KEY === "dsham.sessionDigests.v1", String(test.ARCHIVE_DIGEST_STORAGE_KEY));
const projectionFixture = [
  { content: "读取插件源码", status: "completed" },
  { content: "修复补丁锚点", status: "in_progress" },
  { content: "跑探针回归", status: "pending" }
];
const projectionDigest = test.todoDigestFromProjection(projectionFixture);
check(
  "投影摘要计数正确",
  projectionDigest.total === 3 && projectionDigest.done === 1 && projectionDigest.doing === 1 && projectionDigest.pending === 1,
  JSON.stringify(projectionDigest)
);
check("投影摘要优先取进行中项", projectionDigest.firstOpen === "修复补丁锚点", String(projectionDigest.firstOpen));
check("无投影返回 null", test.todoDigestFromProjection([]) === null && test.todoDigestFromProjection(void 0) === null);
check(
  "全部完成时回退最后一项",
  test.todoDigestFromProjection([{ content: "甲", status: "completed" }, { content: "乙", status: "completed" }]).firstOpen === "乙"
);
check("摘要文本：进行中", String(test.todoDigestText(projectionDigest, fakeT)).startsWith("digest.doing"), String(test.todoDigestText(projectionDigest, fakeT)));
check(
  "摘要文本：全待办",
  String(test.todoDigestText({ total: 2, done: 0, doing: 0, pending: 2, firstOpen: "甲" }, fakeT)).startsWith("digest.pending"),
  String(test.todoDigestText({ total: 2, done: 0, doing: 0, pending: 2, firstOpen: "甲" }, fakeT))
);
check(
  "摘要文本：全完成",
  String(test.todoDigestText({ total: 2, done: 2, doing: 0, pending: 0, firstOpen: "乙" }, fakeT)).startsWith("digest.done"),
  String(test.todoDigestText({ total: 2, done: 2, doing: 0, pending: 0, firstOpen: "乙" }, fakeT))
);
check("摘要文本：null/空清单返回 null", test.todoDigestText(null, fakeT) === null && test.todoDigestText({ total: 0 }, fakeT) === null);
check("超长任务名被截断", test.truncateDigestText("一二三四五六七八九十", 5).endsWith("…"), test.truncateDigestText("一二三四五六七八九十", 5));
check("任务名空白被压缩", test.truncateDigestText("  a\n\nb   c  ") === "a b c", test.truncateDigestText("  a\n\nb   c  "));
const digestStore = test.archiveDigestStore;
let digestNotifications = 0;
const unsubscribeDigest = digestStore.subscribe(() => {
  digestNotifications += 1;
});
digestStore.merge([{ sessionId: "d1", turnCount: 4, todo: projectionDigest }]);
check("merge 写入摘要", digestStore.get("d1")?.turnCount === 4 && digestStore.get("d1")?.todo?.total === 3, JSON.stringify(digestStore.get("d1")));
check("merge 触发订阅通知", digestNotifications === 1, String(digestNotifications));
check(
  "merge 持久化到 localStorage",
  String(storage.get(test.ARCHIVE_DIGEST_STORAGE_KEY)).includes("d1"),
  String(storage.get(test.ARCHIVE_DIGEST_STORAGE_KEY))
);
digestStore.merge([{ sessionId: "d1", turnCount: 4, todo: projectionDigest }]);
check("相同内容不重复通知", digestNotifications === 1, String(digestNotifications));
digestStore.merge([{ sessionId: "d2", turnCount: 0, todo: null }]);
check("todo 为 null 的条目也缓存（避免反复请求）", digestStore.get("d2") !== void 0 && digestStore.get("d2").todo === null);
digestStore.prune(["d1"]);
check("prune 移除指定条目", digestStore.get("d1") === void 0 && digestStore.get("d2") !== void 0);
unsubscribeDigest();
const nodeWithProjection = test.sessionNode(
  { id: "s9", displayTitle: "T", blank: false, running: false, updatedAt: 1, projectionValues: { todos: projectionFixture } },
  new Map(),
  new Set(),
  new Map()
);
check("会话节点透传 todo 投影", Array.isArray(nodeWithProjection.projectionValues?.todos), JSON.stringify(nodeWithProjection.projectionValues));

section("按对话轮次排序");
check("导出 requestArchivedTurnCounts", typeof test.requestArchivedTurnCounts === "function", typeof test.requestArchivedTurnCounts);
check(
  "轮次路由常量与宿主一致",
  test.TURN_COUNTS_ENDPOINT === "/api/michengai/dsh-archive-manager/archived-turn-counts",
  String(test.TURN_COUNTS_ENDPOINT)
);
const turnGroups = [
  {
    key: "w1",
    title: "Alpha",
    sessions: [
      { id: "s1", displayTitle: "a1", blank: false, updatedAt: 100 },
      { id: "s2", displayTitle: "a2", blank: false, updatedAt: 50 }
    ]
  },
  { key: "w2", title: "Beta", sessions: [{ id: "s3", displayTitle: "b1", blank: false, updatedAt: 200 }] }
];
const sortedTurns = test.sortArchivedGroups(turnGroups, "turns", {}, fakeT, { s1: 3, s2: 9, s3: 1 });
check(
  "组间按轮次降序",
  JSON.stringify(sortedTurns.map((group) => group.key)) === '["w1","w2"]',
  JSON.stringify(sortedTurns.map((group) => group.key))
);
check(
  "组内按轮次降序",
  JSON.stringify(sortedTurns[0].sessions.map((session) => session.id)) === '["s2","s1"]',
  JSON.stringify(sortedTurns[0].sessions.map((session) => session.id))
);
const sortedMissing = test.sortArchivedGroups(turnGroups, "turns", {}, fakeT, { s1: 7 });
check(
  "缺失轮次的会话排最后",
  JSON.stringify(sortedMissing[0].sessions.map((session) => session.id)) === '["s1","s2"]',
  JSON.stringify(sortedMissing[0].sessions.map((session) => session.id))
);
check("未提供轮次映射时不抛错", Array.isArray(test.sortArchivedGroups(turnGroups, "turns", {}, fakeT)));
const sortedUpdated = test.sortArchivedGroups(turnGroups, "updated", {}, fakeT, { s1: 3 });
const w1Updated = sortedUpdated.find((group) => group.key === "w1");
check(
  "其它排序方式不受轮次映射影响（仍按更新时间）",
  JSON.stringify(w1Updated.sessions.map((session) => session.id)) === '["s1","s2"]',
  JSON.stringify(w1Updated.sessions.map((session) => session.id))
);
check(
  "更新时间排序：组间按组内最新时间降序",
  JSON.stringify(sortedUpdated.map((group) => group.key)) === '["w2","w1"]',
  JSON.stringify(sortedUpdated.map((group) => group.key))
);

section("apply(ctx) 注册");
const injected = [];
const effectErrors = [];
const ctx = {
  get: () => void 0,
  effect: (fn) => {
    try {
      return fn();
    } catch (error) {
      effectErrors.push(String(error));
      return () => {};
    }
  },
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
  locale: { register: () => () => {}, bind: () => fakeT },
  slots: {
    inject: (name) => {
      injected.push(name);
      return () => {};
    },
    register: () => () => {},
    entries: () => [],
    subscribe: () => () => {}
  },
  sessions: {
    list: { getSnapshot: () => ({ byId: {}, current: void 0 }), subscribe: () => () => {} },
    refresh: async () => {},
    search: async () => ({ ok: true, value: [] }),
    searchResultLimit: 5,
    binding: () => void 0,
    open: () => {},
    fork: async () => "child"
  },
  workspaces: {
    list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => {} },
    startSession: () => {},
    create: () => {},
    rename: async () => {},
    delete: async () => {},
    insertBefore: async () => {},
    insertSessionBefore: async () => {},
    archiveSession: async () => {}
  }
};
let applyError;
try {
  await exports2.apply(ctx);
} catch (error) {
  applyError = error;
}
check("apply 执行无异常", applyError === void 0, applyError === void 0 ? "" : String(applyError));
check("注册 settings.section", injected.includes("settings.section"), JSON.stringify(injected));
check("注册 sidebar.workspaces", injected.includes("sidebar.workspaces"), JSON.stringify(injected));
check(
  "effect 内新增代码无异常",
  effectErrors.every((message) => !/favorite|copySession|archiveFavoriteStore|sessionPath/i.test(message)),
  effectErrors.join(" | ")
);

// ---------- 输出 ----------
let failed = 0;
const lines = [];
for (const item of results) {
  if (item.section !== void 0) {
    lines.push(`\n[${item.section}]`);
    continue;
  }
  if (item.ok !== true) failed += 1;
  lines.push(`  ${item.ok === true ? "PASS" : "FAIL"}  ${item.name}${item.detail === "" ? "" : `  → ${item.detail}`}`);
}
console.log(lines.join("\n"));
console.log(`\n合计：${results.filter((item) => item.section === void 0).length} 项断言，失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
