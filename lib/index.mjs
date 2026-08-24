import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/index.ts
/** Stable plugin name for the cordis row. */
const name = "dsh-timeline";
/** Services required before mounting: the web server routes and the trust list. */
const inject = ["webServer", "webRuntime"];
/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20;
/** Per-session full-history cache TTL (ms): fast repeat opens, short enough
*  that new messages surface within a few seconds. */
const HISTORY_CACHE_TTL = 5e3;
/** module-level cache: keyed by sessionId, shared across requests. */
const historyCache = /* @__PURE__ */ new Map();
/** Cache size cap: evict oldest-first so a long-lived server cannot grow the
*  map unboundedly across many sessions. */
const HISTORY_CACHE_MAX = 50;
/** Normalize a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return;
	}
}
/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether the request Host matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return (entryUrl.port === "" ? entryUrl.hostname : entryUrl.host) === hostUrl.host;
	});
}
/**
* Browser-trust fence, behaviorally identical to the /api gateway's fence
* (loopback Host header or a configured trusted authority; cross-site
* browser markers refuse). DNS-rebinding / cross-site defense, not
* authentication.
*/
function isTrustedApiRequest(req, trustedHosts) {
	const host = req.headers.host;
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	const fetchSite = req.headers["sec-fetch-site"];
	if (typeof fetchSite === "string" && fetchSite === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** Read and parse the JSON request body (bounded; malformed → null). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("malformed JSON body");
	}
}
/** Flatten one message's content blocks to a single preview string. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const b of content) if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	else if (b && b.type === "image") parts.push("[图片]");
	else if (b && b.type === "tool-call" && typeof b.name === "string") parts.push("[工具: " + b.name + "]");
	return parts.join(" ").replace(/\s+/g, " ").trim();
}
/** One API method dispatch: list every user-sent message in the full log. */
async function listUserMessages(ctx, payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") return {
		ok: false,
		error: "缺少 sessionId"
	};
	const cached = historyCache.get(sessionId);
	if (cached !== void 0 && Date.now() - cached.at < HISTORY_CACHE_TTL) return {
		ok: true,
		items: cached.items
	};
	const disk = readDiskCache("messages", sessionId);
	if (disk !== void 0) {
		storeHistoryCache(sessionId, disk.data);
		scheduleRefresh(ctx, "messages", sessionId, disk.at);
		return {
			ok: true,
			items: disk.data
		};
	}
	let events;
	try {
		events = await readSessionEvents(ctx, sessionId);
	} catch (err) {
		return {
			ok: false,
			error: String(err instanceof Error ? err.message : err)
		};
	}
	if (events === void 0) return {
		ok: false,
		error: "sessionQuery 服务不可用"
	};
	const items = collectUserMessages(events ?? []);
	storeHistoryCache(sessionId, items);
	writeDiskCache("messages", sessionId, items);
	return {
		ok: true,
		items
	};
}
/** Filter one event list down to human-sent user messages, seq-ascending. */
function collectUserMessages(events) {
	const items = [];
	for (const ev of events) {
		if (!ev || ev.type !== "user/message") continue;
		const source = ev.data?.source;
		if (!source || source.kind !== "user") continue;
		items.push({
			seq: typeof ev.seq === "number" ? ev.seq : 0,
			time: typeof ev.time === "number" ? ev.time : 0,
			text: textOf(ev.data?.content)
		});
	}
	items.sort((a, b) => a.seq - b.seq);
	return items;
}
/** Count non-text content blocks (images / attachments) in one message. */
function attachmentCount(content) {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const b of content) if (b && typeof b.type === "string" && b.type !== "text") n++;
	return n;
}
/**
* Build the interaction-turn list from one event log (spec F2): a new turn
* opens at every human `user/message`; a following `steering` user message
* joins the same turn; `assistant/message` text and `tool/call` events
* accumulate into the turn they fall inside. Seq-ascending output.
*/
function collectTurns(events) {
	const turns = [];
	let cur = null;
	for (const ev of events) {
		if (!ev || typeof ev.seq !== "number") continue;
		const kind = (ev.data?.source)?.kind;
		if (ev.type === "user/message") {
			if (kind === "user") {
				cur = {
					seq: ev.seq,
					time: typeof ev.time === "number" ? ev.time : 0,
					userText: textOf(ev.data?.content),
					userAttachments: attachmentCount(ev.data?.content),
					assistantText: "",
					toolCalls: 0
				};
				turns.push(cur);
				continue;
			}
			if (kind === "steering" && cur !== null) {
				const t = textOf(ev.data?.content);
				if (t !== "") cur.userText = cur.userText === "" ? t : `${cur.userText} ${t}`;
				continue;
			}
		}
		if (cur === null) continue;
		if (ev.type === "assistant/message") {
			const t = textOf(ev.data?.content);
			if (t !== "") cur.assistantText = cur.assistantText === "" ? t : `${cur.assistantText} ${t}`;
		} else if (ev.type === "assistant/chunk") {
			const chunk = ev.data?.chunk;
			if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") cur.assistantText += chunk.text;
		} else if (ev.type === "tool/call") cur.toolCalls += 1;
	}
	return turns;
}
/** Per-session turn-list cache (mirrors the user-message cache). */
const turnCache = /* @__PURE__ */ new Map();
const TURN_CACHE_TTL = 3e3;
const TURN_CACHE_MAX = 50;
/** 缓存根目录：~/.dsh/timeline-cache/（与 DSH 用户数据同层）。 */
const CACHE_ROOT = join(homedir(), ".dsh", "timeline-cache");
/** 同会话真实数据刷新的最小间隔：历史不会自己改动，无需高频。 */
const CACHE_REFRESH_GAP_MS = 15e3;
/** 启动温:逐会话生成缓存时的间隔，避免扫描风暴。 */
const WARMUP_STAGGER_MS = 500;
/** 停留刷新门限：会话被连续请求至少这么久才允许后台刷新（快速切换不折腾磁盘）。 */
const STAY_MIN_MS = 5e3;
/** 后台刷新单飞：正在刷新中的会话 id 集合。 */
const refreshJobs = /* @__PURE__ */ new Set();
/** 会话停留跟踪：since = 本轮停留起点，last = 上次请求；请求间隔 ≤ STAY_MIN_MS 视为连续停留。 */
const staySince = /* @__PURE__ */ new Map();
function digestOf(at, data) {
	return createHash("sha256").update(String(at)).update("").update(JSON.stringify(data)).digest("hex");
}
/** 缓存文件名安全化：sessionId 中的异常字符防路径逃逸。 */
function safeCacheName(id) {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
function diskCachePath(kind, id) {
	return join(CACHE_ROOT, `${kind}-${safeCacheName(id)}.json`);
}
/** 尽力删除文件（失败不阻塞调用方）。 */
function safelyUnlink(path) {
	try {
		rmSync(path, { force: true });
	} catch {}
}
/**
* 读磁盘缓存。不存在/解析失败/校验和不符均视为未命中；损坏文件当场删除，
* 由首次生成路径重建（应对外部篡改、截断、杀进程半写等不安全因素）。
*/
function readDiskCache(kind, id) {
	const path = diskCachePath(kind, id);
	try {
		if (!existsSync(path)) return void 0;
		const box = JSON.parse(readFileSync(path, "utf8"));
		if (typeof box.at !== "number" || !Array.isArray(box.data) || typeof box.sum !== "string") {
			safelyUnlink(path);
			return;
		}
		if (box.sum !== digestOf(box.at, box.data)) {
			safelyUnlink(path);
			return;
		}
		return {
			at: box.at,
			data: box.data
		};
	} catch {
		safelyUnlink(path);
		return;
	}
}
/**
* 写磁盘缓存，**写全、验完、再原子替换**：新内容先落临时文件，校验和读回验算
* 通过后才 rename 覆盖旧文件。进程在任一时刻中断，最多留下 .tmp-* 残留，
* 当前缓存文件要么是完整的旧版、要么是完整的新版，绝不半写。
*/
function writeDiskCache(kind, id, data) {
	try {
		mkdirSync(CACHE_ROOT, { recursive: true });
		const path = diskCachePath(kind, id);
		const tmp = join(CACHE_ROOT, `.tmp-${safeCacheName(id)}-${process.pid}-${Date.now()}`);
		const at = Date.now();
		const payload = JSON.stringify({
			at,
			data,
			sum: digestOf(at, data)
		});
		writeFileSync(tmp, payload, "utf8");
		const back = JSON.parse(readFileSync(tmp, "utf8"));
		if (back.sum !== digestOf(back.at, back.data)) throw new Error("cache verification failed");
		renameSync(tmp, path);
	} catch (err) {
		console.warn("[dsh-timeline] 缓存写入失败:", err);
	}
}
/** 启动清理：中断遗留的 .tmp-* 残留不影响读取，但一并扫掉保持目录干净。 */
function cleanStaleTmpFiles() {
	try {
		if (!existsSync(CACHE_ROOT)) return;
		for (const name of readdirSync(CACHE_ROOT)) if (name.startsWith(".tmp-")) safelyUnlink(join(CACHE_ROOT, name));
	} catch {}
}
/** 内存缓存写入（带容量上限的简单 FIFO 淘汰）。 */
function storeHistoryCache(sessionId, items) {
	if (historyCache.size >= HISTORY_CACHE_MAX) {
		const oldest = historyCache.keys().next().value;
		if (oldest !== void 0) historyCache.delete(oldest);
	}
	historyCache.set(sessionId, {
		at: Date.now(),
		items
	});
}
function storeTurnCache(sessionId, turns) {
	if (turnCache.size >= TURN_CACHE_MAX) {
		const oldest = turnCache.keys().next().value;
		if (oldest !== void 0) turnCache.delete(oldest);
	}
	turnCache.set(sessionId, {
		at: Date.now(),
		turns
	});
}
/** 读某会话的真实事件列表（live 内存优先、磁盘回退）；undefined = 无可用来源。 */
async function readSessionEvents(ctx, sessionId) {
	const liveEvents = ctx.get("sessions")?.get(sessionId)?.events;
	if (liveEvents !== void 0) return liveEvents;
	const sessionQuery = ctx.get("sessionQuery");
	if (sessionQuery === void 0) return void 0;
	const snapshot = await sessionQuery.readSession(sessionId);
	return snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
}
/** 后台渐进刷新：读真实数据 → 写盘 + 写内存缓存（单飞，失败静默待下轮）。 */
async function refreshSession(ctx, kind, sessionId) {
	let events;
	try {
		events = await readSessionEvents(ctx, sessionId);
	} catch {
		return;
	}
	if (events === void 0) return;
	if (kind === "turns") {
		const turns = collectTurns(events ?? []);
		writeDiskCache(kind, sessionId, turns);
		storeTurnCache(sessionId, turns);
	} else {
		const items = collectUserMessages(events ?? []);
		writeDiskCache(kind, sessionId, items);
		storeHistoryCache(sessionId, items);
	}
}
/**
* 调度一次后台刷新。三道闸：该会话停留 ≥ STAY_MIN_MS（快速切换不折腾磁盘）、
* 距上次真实数据 ≥ CACHE_REFRESH_GAP_MS、无在途任务（单飞）。
*/
function scheduleRefresh(ctx, kind, sessionId, lastAt) {
	const now = Date.now();
	const seen = staySince.get(sessionId);
	if (seen === void 0 || now - seen.last > STAY_MIN_MS) {
		staySince.set(sessionId, {
			since: now,
			last: now
		});
		if (staySince.size > 200) {
			const oldest = staySince.keys().next().value;
			if (oldest !== void 0) staySince.delete(oldest);
		}
		return;
	}
	seen.last = now;
	if (now - seen.since < STAY_MIN_MS) return;
	if (now - lastAt < CACHE_REFRESH_GAP_MS) return;
	if (refreshJobs.has(sessionId)) return;
	refreshJobs.add(sessionId);
	refreshSession(ctx, kind, sessionId).catch(() => {}).finally(() => {
		refreshJobs.delete(sessionId);
	});
}
/**
* 启动预热：扫描 DSH 会话目录（~/.dsh/sessions/<workspace>/<sessionId>/），
* 对还没有磁盘缓存的会话逐个后台生成（一次 500ms 节流）；目录形态变化时
* 静默跳过，不影响正常请求路径。
*/
async function warmUpCache(ctx) {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	await sleep(2e3);
	cleanStaleTmpFiles();
	const root = join(homedir(), ".dsh", "sessions");
	let dirs = [];
	try {
		const workspaces = existsSync(root) ? readdirSync(root) : [];
		for (const workspace of workspaces) try {
			dirs.push(...readdirSync(join(root, workspace)));
		} catch {}
	} catch (err) {
		console.warn("[dsh-timeline] 会话目录扫描失败:", err);
		return;
	}
	let built = 0;
	for (const name of dirs) {
		if (built >= 300) return;
		const candidates = [name, name.replace(/^session-/, "")];
		for (const id of candidates) {
			if (id === "" || built >= 300) continue;
			if (readDiskCache("turns", id) !== void 0) break;
			if (refreshJobs.has(id)) break;
			refreshJobs.add(id);
			refreshSession(ctx, "turns", id).catch(() => {}).finally(() => {
				refreshJobs.delete(id);
			});
			built++;
			await sleep(WARMUP_STAGGER_MS);
			break;
		}
	}
	console.log(`[dsh-timeline] 启动预热完成：本次生成 ${built} 个轮次缓存`);
}
/** One API method dispatch: full turn list for the timeline (spec F2-F5). */
async function listTurns(ctx, payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") return {
		ok: false,
		error: "缺少 sessionId"
	};
	const cached = turnCache.get(sessionId);
	if (cached !== void 0 && Date.now() - cached.at < TURN_CACHE_TTL) return {
		ok: true,
		turns: cached.turns,
		total: cached.turns.length
	};
	const disk = readDiskCache("turns", sessionId);
	if (disk !== void 0) {
		storeTurnCache(sessionId, disk.data);
		scheduleRefresh(ctx, "turns", sessionId, disk.at);
		return {
			ok: true,
			turns: disk.data,
			total: disk.data.length
		};
	}
	let events;
	try {
		events = await readSessionEvents(ctx, sessionId);
	} catch (err) {
		return {
			ok: false,
			error: String(err instanceof Error ? err.message : err)
		};
	}
	if (events === void 0) return {
		ok: false,
		error: "sessionQuery 服务不可用"
	};
	const turns = collectTurns(events ?? []);
	storeTurnCache(sessionId, turns);
	writeDiskCache("turns", sessionId, turns);
	return {
		ok: true,
		turns,
		total: turns.length
	};
}
/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(text);
}
/**
* Plugin body: mount the fenced /history/api route.
* @param ctx - host plugin context (webServer, webRuntime).
*/
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/history/api",
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden"
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith("/history/api/") ? pathname.slice(13) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeJson(res, 404, {
					ok: false,
					error: "unknown history API method"
				});
				return;
			}
			if (method === "list-user-messages") {
				try {
					const result = await listUserMessages(ctx, await readJsonBody(req));
					writeJson(res, result.ok ? 200 : 400, result);
				} catch (err) {
					writeJson(res, 400, {
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				return;
			}
			if (method === "list-turns") {
				try {
					const result = await listTurns(ctx, await readJsonBody(req));
					writeJson(res, result.ok ? 200 : 400, result);
				} catch (err) {
					writeJson(res, 400, {
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				return;
			}
			writeJson(res, 404, {
				ok: false,
				error: `unknown history API method "${method}"`
			});
		}
	}), "dsh-timeline: /history/api route");
	warmUpCache(ctx);
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.mjs.map