window.__ModuleLoader__.load({
	id: "dsh-timeline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/util.ts
		/** Truncate a string to at most `max` code units with an ellipsis. */
		function truncate(text, max) {
			if (!text) return "";
			if (text.length <= max) return text;
			return `${text.slice(0, max)}…`;
		}
		/** Clamp a number into [min, max]. */
		function clamp(n, min, max) {
			return n < min ? min : n > max ? max : n;
		}
		/** Find the nearest overflow-y scroll ancestor of an element (the message
		*  viewport for rows inside the conversation). Pass `includeSelf` to also
		*  accept the element itself when it is the scrollport. */
		function findScrollPort(el, includeSelf = false) {
			let node = includeSelf ? el : el.parentElement;
			while (node !== null) {
				const overflow = getComputedStyle(node).overflowY;
				if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return node;
				node = node.parentElement;
			}
			return null;
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
		/** Format a Unix epoch ms timestamp: same-day → HH:mm; else YYYY-MM-DD HH:mm. */
		function fmtTime(ms) {
			if (!ms || typeof ms !== "number") return "";
			try {
				const d = new Date(ms);
				const now = /* @__PURE__ */ new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
				const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
				if (sameDay) return time;
				return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
			} catch {
				return "";
			}
		}
		/** Collect the user/steering messages in the loaded window + seq→key map. */
		function collectWindowItems(session) {
			const items = [];
			const keys = /* @__PURE__ */ new Map();
			if (!session || !session.chat || !session.chat.nodes) return {
				items,
				keys
			};
			let nodes = [];
			try {
				nodes = session.chat.nodes.values();
			} catch {
				nodes = [];
			}
			for (const node of nodes) {
				if (!node) continue;
				if (node.kind !== "user" && node.kind !== "steering") continue;
				if (node.visibility === "hidden") continue;
				const data = node.data || {};
				const seq = typeof node.anchorSeq === "number" ? node.anchorSeq : typeof data.seq === "number" ? data.seq : 0;
				if (typeof node.key === "string" && node.key) keys.set(seq, node.key);
				items.push({
					seq,
					time: typeof data.time === "number" ? data.time : 0,
					text: textOf(data.content),
					key: typeof node.key === "string" ? node.key : null
				});
			}
			items.sort((a, b) => a.seq - b.seq);
			return {
				items,
				keys
			};
		}
		/** Find the conversation row DOM element for a chat-node anchor key. */
		function findAnchor(key) {
			if (typeof document === "undefined") return null;
			const rows = document.querySelectorAll("[data-chat-anchor-key]");
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				if (row && row.dataset && row.dataset.chatAnchorKey === key) return row;
			}
			return null;
		}
		/** Scroll the scrollport to a target scrollTop over a short animation.
		*  rAF-driven so the speed is deterministic and independent of the host's
		*  `scroll-behavior` CSS; the jump must stay fast (≈200ms) yet visible.
		*  Returns false when the target equals the current position. */
		function animateScroll(port, target, duration = 200) {
			if (Math.abs(target - port.scrollTop) < 1) return false;
			const start = port.scrollTop;
			const delta = target - start;
			const t0 = performance.now();
			const ease = (t) => 1 - Math.pow(1 - t, 3);
			const step = (now) => {
				const p = Math.min(1, (now - t0) / duration);
				port.scrollTop = start + delta * ease(p);
				if (p < 1) requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
			return true;
		}
		/** Drive the scrollport partway toward `target` while older history is still
		*  loading.  Clicking an unloaded turn scrolls up now so the motion starts
		*  immediately; each `loadOlder` page prepends above the top, so pinning
		*  toward the top keeps every newly loaded page entering the viewport and
		*  the view approaches the target before the exact jump lands.  Returns a
		*  cancel callback (the precise landing jump should stop this motion first,
		*  otherwise both rAF loops would fight over scrollTop). */
		function chaseScroll(port, target, duration = 750) {
			if (Math.abs(target - port.scrollTop) < 1) return () => {};
			let raf = 0;
			const start = port.scrollTop;
			const delta = target - start;
			const t0 = performance.now();
			const ease = (t) => 1 - Math.pow(1 - t, 3);
			const step = (now) => {
				const p = Math.min(1, (now - t0) / duration);
				port.scrollTop = start + delta * ease(p);
				if (p < 1) raf = requestAnimationFrame(step);
			};
			raf = requestAnimationFrame(step);
			return () => cancelAnimationFrame(raf);
		}
		/** Scroll a message row into view (top-aligned) and flash-highlight it.
		*  Positions the conversation scrollport directly with a short animated
		*  scroll (see animateScroll), rather than relying on async scrollIntoView
		*  which can silently no-op. */
		function scrollToKey(key) {
			const el = findAnchor(key);
			if (!el) return false;
			try {
				el.classList.remove("dshm-flash");
				el.offsetWidth;
				el.classList.add("dshm-flash");
				el.addEventListener("animationend", () => el.classList.remove("dshm-flash"), { once: true });
				let port = null;
				let node = el.parentElement;
				while (node !== null) {
					const overflow = getComputedStyle(node).overflowY;
					if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
						port = node;
						break;
					}
					node = node.parentElement;
				}
				if (port !== null) {
					const elRect = el.getBoundingClientRect();
					const portRect = port.getBoundingClientRect();
					const target = port.scrollTop + elRect.top - portRect.top;
					return animateScroll(port, target);
				}
				try {
					el.scrollIntoView({
						behavior: "smooth",
						block: "start"
					});
				} catch {
					return false;
				}
				return true;
			} catch {
				return false;
			}
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-timeline client half: the interaction-turn timeline rail on the right
		* edge of the message area (spec F2-F5). One short tick per turn; the
		* active turn is highlighted and centered, clamped at the ends.
		*
		* Reuses DSH-native interfaces where possible:
		* - `conversation.input.dock` slot for the entry point;
		* - the product's `data-chat-anchor-key` semantic anchor + `session.loadOlder()`
		*   for jump/auto-load (see util.ts).
		* Pure helpers live in ./util.ts; this file only renders and manages state.
		*/
		/** ------------------------------------------------------------------ styles */
		/** Inject the plugin stylesheet once per activation (removed on disposal). */
		function injectStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector("style[data-plugin-css=\"dsh-timeline/styles\"]") !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-timeline";
			tag.dataset.pluginCss = "dsh-timeline/styles";
			tag.textContent = TIMELINE_CSS;
			document.head.appendChild(tag);
			return () => {
				if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
			};
		}
		/** ------------------------------------------------------------------ timeline */
		/**
		* 交互时间线 (spec F2-F5): 消息区右缘的轮次刻度轨道。
		* - 一根线 = 用户发出一次消息 (一个轮次); 最新轮次在底部 (正序)。
		* - 胶片式视口: 固定高度容器（约 10 根线的容量），线条在容器内做像素级
		*   translateY 滑动, 超出视口的线条以渐变淡出 —— 滚轮滚动时能看到线条
		*   连续经过视口, 而不是整窗跳格。
		* - 当前视口最近的轮次高亮为蓝色; 历史为白色。
		* - 悬停: tooltip 预览 (第 N 轮 / 时间 / 用户消息 / 回复 + 工具数), 自动翻转防溢出。
		* - 点击: 滚动到该轮用户消息, 线条短暂高亮。
		* - 滚轮: 悬停轨道时连续滚动线条胶片; 移开后不自动回弹, 保持当前偏移。
		*/
		const TIMELINE_CSS = `
.dsht_root{position:fixed;z-index:9980;pointer-events:auto;user-select:none;-webkit-font-smoothing:antialiased}
.dsht_view{position:relative;height:180px;width:64px;overflow:hidden;pointer-events:auto;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,rgba(0,0,0,.85) 12%,#000 30%,#000 70%,rgba(0,0,0,.85) 88%,transparent 100%);
  mask-image:linear-gradient(to bottom,transparent 0,rgba(0,0,0,.85) 12%,#000 30%,#000 70%,rgba(0,0,0,.85) 88%,transparent 100%)}
.dsht_strip{position:absolute;left:0;right:0;top:0;will-change:transform}
.dsht_line{position:absolute;right:0;display:flex;align-items:center;justify-content:flex-end;cursor:pointer;width:34px;height:3px;pointer-events:auto;top:0}
.dsht_bar{height:3px;border-radius:3px;background:var(--dsw-alias-label-caption, rgba(120,130,150,.55));opacity:.45;transform-origin:100% 50%;
  transition:background .15s ease,opacity .15s ease,width .18s cubic-bezier(.22,.61,.36,1),box-shadow .15s ease}
.dsht_line:hover .dsht_bar{opacity:.9}
.dsht_active .dsht_bar{background:var(--dsw-alias-state-business-primary, #3b82f6);opacity:1;box-shadow:0 0 6px var(--dsw-alias-state-business-primary, #3b82f6)}
.dsht_flash .dsht_bar{animation:dshtFlashBar 1.6s ease-out}
@keyframes dshtFlashBar{0%,30%{background:var(--dsw-alias-state-business-primary, #3b82f6);opacity:1;box-shadow:0 0 10px var(--dsw-alias-state-business-primary, #3b82f6)}100%{opacity:.45;box-shadow:none}}
/* 跳转落地闪烁（src/client/util.ts scrollToKey 的 dshm-flash 类）：消息行软色块脉冲，由 animationend 清理。 */
.dshm-flash{animation:dshmRowFlash 1.1s ease-out}
@keyframes dshmRowFlash{0%,35%{background:rgba(59,130,246,.18);box-shadow:inset 0 0 0 1px rgba(59,130,246,.35)}100%{background:rgba(59,130,246,0);box-shadow:none}}
/* 首载骨架：会话切换后、轮次数据到达前的半透明占位刻度，微光呼吸。 */
.dsht_skelRow{pointer-events:none;cursor:default}
.dsht_skelRow .dsht_bar{opacity:.3;animation:dshtSkel 1.2s ease-in-out infinite alternate}
@keyframes dshtSkel{from{opacity:.22}to{opacity:.7}}
/* 配色全部走宿主主题变量（--dsw-alias-*）：手动切换主题/跟随系统自动黑暗/第三方皮肤时
   由主题运行时统一更新，tooltip 零 JS 干预即时跟随、与页面其余部分同源。 */
.dsht_tip{position:fixed;z-index:9999;max-width:min(340px,calc(100vw - 24px));border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.55;
  background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92));-webkit-backdrop-filter:blur(16px) saturate(1.4);backdrop-filter:blur(16px) saturate(1.4);
  border:1px solid var(--dsw-alias-border-l1, rgba(120,130,150,.28));box-shadow:0 10px 32px rgba(0,0,0,.14);color:var(--dsw-alias-label-primary, #1f2937);pointer-events:none}
.dsht_tipHead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:5px}
.dsht_tipSeq{font-size:12px;font-weight:700}
.dsht_tipTime{font-size:11px;color:var(--dsw-alias-label-secondary, rgba(31,41,55,.6));font-variant-numeric:tabular-nums}
.dsht_tipLabel{font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary, rgba(31,41,55,.55));margin:6px 0 2px;letter-spacing:.04em}
.dsht_tipBody{white-space:pre-wrap;word-break:break-word;opacity:.92}
.dsht_tipMeta{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary, rgba(31,41,55,.8))}
`;
		/** Timeline overlay: the right-edge turn-rail (spec F2-F5). */
		function TimelineOverlay(props) {
			const session = props.session;
			const sessionId = session?.sessionId;
			const [turns, setTurns] = (0, react.useState)([]);
			/** 当前会话是否已成功拿到过一轮次响应（区分"首载中"与"该会话确实无轮次"）。 */
			const [loaded, setLoaded] = (0, react.useState)(false);
			/** 上次重置加载标记的会话：仅真正的会话切换才重置，快照变化不重置。 */
			const loadedSessionRef = (0, react.useRef)(null);
			/** 胶片在视口内的像素偏移：0 = 最旧对齐视口顶，maxOff = 最新贴底。 */
			const [off, setOff] = (0, react.useState)(0);
			const [activeSeq, setActiveSeq] = (0, react.useState)(null);
			const [flashSeq, setFlashSeq] = (0, react.useState)(null);
			/** 点击跳到未加载轮次时的"追逐"状态：持续 loadOlder 直到目标轮次进入已加载窗口。 */
			const [chase, setChase] = (0, react.useState)(null);
			const chaseRef = (0, react.useRef)(chase);
			chaseRef.current = chase;
			/** 追逐加载期间的滚动动画句柄：落地精确跳转前先取消，避免两个 rAF 循环抢 scrollTop。 */
			const chaseAnimRef = (0, react.useRef)(null);
			const [pos, setPos] = (0, react.useState)(null);
			const rootRef = (0, react.useRef)(null);
			const portRef = (0, react.useRef)(null);
			const offRef = (0, react.useRef)(off);
			offRef.current = off;
			const turnsRef = (0, react.useRef)(turns);
			turnsRef.current = turns;
			const domTurnRef = (0, react.useRef)(/* @__PURE__ */ new Map());
			const LINE_STEP = 18;
			const VIEW_H = 180;
			const LINE_W = 17;
			const MAX_EXT = 30;
			const VIEW_W = 47;
			const EXT_RADIUS = 3;
			const HEXT_RADIUS = 30;
			const EXT_PHASE = 1.35;
			const HOVER_KEEP_RANGE = 100;
			/** 首载未完成前快速轮询，拿到底后降为常规周期（host 侧 3s TTL 缓存）。 */
			const POLL_FAST_MS = 1e3;
			const POLL_MS = 3e3;
			/** 首载骨架占位刻度条数。 */
			const SKELETON_BARS = 5;
			const WHEEL_HOLD_MS = 1200;
			const HOVER_LEAVE_MS = 400;
			const BUFFER = 2;
			const CHASE_MAX_LOADS = 24;
			/** 胶片滑动目标偏移 + 惯性动画的 rAF 句柄（滚轮与"跟随 active"共用）。 */
			const targetRef = (0, react.useRef)(0);
			const glideRafRef = (0, react.useRef)(0);
			const keys = (0, react.useMemo)(() => collectWindowItems(session).keys, [session]);
			const seqByKey = (0, react.useMemo)(() => {
				const m = /* @__PURE__ */ new Map();
				for (const [seq, key] of keys) if (key !== null) m.set(key, seq);
				return m;
			}, [keys]);
			(0, react.useEffect)(() => {
				if (sessionId === void 0) return;
				if (sessionId !== loadedSessionRef.current) {
					loadedSessionRef.current = sessionId;
					setLoaded(false);
				}
				let cancelled = false;
				setActiveSeq(null);
				setOff(0);
				targetRef.current = 0;
				const load = () => {
					fetch("/history/api/list-turns", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: String(sessionId) }),
						cache: "no-store"
					}).then((res) => res.ok ? res.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${res.status}`))).then((data) => {
						if (cancelled) return;
						const record = data;
						if (record && record.ok === true && Array.isArray(record.turns)) {
							setLoaded(true);
							const next = record.turns;
							if (next.length > 0) setActiveSeq((prev) => prev !== null && next.some((t) => t.seq === prev) ? prev : next[next.length - 1].seq);
							setTurns(next);
						}
					}).catch(() => {});
				};
				load();
				const timer = setInterval(load, loaded ? POLL_MS : POLL_FAST_MS);
				const detect = setInterval(() => {
					const port = portRef.current;
					if (port !== null) {
						if (port.getBoundingClientRect().height > 0 && port.querySelector("[data-chat-anchor-key]") !== null) requestAnimationFrame(() => {
							const evt = new Event("scroll");
							port.dispatchEvent(evt);
						});
					}
				}, 1e3);
				return () => {
					cancelled = true;
					clearInterval(timer);
					clearInterval(detect);
				};
			}, [
				sessionId,
				seqByKey,
				loaded
			]);
			(0, react.useEffect)(() => {
				const el = rootRef.current;
				if (!el) return;
				let raf = 0;
				let bound = null;
				const resolvePort = () => {
					const row = document.querySelector("[data-chat-anchor-key]");
					if (row !== null) {
						const p = findScrollPort(row);
						if (p !== null) return p;
					}
					const seat = document.querySelector("[data-composer-seat]");
					if (seat !== null && seat.parentElement !== null) {
						const p = findScrollPort(seat.parentElement, true);
						if (p !== null) return p;
					}
					return null;
				};
				const onScroll = () => {
					cancelAnimationFrame(raf);
					raf = requestAnimationFrame(() => {
						const port = portRef.current;
						if (port === null) return;
						const turnsList = turnsRef.current;
						if (turnsList.length === 0) return;
						const rect = port.getBoundingClientRect();
						if (rect.height === 0) return;
						const center = rect.top + rect.height * .42;
						let bestSeq = null;
						let bestDist = Infinity;
						const domTurn = domTurnRef.current;
						const rows = port.querySelectorAll("[data-chat-anchor-key]");
						for (let i = 0; i < rows.length; i++) {
							const r = rows[i];
							if (r === null) continue;
							const key = r.dataset.chatAnchorKey;
							if (typeof key !== "string" || key === "") continue;
							const seq = seqByKey.get(key);
							if (seq === void 0) continue;
							const tIdx = turnsList.findIndex((t) => t.seq === seq);
							if (tIdx === -1) continue;
							if (!domTurn.has(tIdx)) domTurn.set(tIdx, key);
							const rr = r.getBoundingClientRect();
							const inView = rr.bottom > rect.top && rr.top < rect.bottom;
							const dist = Math.abs(rr.top + rr.height / 2 - center) + (inView ? 0 : 1e6);
							if (dist < bestDist) {
								bestDist = dist;
								bestSeq = seq;
							}
						}
						if (bestSeq !== null) setActiveSeq((prev) => prev === bestSeq ? prev : bestSeq);
					});
				};
				const update = () => {
					const portNew = resolvePort();
					if (portNew !== bound) {
						if (bound !== null) bound.removeEventListener("scroll", onScroll);
						bound = portNew;
						portRef.current = portNew;
						if (portNew !== null) {
							portNew.addEventListener("scroll", onScroll, { passive: true });
							ro?.observe(portNew);
						}
					}
					const r = (portNew ?? el.parentElement ?? el).getBoundingClientRect();
					const right = Math.max(4, window.innerWidth - r.right + 6);
					const top = Math.max(4, r.top + r.height / 2);
					setPos((prev) => prev && prev.top === top && prev.right === right ? prev : {
						top,
						right
					});
					if (portNew !== null && portRef.current === portNew) onScroll();
				};
				const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
				ro?.observe(el.parentElement ?? el);
				window.addEventListener("resize", update);
				const timer = setInterval(update, 1e3);
				update();
				return () => {
					ro?.disconnect();
					clearInterval(timer);
					window.removeEventListener("resize", update);
					if (bound !== null) bound.removeEventListener("scroll", onScroll);
					cancelAnimationFrame(raf);
				};
			}, [seqByKey]);
			const count = turns.length;
			/** 首载期：会话刚切换、还没拿到过成功的轮次响应 → 显示骨架占位轨道。 */
			const loading = count === 0 && !loaded;
			const maxOff = Math.max(0, count * LINE_STEP - VIEW_H);
			const lastIdxAll = Math.max(0, count - 1);
			const firstIdx = clamp(Math.floor(off / LINE_STEP) - BUFFER, 0, lastIdxAll);
			const lastIdx = clamp(Math.ceil((off + VIEW_H) / LINE_STEP) + BUFFER - 1, 0, lastIdxAll);
			const activeIdx = activeSeq === null ? -1 : turns.findIndex((t) => t.seq === activeSeq);
			const activeInWindow = activeIdx >= firstIdx && activeIdx <= lastIdx;
			const glide = () => {
				const cur = offRef.current;
				const target = clamp(targetRef.current, 0, Math.max(0, turnsRef.current.length * LINE_STEP - VIEW_H));
				if (Math.abs(target - cur) < .5) {
					if (cur !== target) setOff(target);
					glideRafRef.current = 0;
					return;
				}
				const next = cur + (target - cur) * .3;
				setOff(next);
				glideRafRef.current = requestAnimationFrame(glide);
			};
			const glideTo = (target) => {
				targetRef.current = target;
				if (glideRafRef.current === 0) glideRafRef.current = requestAnimationFrame(glide);
			};
			(0, react.useEffect)(() => {
				const follow = () => {
					if (performance.now() - wheelAtRef.current < WHEEL_HOLD_MS) return;
					if (hoverZoneRef.current) return;
					if (performance.now() - leaveAtRef.current < HOVER_LEAVE_MS) return;
					const list = turnsRef.current;
					if (list.length === 0 || activeSeq === null) return;
					const idx = list.findIndex((t) => t.seq === activeSeq);
					if (idx === -1) return;
					const cur = offRef.current;
					const lineTop = idx * LINE_STEP;
					if (lineTop >= cur - 36 && lineTop < cur + VIEW_H + 36) return;
					glideTo(clamp(idx * LINE_STEP - VIEW_H * .42, 0, Math.max(0, list.length * LINE_STEP - VIEW_H)));
				};
				follow();
				const timer = setInterval(follow, 600);
				return () => clearInterval(timer);
			}, [activeSeq, count]);
			const handleWheel = (e) => {
				e.preventDefault();
				wheelAtRef.current = performance.now();
				const delta = e.deltaY * .25;
				if (Math.abs(delta) < 2) return;
				glideTo(clamp(offRef.current + delta, 0, maxOff));
			};
			const flashTurn = (turn) => {
				setFlashSeq(turn.seq);
				if (typeof props.timeout === "function") props.timeout(() => setFlashSeq((cur) => cur === turn.seq ? null : cur), 1700);
				else setTimeout(() => setFlashSeq((cur) => cur === turn.seq ? null : cur), 1700);
			};
			/** 点击“未加载”轮次：不等加载完成 —— 立即给反馈。闪烁所点线条（纯线条
			*  脉冲，不移动窗口），同时马上向顶部方向滚动（更早历史从内容顶部前置
			*  进来，scrollTop 锁定在顶部附近时每一页新拉到的轮次都会顶上视口，加载
			*  完差不多已就位），再启动追逐加载；落地后由 chase effect 做最后的精确
			*  对齐。特意不把 activeSeq 直接设到目标上：那会让轨道窗口先行“自动对齐”
			*  到所点轮次再弹回，页面滚动时时间线反而不像在连续滚动。 */
			const startChase = (turn) => {
				flashTurn(turn);
				const port = portRef.current;
				if (port !== null && port.getBoundingClientRect().height > 0) {
					chaseAnimRef.current?.();
					chaseAnimRef.current = chaseScroll(port, 0);
				}
				setChase({
					seq: turn.seq,
					loads: 1
				});
			};
			const jumpToTurn = (turn) => {
				const idx = turnsRef.current.findIndex((t) => t.seq === turn.seq);
				const key = keys.get(turn.seq) ?? domTurnRef.current.get(idx);
				if (key === null || key === void 0) {
					startChase(turn);
					return;
				}
				if (findAnchor(key) !== null) scrollToKey(key);
				flashTurn(turn);
			};
			(0, react.useEffect)(() => {
				if (chase === null) return;
				const turn = turnsRef.current.find((t) => t.seq === chase.seq);
				if (turn === void 0) {
					setChase(null);
					return;
				}
				const key = keys.get(turn.seq);
				if (key !== void 0) {
					chaseAnimRef.current?.();
					chaseAnimRef.current = null;
					setChase(null);
					if (findAnchor(key) !== null) scrollToKey(key);
					flashTurn(turn);
					return;
				}
				if (typeof props.loadOlderFor !== "function" || props.session?.hasMore !== true) {
					setChase(null);
					return;
				}
				if (props.session?.loadingOlder === true) return;
				if (chase.loads >= CHASE_MAX_LOADS) {
					setChase(null);
					return;
				}
				props.loadOlderFor(String(sessionId)).catch(() => {});
				setChase({
					seq: chase.seq,
					loads: chase.loads + 1
				});
			}, [
				chase,
				keys,
				session
			]);
			/** 光标视口相对 y（在轨道内/保护区内时有效，-1 表示不在保护区）。 */
			const cursorYRef = (0, react.useRef)(-1);
			/** 光标屏幕 x：水平距离分量，驱动悬停中心线的延长量（见 extOf）。 */
			const hoverXRef = (0, react.useRef)(-1);
			/** 光标是否处于「轨道内或 HOVER_KEEP_RANGE 保护区」中。 */
			const hoverZoneRef = (0, react.useRef)(false);
			/** 滚轮滚轨道时的最近时间戳：跟随回弹让位给用户（见 WHEEL_HOLD_MS 抑制）。 */
			const wheelAtRef = (0, react.useRef)(0);
			/** 离开保护区的时间戳：移开鼠标后等待几百毫秒才允许回弹。 */
			const leaveAtRef = (0, react.useRef)(0);
			const viewElRef = (0, react.useRef)(null);
			const [hoverTick, setHoverTick] = (0, react.useState)(0);
			const zoneOf = (e) => {
				const el = viewElRef.current;
				if (el === null) return "out";
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return "out";
				if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return "in";
				if (e.clientX >= rect.left - HOVER_KEEP_RANGE && e.clientX <= rect.right && e.clientY >= rect.top - HOVER_KEEP_RANGE && e.clientY <= rect.bottom + HOVER_KEEP_RANGE) return "near";
				return "out";
			};
			(0, react.useEffect)(() => {
				const onMove = (e) => {
					if (zoneOf(e) === "out") {
						if (hoverZoneRef.current) leaveAtRef.current = performance.now();
						hoverZoneRef.current = false;
						setHoverTick((t) => t + 1);
						return;
					}
					const el = viewElRef.current;
					if (el !== null) {
						const rect = el.getBoundingClientRect();
						cursorYRef.current = rect.height > 0 ? Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top)) : -1;
					}
					hoverXRef.current = e.clientX;
					hoverZoneRef.current = true;
					setHoverTick((t) => t + 1);
				};
				document.addEventListener("mousemove", onMove);
				return () => document.removeEventListener("mousemove", onMove);
			}, []);
			const hoveredIndex = hoverZoneRef.current && cursorYRef.current >= 0 ? clamp(Math.round((cursorYRef.current - 5 + off) / LINE_STEP), 0, Math.max(0, count - 1)) : null;
			const railRightX = pos === null ? -1 : window.innerWidth - pos.right;
			const midX = railRightX - LINE_W / 2;
			const extAmp = (u) => {
				if (u <= 0) return 0;
				if (u >= 1) return 1;
				return Math.tan(EXT_PHASE * u) / Math.tan(EXT_PHASE);
			};
			const extOf = (idx) => {
				if (hoveredIndex === null || railRightX < 0) return 0;
				const d = Math.abs(idx - hoveredIndex);
				if (d > EXT_RADIUS) return 0;
				const hx = hoverXRef.current;
				const hd = hx < 0 ? 0 : Math.abs(hx - midX);
				const u = (HEXT_RADIUS - hd) / 10;
				return (1 - d / EXT_RADIUS) ** 2 * MAX_EXT * extAmp(u);
			};
			const lineNodes = [];
			if (loading) for (let i = 0; i < SKELETON_BARS; i++) lineNodes.push((0, react.createElement)("div", {
				key: `skel${i}`,
				className: "dsht_line dsht_skelRow",
				style: {
					top: `${i * LINE_STEP + 5}px`,
					width: `${LINE_W}px`
				},
				"aria-hidden": "true"
			}, (0, react.createElement)("span", { className: "dsht_bar dsht_skel" })));
			for (let idx = firstIdx; idx <= lastIdx; idx++) {
				const turn = turns[idx];
				if (turn === void 0) continue;
				const isActive = activeIdx === idx;
				const isFlash = flashSeq === turn.seq;
				lineNodes.push((0, react.createElement)("div", {
					key: `t${turn.seq}`,
					className: `dsht_line${isActive ? " dsht_active" : ""}${isFlash ? " dsht_flash" : ""}`,
					style: {
						top: `${idx * LINE_STEP + 5}px`,
						width: `${LINE_W + extOf(idx)}px`
					},
					"aria-label": `第 ${idx + 1} 轮`
				}, (0, react.createElement)("span", {
					className: "dsht_bar",
					style: { width: `${LINE_W + extOf(idx)}px` }
				})));
			}
			const children = [(0, react.createElement)("div", {
				key: "view",
				ref: viewElRef,
				className: "dsht_view",
				style: {
					height: `${VIEW_H}px`,
					width: `${VIEW_W}px`,
					pointerEvents: loading ? "none" : "auto"
				},
				onWheel: handleWheel,
				onClick: () => {
					const hovered = hoveredIndex;
					const list = turnsRef.current;
					if (hovered !== null && list[hovered] !== void 0) jumpToTurn(list[hovered]);
				}
			}, [(0, react.createElement)("div", {
				key: "strip",
				className: "dsht_strip",
				style: { transform: `translateY(-${off}px)` }
			}, lineNodes)])];
			let tipNode = null;
			if (hoveredIndex !== null && turns[hoveredIndex] !== void 0) {
				const turn = turns[hoveredIndex];
				const n = hoveredIndex + 1;
				const attach = turn.userAttachments > 0 ? `（含 ${turn.userAttachments} 张图片/附件）` : "";
				const tools = turn.toolCalls > 0 ? `\n调用了 ${turn.toolCalls} 次工具` : "";
				tipNode = (0, react.createElement)("div", {
					key: "tip",
					className: "dsht_tip",
					ref: (node) => {
						if (node === null || pos === null) return;
						const r = node.getBoundingClientRect();
						const ext = extOf(hoveredIndex);
						const edgeLeft = window.innerWidth - pos.right - (LINE_W + ext);
						let left = edgeLeft - r.width - 16;
						if (left < 8) left = Math.max(8, edgeLeft - r.width - 4);
						node.style.left = `${left}px`;
						node.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, pos.top - r.height / 2))}px`;
						node.style.right = "auto";
					}
				}, [
					(0, react.createElement)("div", {
						key: "h",
						className: "dsht_tipHead"
					}, [(0, react.createElement)("span", {
						key: "seq",
						className: "dsht_tipSeq"
					}, `第 ${n} 轮`), (0, react.createElement)("span", {
						key: "time",
						className: "dsht_tipTime"
					}, fmtTime(turn.time))]),
					(0, react.createElement)("div", {
						key: "u",
						className: "dsht_tipLabel"
					}, "用户"),
					(0, react.createElement)("div", {
						key: "ut",
						className: "dsht_tipBody"
					}, truncate(turn.userText || "(无文本)", 200)),
					(0, react.createElement)("div", {
						key: "a",
						className: "dsht_tipLabel"
					}, "Agent"),
					(0, react.createElement)("div", {
						key: "at",
						className: "dsht_tipBody"
					}, truncate(turn.assistantText || "(暂无回复)", 200)),
					(0, react.createElement)("div", {
						key: "meta",
						className: "dsht_tipMeta"
					}, `${attach}${tools}`.trim())
				]);
			}
			return (0, react.createElement)(react.Fragment, null, [(0, react.createElement)("div", {
				ref: rootRef,
				className: "dsht_root",
				style: pos !== null && (count > 0 || loading) ? {
					top: pos.top,
					right: pos.right,
					transform: "translateY(-50%)",
					visibility: "visible"
				} : { visibility: "hidden" },
				"aria-hidden": activeInWindow ? void 0 : "true"
			}, children), tipNode === null ? [] : tipNode]);
		}
		/** ------------------------------------------------------------------ plugin */
		/** Services required before mounting: the slot registry. */
		const inject = ["slots"];
		/**
		* Client plugin body: inject the stylesheet and register the dock row.
		* @param ctx - client plugin context (slots, sessions, timer).
		*/
		function apply(ctx) {
			ctx.effect(() => injectStyles(), "dsh-timeline: stylesheet");
			const slots = ctx.get("slots");
			if (slots === void 0) return;
			const sessions = ctx.get("sessions");
			const timer = ctx.get("timer");
			const timeout = timer?.timeout.bind(timer);
			const loadOlderFor = sessions === void 0 ? void 0 : (id) => {
				const b = sessions.binding(id);
				if (b === void 0 || !b.session || typeof b.session.loadOlder !== "function") return Promise.resolve();
				return b.session.loadOlder();
			};
			slots.inject("conversation.input.dock", () => slots.register({
				name: "conversation.input.dock",
				id: "dsh-timeline",
				order: 40
			}, (props) => (0, react.createElement)(TimelineOverlay, {
				session: props.session,
				loadOlderFor,
				timeout
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map