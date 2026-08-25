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
import { createElement, Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Context } from 'cordis'
import {
  type HistoryConversationSnapshot,
  type TurnItem,
  chaseScroll,
  clamp,
  collectWindowItems,
  findAnchor,
  findScrollPort,
  fmtTime,
  scrollToKey,
  truncate,
} from './util'

/** ------------------------------------------------------------------ types */

/** The client slots service face (structural subset used here). */
interface HistorySlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: {
    name: string
    id?: string
    order?: number
  }, component: (props: HistoryDockProps) => ReactElement): () => void
}

/** The client sessions service face (structural subset used here). */
interface ClientSessionsService {
  binding(id: string): {
    session: { loadOlder(): Promise<void> }
  } | undefined
}

/** Props the dock slot renders with. */
interface HistoryDockProps {
  session?: HistoryConversationSnapshot
}

/** Timer service face (optional; used to auto-clear the flash feedback). */
interface HistoryTimer {
  timeout(callback: () => void, delay: number): () => void
}

declare module 'cordis' {
  interface Context {
    slots: HistorySlotsService
    sessions?: ClientSessionsService
    timer?: HistoryTimer
  }
}

/** ------------------------------------------------------------------ styles */


/** Inject the plugin stylesheet once per activation (removed on disposal). */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector('style[data-plugin-css="dsh-timeline/styles"]') !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-timeline'
  tag.dataset.pluginCss = 'dsh-timeline/styles'
  tag.textContent = TIMELINE_CSS
  document.head.appendChild(tag)
  return () => {
    if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
  }
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
`

/** Timeline overlay: the right-edge turn-rail (spec F2-F5). */
function TimelineOverlay(props: HistoryDockProps & {
  loadOlderFor?: (id: string) => Promise<void>
  timeout?: HistoryTimer['timeout']
}): ReactElement {
  const session = props.session
  const sessionId = session?.sessionId
  const [turns, setTurns] = useState<TurnItem[]>([])
  /** 当前会话是否已成功拿到过一轮次响应（区分"首载中"与"该会话确实无轮次"）。 */
  const [loaded, setLoaded] = useState(false)
  /** 上次重置加载标记的会话：仅真正的会话切换才重置，快照变化不重置。 */
  const loadedSessionRef = useRef<string | null>(null)
  /** 胶片在视口内的像素偏移：0 = 最旧对齐视口顶，maxOff = 最新贴底。 */
  const [off, setOff] = useState(0)
  const [activeSeq, setActiveSeq] = useState<number | null>(null)
  const [flashSeq, setFlashSeq] = useState<number | null>(null)
  /** 点击跳到未加载轮次时的"追逐"状态：持续 loadOlder 直到目标轮次进入已加载窗口。 */
  const [chase, setChase] = useState<{ seq: number; loads: number } | null>(null)
  const chaseRef = useRef(chase)
  chaseRef.current = chase
  /** 追逐加载期间的滚动动画句柄：落地精确跳转前先取消，避免两个 rAF 循环抢 scrollTop。 */
  const chaseAnimRef = useRef<(() => void) | null>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const portRef = useRef<HTMLElement | null>(null)
  const offRef = useRef(off)
  offRef.current = off
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  // DOM-derived turn-number → anchor key map: rows carry keys like
  // "13:input-message<uuid>" / "13:tool-callxxx" whose leading integer is
  // the engine's 1-based turn number (= our turn index + 1). Click-jump
  // falls back to this map when the loaded-window seq map misses the turn.
  const domTurnRef = useRef(new Map<number, string>())

  const VISIBLE = 10 // 视口约容纳的线条数
  const LINE_STEP = 18 // 单根线条的槽高：3px 条 + 2×5px padding + 5px 间距（紧凑）
  const VIEW_H = VISIBLE * LINE_STEP // 180px——与 CSS 中 .dsht_view 的 height 同步
  const LINE_W = 17 // 线条基准宽（为原 34px 的一半，右侧对齐，右缘贴轨道边）
  const MAX_EXT = 30 // 悬停线条向左延长的最大像素数
  const VIEW_W = LINE_W + MAX_EXT // 视口宽 = 基准 + 最大延长，悬停伸长不截断
  const EXT_RADIUS = 3 // 延长作用半径：距悬停线几根以内按抛物线衰减
  const HEXT_SAT = 20 // 水平饱和距离：光标距延长前基段中点 ≤20px 即达最大长度
  const HEXT_RADIUS = 50 // 水平有效半径：距中点 50px（= HEXT_SAT + 20 + 10 的两次放远）以外不延长
  const EXT_PHASE = 1.35 // 正切相位：远段增长慢、贴近后急速拉满
  /** tooltip 触发左边界 = 线条触发左边界再向右收 10px（最左窄带只延长不弹提示）。 */
  const HOVER_TIP_INSET = 10
  /** 光标距线中心超过该值视为"不在线上"：线槽高 18px、两线间最大距离 9px，
   *  线少时空槽位不再把光标 clamp 到最远处那条线。 */
  const HOVER_NEAR = 13
  const HOVER_KEEP_RANGE = 100 // 光标保护区：离开轨道后仍保持延长/高亮的范围
  /** 首载未完成前快速轮询，拿到底后降为常规周期（host 侧 3s TTL 缓存）。 */
  const POLL_FAST_MS = 1000
  const POLL_MS = 3000
  /** 首载骨架占位刻度条数。 */
  const SKELETON_BARS = 5
  const WHEEL_HOLD_MS = 1200 // 滚轮滚轨道后的抑制窗口：期间”跟随 active”不触发回弹
  const HOVER_LEAVE_MS = 400 // 移出保护区后等待多久才允许回弹（给鼠标一个缓冲期）
  const BUFFER = 2 // 视口上下各多渲染 BUFFER 根，滑动时不出现空白
  // 追逐跳转的保险上限（loadOlder 每次最多拉 50 条事件，一条轮次至少需要
  // 1 条 user/message 事件，24 次 ≈ 1200 条；正常会话远达不到，防御性封顶）。
  const CHASE_MAX_LOADS = 24
  /** 胶片滑动目标偏移 + 惯性动画的 rAF 句柄（滚轮与"跟随 active"共用）。 */
  const targetRef = useRef(0)
  const glideRafRef = useRef(0)

  // seq → anchor key map from the loaded window (for click-jump).
  const keys = useMemo(() => collectWindowItems(session).keys, [session])
  const seqByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const [seq, key] of keys) if (key !== null) m.set(key, seq)
    return m
  }, [keys])

  // Poll the turn list; the host cache (3s TTL) keeps this cheap. When the
  // list changes (e.g. a session switch), reset the highlight to the newest
  // turn so the rail never goes dark, then re-run the DOM detection once the
  // message rows land (they render asynchronously after switch).
  useEffect(() => {
    if (sessionId === undefined) return
    // 只有真正的会话切换才重置首载标记（seqByKey/快照变化不是换会话）。
    if (sessionId !== loadedSessionRef.current) {
      loadedSessionRef.current = sessionId
      setLoaded(false)
    }
    let cancelled = false
    setActiveSeq(null)
    setOff(0)
    targetRef.current = 0
    const load = (): void => {
      fetch('/history/api/list-turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: String(sessionId) }),
        cache: 'no-store',
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data: unknown) => {
          if (cancelled) return
          const record = data as { ok?: boolean; turns?: TurnItem[] }
          if (record && record.ok === true && Array.isArray(record.turns)) {
            setLoaded(true)
            const next = record.turns
            // 旧高亮不在新列表里时，默认高亮最新一轮（保证必有一条蓝线）。
            if (next.length > 0) {
              setActiveSeq((prev) => (
                prev !== null && next.some((t) => t.seq === prev) ? prev : next[next.length - 1].seq
              ))
            }
            setTurns(next)
          }
        })
        .catch(() => { /* keep last known state */ })
    }
    load()
    // 首载期快速轮询，让"尚未就绪"的会话尽快出数据；有数据后降为常规周期。
    const timer = setInterval(load, loaded ? POLL_MS : POLL_FAST_MS)
    // 消息区 DOM 在会话切换后异步渲染：定时重跑检测以纠正高亮。
    const detect = setInterval(() => {
      const port = portRef.current
      if (port !== null) {
        const rect = port.getBoundingClientRect()
        if (rect.height > 0 && port.querySelector('[data-chat-anchor-key]') !== null) {
          requestAnimationFrame(() => {
            const evt = new Event('scroll')
            port.dispatchEvent(evt)
          })
        }
      }
    }, 1000)
    return () => { cancelled = true; clearInterval(timer); clearInterval(detect) }
  }, [sessionId, seqByKey, loaded])

  // Geometry + active-turn tracking: pin the rail to the message viewport's
  // right edge. The message rows may not have rendered yet at mount time, so
  // the scrollport is re-resolved on every update; the fallback chain is
  // message-row scrollport → composer-seat parent (the message scroll body)
  // → dock container. ResizeObserver + scroll + a slow poll keep the rail
  // following sidebar/bottom-bar layout changes.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let raf = 0
    let bound: HTMLElement | null = null

    const resolvePort = (): HTMLElement | null => {
      const row = document.querySelector<HTMLElement>('[data-chat-anchor-key]')
      if (row !== null) {
        const p = findScrollPort(row)
        if (p !== null) return p
      }
      const seat = document.querySelector<HTMLElement>('[data-composer-seat]')
      if (seat !== null && seat.parentElement !== null) {
        const p = findScrollPort(seat.parentElement, true)
        if (p !== null) return p
      }
      return null
    }

    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const port = portRef.current
        if (port === null) return
        const turnsList = turnsRef.current
        if (turnsList.length === 0) return
        const rect = port.getBoundingClientRect()
        if (rect.height === 0) return
        const center = rect.top + rect.height * 0.42
        // 权威映射：collectWindowItems(session) 已给出「已加载窗口内 user/steering
        // 行的 seq → DOM anchor key」映射（seqByKey）。DOM 行的 key 反查 seq，
        // 再定位到 turns 数组 —— 完全不需要猜引擎 turn 编号（它是跨会话全局
        // 递增的，9/13/14...，与会话内轮次无绝对对应）。tool/assistant 行无
        // key 映射，自动被跳过。
        let bestSeq: number | null = null
        let bestDist = Infinity
        const domTurn = domTurnRef.current
        const rows = port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]
          if (r === null) continue
          const key = r.dataset.chatAnchorKey
          if (typeof key !== 'string' || key === '') continue
          const seq = seqByKey.get(key)
          if (seq === undefined) continue
          const tIdx = turnsList.findIndex((t) => t.seq === seq)
          if (tIdx === -1) continue
          if (!domTurn.has(tIdx)) domTurn.set(tIdx, key)
          const rr = r.getBoundingClientRect()
          // 视口内的行权重 0（最近优先）；视口外的行按距离排后。
          const inView = rr.bottom > rect.top && rr.top < rect.bottom
          const dist = Math.abs(rr.top + rr.height / 2 - center) + (inView ? 0 : 1e6)
          if (dist < bestDist) { bestDist = dist; bestSeq = seq }
        }
        if (bestSeq !== null) {
          setActiveSeq((prev) => (prev === bestSeq ? prev : bestSeq))
        }
      })
    }

    const update = (): void => {
      const portNew = resolvePort()
      if (portNew !== bound) {
        if (bound !== null) bound.removeEventListener('scroll', onScroll)
        bound = portNew
        portRef.current = portNew
        if (portNew !== null) {
          portNew.addEventListener('scroll', onScroll, { passive: true })
          // 消息滚动容器也纳入观测：右侧系统容器/侧边栏展开挤压消息区、
          // 或任何布局位移改变其尺寸时，轨道即刻重定位（轮询只是兜底）。
          ro?.observe(portNew)
        }
      }
      const target = portNew ?? el.parentElement ?? el
      const r = target.getBoundingClientRect()
      const right = Math.max(4, window.innerWidth - r.right + 6)
      // 轨道是一列紧凑小横线，垂直居中于滚动容器（translateY(-50%) 由 CSS 承托）。
      const top = Math.max(4, r.top + r.height / 2)
      setPos((prev) => (prev && prev.top === top && prev.right === right ? prev : {
        top, right,
      }))
      if (portNew !== null && portRef.current === portNew) onScroll()
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    ro?.observe(el.parentElement ?? el)
    window.addEventListener('resize', update)
    // The message list renders asynchronously after session load; re-resolve
    // the scrollport until it exists (cheap idle poll).
    const timer = setInterval(update, 1000)
    update()
    return () => {
      ro?.disconnect()
      clearInterval(timer)
      window.removeEventListener('resize', update)
      if (bound !== null) bound.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [seqByKey])

  // 胶片几何：总长 / 最大偏移 / 视口内需要渲染的线。off 是视口顶相对胶片
  // 顶的像素距离；滚轮与“跟随 active”都只写 targetRef，由同一个 glide 循环
  // 滑到目标，互不打断，运动是像素级连续的。
  const count = turns.length
  /** 首载期：会话刚切换、还没拿到过成功的轮次响应 → 显示骨架占位轨道。 */
  const loading = count === 0 && !loaded
  const maxOff = Math.max(0, count * LINE_STEP - VIEW_H)
  const lastIdxAll = Math.max(0, count - 1)
  const firstIdx = clamp(Math.floor(off / LINE_STEP) - BUFFER, 0, lastIdxAll)
  const lastIdx = clamp(Math.ceil((off + VIEW_H) / LINE_STEP) + BUFFER - 1, 0, lastIdxAll)
  const activeIdx = activeSeq === null ? -1 : turns.findIndex((t) => t.seq === activeSeq)
  const activeInWindow = activeIdx >= firstIdx && activeIdx <= lastIdx

  const glide = (): void => {
    const cur = offRef.current
    const target = clamp(targetRef.current, 0, Math.max(0, turnsRef.current.length * LINE_STEP - VIEW_H))
    if (Math.abs(target - cur) < 0.5) {
      if (cur !== target) setOff(target)
      glideRafRef.current = 0
      return
    }
    const next = cur + (target - cur) * 0.3
    setOff(next)
    glideRafRef.current = requestAnimationFrame(glide)
  }

  const glideTo = (target: number): void => {
    targetRef.current = target
    if (glideRafRef.current === 0) glideRafRef.current = requestAnimationFrame(glide)
  }

  // 跟踪高亮线：active 不在视口窗口内（含缓冲）时，把胶片带回让活跃线落在
  // 视口 42% 处。active/count 变化时立即检查，另每 600ms 周期复查一次（保证
  // 停手后也会自动回到居中状态）。回弹让位给用户的三道闸：
  // - 滚轮滚轨道后的 WHEEL_HOLD_MS 内强制跳过（滚轨道时绝不回弹）；
  // - 光标仍在保护区（hoverZoneRef）时跳过（鼠标停着不弹）；
  // - 移出保护区后还要再等 HOVER_LEAVE_MS 才允许回弹（移开也有缓冲期）。
  useEffect(() => {
    const follow = (): void => {
      if (performance.now() - wheelAtRef.current < WHEEL_HOLD_MS) return
      if (hoverZoneRef.current) return
      if (performance.now() - leaveAtRef.current < HOVER_LEAVE_MS) return
      const list = turnsRef.current
      if (list.length === 0 || activeSeq === null) return
      const idx = list.findIndex((t) => t.seq === activeSeq)
      if (idx === -1) return
      const cur = offRef.current
      const lineTop = idx * LINE_STEP
      if (lineTop >= cur - BUFFER * LINE_STEP && lineTop < cur + VIEW_H + BUFFER * LINE_STEP) return
      glideTo(clamp(idx * LINE_STEP - VIEW_H * 0.42, 0, Math.max(0, list.length * LINE_STEP - VIEW_H)))
    }
    follow()
    const timer = setInterval(follow, 600)
    return () => clearInterval(timer)
  }, [activeSeq, count])

  const handleWheel = (e: { deltaY: number; preventDefault(): void }): void => {
    e.preventDefault()
    wheelAtRef.current = performance.now()
    // 与原生滚轮方向一致：向下滚动胶片朝最新的方向走（视口顶向最新偏移）。
    const delta = e.deltaY * 0.25
    if (Math.abs(delta) < 2) return
    glideTo(clamp(offRef.current + delta, 0, maxOff))
  }

  const flashTurn = (turn: TurnItem): void => {
    setFlashSeq(turn.seq)
    if (typeof props.timeout === 'function') {
      props.timeout(() => setFlashSeq((cur) => (cur === turn.seq ? null : cur)), 1700)
    } else {
      setTimeout(() => setFlashSeq((cur) => (cur === turn.seq ? null : cur)), 1700)
    }
  }

  /** 点击“未加载”轮次：不等加载完成 —— 立即给反馈。闪烁所点线条（纯线条
   *  脉冲，不移动窗口），同时马上向顶部方向滚动（更早历史从内容顶部前置
   *  进来，scrollTop 锁定在顶部附近时每一页新拉到的轮次都会顶上视口，加载
   *  完差不多已就位），再启动追逐加载；落地后由 chase effect 做最后的精确
   *  对齐。特意不把 activeSeq 直接设到目标上：那会让轨道窗口先行“自动对齐”
   *  到所点轮次再弹回，页面滚动时时间线反而不像在连续滚动。 */
  const startChase = (turn: TurnItem): void => {
    flashTurn(turn)
    const port = portRef.current
    if (port !== null && port.getBoundingClientRect().height > 0) {
      chaseAnimRef.current?.()
      chaseAnimRef.current = chaseScroll(port, 0)
    }
    setChase({ seq: turn.seq, loads: 1 })
  }

  const jumpToTurn = (turn: TurnItem): void => {
    const idx = turnsRef.current.findIndex((t) => t.seq === turn.seq)
    const key = keys.get(turn.seq) ?? domTurnRef.current.get(idx)
    if (key === null || key === undefined) {
      startChase(turn)
      return
    }
    if (findAnchor(key) !== null) scrollToKey(key)
    flashTurn(turn)
  }

  // Chase a click-jump: each loaded page either lands the target row (jump +
  // flash) or pages one more batch of older history. Driven by the real
  // snapshot/keys change from loadOlder (never by bare timers), so each
  // iteration waits for the previous page to actually render.
  useEffect(() => {
    if (chase === null) return
    const turn = turnsRef.current.find((t) => t.seq === chase.seq)
    if (turn === undefined) {
      // 轮次列表更新后目标仍在（turns 是全部轮次，理论不会消失）；防御性清除。
      setChase(null)
      return
    }
    const key = keys.get(turn.seq)
    if (key !== undefined) {
      // 目标已进入已加载窗口：先停掉追逐滚动，再做精确对齐。
      chaseAnimRef.current?.()
      chaseAnimRef.current = null
      setChase(null)
      if (findAnchor(key) !== null) scrollToKey(key)
      flashTurn(turn)
      return
    }
    // 目标还未加载：能继续翻更早历史就接着翻（loadOlder 幂等，重复调用安全）。
    if (typeof props.loadOlderFor !== 'function' || props.session?.hasMore !== true) {
      setChase(null)
      return
    }
    if (props.session?.loadingOlder === true) return
    if (chase.loads >= CHASE_MAX_LOADS) {
      setChase(null)
      return
    }
    props.loadOlderFor(String(sessionId)).catch(() => { /* 加载失败时保持等下一次 keys 变化 */ })
    setChase({ seq: chase.seq, loads: chase.loads + 1 })
  }, [chase, keys, session])

  /** 光标视口相对 y（在轨道内/保护区内时有效，-1 表示不在保护区）。 */
  const cursorYRef = useRef(-1)
  /** 光标屏幕 x：水平距离分量，驱动悬停中心线的延长量（见 extOf）。 */
  const hoverXRef = useRef(-1)
  /** 光标是否处于「轨道内或 HOVER_KEEP_RANGE 保护区」中。 */
  const hoverZoneRef = useRef(false)
  /** 滚轮滚轨道时的最近时间戳：跟随回弹让位给用户（见 WHEEL_HOLD_MS 抑制）。 */
  const wheelAtRef = useRef(0)
  /** 离开保护区的时间戳：移开鼠标后等待几百毫秒才允许回弹。 */
  const leaveAtRef = useRef(0)
  const viewElRef = useRef<HTMLDivElement | null>(null)
  // 悬停驱动改为“渲染期推导”：每帧渲染用光标实时位置 + 当前 off 反查最近
  // 轮次。滚轮滚动胶片时 off 在变，延长中心随之动态跟进，不再停在最后一次
  // mousemove 的旧线上。光标移动本身只触发重渲染（hoverTick 自增），不存
  // 推导结果。
  const [hoverTick, setHoverTick] = useState(0)
  const zoneOf = (e: { clientX: number; clientY: number }): 'in' | 'near' | 'out' => {
    const el = viewElRef.current
    if (el === null) return 'out'
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return 'out'
    // 触发范围以「线条动画的左侧最远触发位置」（基段中点 - HEXT_RADIUS）为界，
    // 比视口左缘更宽；轨道右缘之外是系统默认容器/侧边栏，不参与检测。
    const extLeftX = pos === null
      ? rect.left
      : window.innerWidth - pos.right - LINE_W / 2 - HEXT_RADIUS
    const inY = e.clientY >= rect.top && e.clientY <= rect.bottom
    const nearY = e.clientY >= rect.top - HOVER_KEEP_RANGE && e.clientY <= rect.bottom + HOVER_KEEP_RANGE
    if (e.clientX >= extLeftX && e.clientX <= rect.right && inY) return 'in'
    if (e.clientX >= extLeftX - HOVER_KEEP_RANGE && e.clientX <= rect.right && nearY) return 'near'
    return 'out'
  }

  // 全局追踪光标：更新 cursorYRef / hoverZoneRef，并按区域状态变化触发重渲染。
  // 轨道外保留 HOVER_KEEP_RANGE 保护区——光标稍有偏移时延长与 tooltip 不缩回。
  useEffect(() => {
    const onMove = (e: { clientX: number; clientY: number }): void => {
      const zone = zoneOf(e)
      if (zone === 'out') {
        if (hoverZoneRef.current) leaveAtRef.current = performance.now()
        hoverZoneRef.current = false
        setHoverTick((t) => t + 1)
        return
      }
      const el = viewElRef.current
      if (el !== null) {
        const rect = el.getBoundingClientRect()
        cursorYRef.current = rect.height > 0 ? Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top)) : -1
      }
      hoverXRef.current = e.clientX
      hoverZoneRef.current = true
      setHoverTick((t) => t + 1)
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [])

  // 渲染期推导的悬停线索引：光标必须落在某一根**实际渲染**的线附近才有效。
  // 线少时容器底部/空白槽位不再把光标 clamp 到最远处那条线（mousemove 只
  // 触发重渲染，不存推导结果）。
  const hoveredIndex = (() => {
    if (!hoverZoneRef.current || cursorYRef.current < 0) return null
    const raw = Math.round((cursorYRef.current - 6.5) / LINE_STEP)
    const near = clamp(raw, 0, Math.max(0, count - 1))
    const dist = Math.abs(cursorYRef.current - (near * LINE_STEP + 6.5))
    return dist <= HOVER_NEAR ? near : null
  })()

  // 悬停延长轮廓由「水平距离分量」驱动（替代固定拉满）：以延长前基段的中点为
  // 参照——光标距中点 ≤ HEXT_SAT 时即达最大长度（继续靠近不再加长），距中点
  // ≥ HEXT_RADIUS 不延长；中间按正切曲线过渡，较远时增长缓慢，接近后急速
  // 拉满。相邻线按陡峭的抛物线 (1-d/r)² 衰减，突起更尖锐，整体保持平滑。
  const railRightX = pos === null ? -1 : window.innerWidth - pos.right
  const midX = railRightX - LINE_W / 2 // 延长前基段的中点
  const extAmp = (u: number): number => {
    if (u <= 0) return 0
    if (u >= 1) return 1
    return Math.tan(EXT_PHASE * u) / Math.tan(EXT_PHASE)
  }
  const extOf = (idx: number): number => {
    if (hoveredIndex === null || railRightX < 0) return 0
    const d = Math.abs(idx - hoveredIndex)
    if (d > EXT_RADIUS) return 0
    const hx = hoverXRef.current
    const hd = hx < 0 ? 0 : Math.abs(hx - midX)
    const u = (HEXT_RADIUS - hd) / (HEXT_RADIUS - HEXT_SAT)
    return (1 - d / EXT_RADIUS) ** 2 * MAX_EXT * extAmp(u)
  }

  /** tooltip 触发左边界 = 线条触发范围最左侧向右收 HOVER_TIP_INSET。 */
  const tipLeftX = railRightX < 0 ? -1 : midX - HEXT_RADIUS + HOVER_TIP_INSET
  /** tooltip 悬停索引：只在「延长生效且光标越过无提示窄带」后才有值。 */
  const tipIndex = hoveredIndex !== null && hoverXRef.current >= tipLeftX ? hoveredIndex : null

  // 只渲染视口 ± BUFFER 根线，绝对定位在各自槽位；整条胶片由 translateY(-off)
  // 驱动，滑动连续可见，超出视口的线被 .dsht_view 的边缘遮罩淡出。
  const lineNodes: ReactElement[] = []
  if (loading) {
    // 骨架：固定几根半透明占位刻度，数据到达后由真实线条替换，无交互。
    for (let i = 0; i < SKELETON_BARS; i++) {
      lineNodes.push(createElement('div', {
        key: `skel${i}`,
        className: 'dsht_line dsht_skelRow',
        style: { top: `${i * LINE_STEP + 5}px`, width: `${LINE_W}px` },
        'aria-hidden': 'true',
      }, createElement('span', { className: 'dsht_bar dsht_skel' })))
    }
  }
  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const turn = turns[idx]
    if (turn === undefined) continue
    const isActive = activeIdx === idx
    const isFlash = flashSeq === turn.seq
    lineNodes.push(createElement('div', {
      key: `t${turn.seq}`,
      className: `dsht_line${isActive ? ' dsht_active' : ''}${isFlash ? ' dsht_flash' : ''}`,
      style: { top: `${idx * LINE_STEP + 5}px`, width: `${LINE_W + extOf(idx)}px` },
      'aria-label': `第 ${idx + 1} 轮`,
    }, createElement('span', { className: 'dsht_bar', style: { width: `${LINE_W + extOf(idx)}px` } })))
  }

  const children: ReactElement[] = [
    createElement('div', {
      key: 'view',
      ref: viewElRef,
      className: 'dsht_view',
      style: { height: `${VIEW_H}px`, width: `${VIEW_W}px`, pointerEvents: loading ? 'none' : 'auto' },
      onWheel: handleWheel,
      onClick: () => {
        const hovered = hoveredIndex
        const list = turnsRef.current
        if (hovered !== null && list[hovered] !== undefined) jumpToTurn(list[hovered])
      },
    }, [
      createElement('div', {
        key: 'strip',
        className: 'dsht_strip',
        style: { transform: `translateY(-${off}px)` },
      }, lineNodes),
    ]),
  ]

  // Tooltip: 跟随渲染期推导的悬停线（滚动时随胶片动态切换线内容）;
  // auto-flip 保证不超出视口，并贴着延长后线条外沿留 16px，不被线条覆盖。
  let tipNode: ReactElement | null = null
  if (tipIndex !== null && turns[tipIndex] !== undefined) {
    const turn = turns[tipIndex]
    const n = tipIndex + 1
    const attach = turn.userAttachments > 0 ? `（含 ${turn.userAttachments} 张图片/附件）` : ''
    const tools = turn.toolCalls > 0 ? `\n调用了 ${turn.toolCalls} 次工具` : ''
    tipNode = createElement('div', {
      key: 'tip',
      className: 'dsht_tip',
      ref: (node: HTMLDivElement | null): void => {
        if (node === null || pos === null) return
        const r = node.getBoundingClientRect()
        // 轨道右缘在屏幕 x = innerWidth - pos.right；悬停线延长后的左缘距轨道
        // 右缘 = LINE_W + extOf(index)。tooltip 贴在这条左缘外侧再留 16px 空隙，
        // 保证不被延长线条覆盖；水平空间不足时翻到贴近边缘。
        const ext = extOf(tipIndex)
        const edgeLeft = window.innerWidth - pos.right - (LINE_W + ext)
        let left = edgeLeft - r.width - 16
        if (left < 8) left = Math.max(8, edgeLeft - r.width - 4)
        node.style.left = `${left}px`
        node.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, pos.top - r.height / 2))}px`
        node.style.right = 'auto'
      },
    }, [
      createElement('div', { key: 'h', className: 'dsht_tipHead' }, [
        createElement('span', { key: 'seq', className: 'dsht_tipSeq' }, `第 ${n} 轮`),
        createElement('span', { key: 'time', className: 'dsht_tipTime' }, fmtTime(turn.time)),
      ]),
      createElement('div', { key: 'u', className: 'dsht_tipLabel' }, '用户'),
      createElement('div', { key: 'ut', className: 'dsht_tipBody' }, truncate(turn.userText || '(无文本)', 200)),
      createElement('div', { key: 'a', className: 'dsht_tipLabel' }, 'Agent'),
      createElement('div', { key: 'at', className: 'dsht_tipBody' }, truncate(turn.assistantText || '(暂无回复)', 200)),
      createElement('div', { key: 'meta', className: 'dsht_tipMeta' }, `${attach}${tools}`.trim()),
    ])
  }

  return createElement(Fragment, null, [
    createElement('div', {
      ref: rootRef,
      className: 'dsht_root',
      style: pos !== null && (count > 0 || loading) ? {
        top: pos.top,
        right: pos.right,
        transform: 'translateY(-50%)',
        visibility: 'visible',
      } : { visibility: 'hidden' },
      'aria-hidden': activeInWindow ? undefined : 'true',
    }, children),
    tipNode === null ? [] : tipNode,
  ])
}

/** ------------------------------------------------------------------ plugin */

/** Services required before mounting: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: inject the stylesheet and register the dock row.
 * @param ctx - client plugin context (slots, sessions, timer).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'dsh-timeline: stylesheet')
  const slots = ctx.get('slots') as HistorySlotsService | undefined
  if (slots === undefined) return
  const sessions = ctx.get('sessions') as ClientSessionsService | undefined
  const timer = ctx.get('timer') as HistoryTimer | undefined
  const timeout = timer?.timeout.bind(timer)
  const loadOlderFor = sessions === undefined
    ? undefined
    : (id: string): Promise<void> => {
      const b = sessions.binding(id)
      if (b === undefined || !b.session || typeof b.session.loadOlder !== 'function') return Promise.resolve()
      return b.session.loadOlder()
    }
  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: 'dsh-timeline', order: 40 },
    (props: HistoryDockProps) => createElement(TimelineOverlay, {
      session: props.session,
      loadOlderFor,
      timeout,
    }),
  ))
}
