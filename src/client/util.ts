/**
 * Pure helpers for the dsh-timeline client half. No React, no plugin services —
 * only thin DOM/browser helpers and data transforms. Kept in one file so the
 * component (index.ts) stays focused on rendering and state, and so utility
 * logic is testable in isolation.
 */

/** One materialized chat node (user or steering message). */
export interface HistoryChatNode {
  kind?: string
  key?: string
  anchorSeq?: number
  visibility?: string
  data?: {
    seq?: number
    time?: number
    content?: readonly HistoryContentBlock[]
  }
}

/** One content block (structural subset: the text/image/tool shapes). */
export interface HistoryContentBlock {
  type?: string
  text?: string
  name?: string
}

/** One rendered list row. */
export interface HistoryRow {
  seq: number
  time: number
  text: string
  key: string | null
}

/** One interaction turn from the host `/history/api/list-turns` route. */
export interface TurnItem {
  seq: number
  time: number
  userText: string
  userAttachments: number
  assistantText: string
  toolCalls: number
}

/** Truncate a string to at most `max` code units with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : (n > max ? max : n)
}

/** Find the nearest overflow-y scroll ancestor of an element (the message
 *  viewport for rows inside the conversation). Pass `includeSelf` to also
 *  accept the element itself when it is the scrollport. */
export function findScrollPort(el: HTMLElement, includeSelf = false): HTMLElement | null {
  let node: HTMLElement | null = includeSelf ? el : el.parentElement
  while (node !== null) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node
    node = node.parentElement
  }
  return null
}

/** The conversation snapshot slice this plugin reads (structural subset). */
export interface HistoryConversationSnapshot {
  sessionId?: string
  hasMore?: boolean
  loadingOlder?: boolean
  chat?: {
    nodes?: {
      values(): readonly HistoryChatNode[]
    }
  }
}

/** Flatten one message's content blocks to a single preview string. */
export function textOf(content: readonly HistoryContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b && b.type === 'image') parts.push('[图片]')
    else if (b && b.type === 'tool-call' && typeof b.name === 'string') parts.push('[工具: ' + b.name + ']')
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Format a Unix epoch ms timestamp: same-day → HH:mm; else YYYY-MM-DD HH:mm. */
export function fmtTime(ms: number): string {
  if (!ms || typeof ms !== 'number') return ''
  try {
    const d = new Date(ms)
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate()
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (sameDay) return time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
  } catch {
    return ''
  }
}

/** Collect the user/steering messages in the loaded window + seq→key map. */
export function collectWindowItems(session: HistoryConversationSnapshot | undefined): {
  items: HistoryRow[]
  keys: Map<number, string>
} {
  const items: HistoryRow[] = []
  const keys = new Map<number, string>()
  if (!session || !session.chat || !session.chat.nodes) return { items, keys }
  let nodes: readonly HistoryChatNode[] = []
  try {
    nodes = session.chat.nodes.values()
  } catch {
    nodes = []
  }
  for (const node of nodes) {
    if (!node) continue
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    if (node.visibility === 'hidden') continue
    const data = node.data || {}
    const seq = typeof node.anchorSeq === 'number' ? node.anchorSeq : (typeof data.seq === 'number' ? data.seq : 0)
    if (typeof node.key === 'string' && node.key) keys.set(seq, node.key)
    items.push({
      seq,
      time: typeof data.time === 'number' ? data.time : 0,
      text: textOf(data.content),
      key: typeof node.key === 'string' ? node.key : null,
    })
  }
  items.sort((a, b) => a.seq - b.seq)
  return { items, keys }
}

/** Find the conversation row DOM element for a chat-node anchor key. */
export function findAnchor(key: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const rows = document.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row && row.dataset && row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Scroll the scrollport to a target scrollTop over a short animation.
 *  rAF-driven so the speed is deterministic and independent of the host's
 *  `scroll-behavior` CSS; the jump must stay fast (≈200ms) yet visible.
 *  Returns false when the target equals the current position. */
function animateScroll(port: HTMLElement, target: number, duration = 200): boolean {
  if (Math.abs(target - port.scrollTop) < 1) return false
  let raf = 0
  const start = port.scrollTop
  const delta = target - start
  const t0 = performance.now()
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  const step = (now: number): void => {
    const p = Math.min(1, (now - t0) / duration)
    port.scrollTop = start + delta * ease(p)
    if (p < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return true
}

/** Drive the scrollport partway toward `target` while older history is still
 *  loading.  Clicking an unloaded turn scrolls up now so the motion starts
 *  immediately; each `loadOlder` page prepends above the top, so pinning
 *  toward the top keeps every newly loaded page entering the viewport and
 *  the view approaches the target before the exact jump lands.  Returns a
 *  cancel callback (the precise landing jump should stop this motion first,
 *  otherwise both rAF loops would fight over scrollTop). */
export function chaseScroll(port: HTMLElement, target: number, duration = 750): () => void {
  if (Math.abs(target - port.scrollTop) < 1) return () => {}
  let raf = 0
  const start = port.scrollTop
  const delta = target - start
  const t0 = performance.now()
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  const step = (now: number): void => {
    const p = Math.min(1, (now - t0) / duration)
    port.scrollTop = start + delta * ease(p)
    if (p < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}

/** Scroll a message row into view (top-aligned) and flash-highlight it.
 *  Positions the conversation scrollport directly with a short animated
 *  scroll (see animateScroll), rather than relying on async scrollIntoView
 *  which can silently no-op. */
export function scrollToKey(key: string): boolean {
  const el = findAnchor(key)
  if (!el) return false
  try {
    el.classList.remove('dshm-flash')
    void el.offsetWidth
    el.classList.add('dshm-flash')
    el.addEventListener('animationend', () => el.classList.remove('dshm-flash'), { once: true })

    let port: HTMLElement | null = null
    let node: HTMLElement | null = el.parentElement
    while (node !== null) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
        port = node
        break
      }
      node = node.parentElement
    }
    if (port !== null) {
      const elRect = el.getBoundingClientRect()
      const portRect = port.getBoundingClientRect()
      // 对齐：用户消息上沿贴视口上沿（快速动画滚动而非瞬跳）。
      const target = port.scrollTop + elRect.top - portRect.top
      return animateScroll(port, target)
    }
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } catch {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** Copy text to the clipboard (Clipboard API first, execCommand fallback). */
export function copyText(text: string): Promise<boolean> {
  if (!text) return Promise.resolve(false)
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text))
  }
  return Promise.resolve(fallbackCopy(text))
}

function fallbackCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
