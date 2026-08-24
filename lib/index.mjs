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
	const liveEvents = ctx.get("sessions")?.get(sessionId)?.events;
	if (liveEvents !== void 0) {
		const items = collectUserMessages(liveEvents);
		if (historyCache.size >= HISTORY_CACHE_MAX) {
			const oldest = historyCache.keys().next().value;
			if (oldest !== void 0) historyCache.delete(oldest);
		}
		historyCache.set(sessionId, {
			at: Date.now(),
			items
		});
		return {
			ok: true,
			items
		};
	}
	const sessionQuery = ctx.get("sessionQuery");
	if (sessionQuery === void 0) return {
		ok: false,
		error: "sessionQuery 服务不可用"
	};
	try {
		const snapshot = await sessionQuery.readSession(sessionId);
		const items = collectUserMessages(snapshot && Array.isArray(snapshot.events) ? snapshot.events : []);
		if (historyCache.size >= HISTORY_CACHE_MAX) {
			const oldest = historyCache.keys().next().value;
			if (oldest !== void 0) historyCache.delete(oldest);
		}
		historyCache.set(sessionId, {
			at: Date.now(),
			items
		});
		return {
			ok: true,
			items
		};
	} catch (err) {
		return {
			ok: false,
			error: String(err instanceof Error ? err.message : err)
		};
	}
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
	let events;
	events = ctx.get("sessions")?.get(sessionId)?.events;
	if (events === void 0) {
		const sessionQuery = ctx.get("sessionQuery");
		if (sessionQuery === void 0) return {
			ok: false,
			error: "sessionQuery 服务不可用"
		};
		try {
			const snapshot = await sessionQuery.readSession(sessionId);
			events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
		} catch (err) {
			return {
				ok: false,
				error: String(err instanceof Error ? err.message : err)
			};
		}
	}
	const turns = collectTurns(events ?? []);
	if (turnCache.size >= TURN_CACHE_MAX) {
		const oldest = turnCache.keys().next().value;
		if (oldest !== void 0) turnCache.delete(oldest);
	}
	turnCache.set(sessionId, {
		at: Date.now(),
		turns
	});
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
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.mjs.map