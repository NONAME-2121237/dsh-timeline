/**
 * dsh-timeline host half: one fenced HTTP route `/history/api` that reads the
 * complete session log through `sessionQuery` and returns every `user/message`
 * event the human sent — including messages outside the client's currently
 * loaded window (compacted-over, paged-out, or older than the first page).
 *
 * The client half (lib/client.js) calls this route with plain `fetch`
 * (a third-party plugin resolves outside the DSH monorepo, so it has no
 * `host.call` — the fenced HTTP route is the cross-half channel).
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The webServer service face this plugin uses (structural mirror). */
interface HistoryWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The web runtime service face: bind-derived trusted authorities. */
interface HistoryWebRuntime {
  trustedHosts: readonly string[]
}

/** The session-query service face: exact reads over the live-preferred corpus. */
interface HistorySessionQuery {
  readSession(sessionId: string): Promise<{
    events?: readonly HistorySessionEvent[]
  }>
}

/** The live in-memory session store face: fast in-process log access. */
interface HistorySessionStore {
  get(id: string): {
    events?: readonly HistorySessionEvent[]
  } | undefined
}

/** One raw session-log event (structural subset used by the filter). */
interface HistorySessionEvent {
  type?: string
  seq?: number
  time?: number
  data?: {
    source?: { kind?: string }
    content?: readonly HistoryContentBlock[]
    chunk?: { type?: string; text?: string }
  }
}

/** One content block (structural subset: the text/image/tool shapes). */
interface HistoryContentBlock {
  type?: string
  text?: string
  name?: string
}

/** The wire success envelope. */
interface HistoryOk {
  ok: true
  items: { seq: number; time: number; text: string }[]
}

/** The wire failure envelope. */
interface HistoryErr {
  ok: false
  error: string
}

/** One interaction turn: a user message (plus any steering) through to the
 *  next user message — the agent reply text and tool-call count belong to
 *  the turn they fall inside (see spec F2). */
interface TurnItem {
  seq: number
  time: number
  userText: string
  userAttachments: number
  assistantText: string
  toolCalls: number
}

/** The wire envelope for the turn list. */
interface TurnsOk {
  ok: true
  turns: TurnItem[]
  total: number
}

declare module 'cordis' {
  interface Context {
    webServer: HistoryWebServer
    webRuntime: HistoryWebRuntime
    sessionQuery?: HistorySessionQuery
  }
}

/** Stable plugin name for the cordis row. */
export const name = 'dsh-timeline'

/** Services required before mounting: the web server routes and the trust list. */
export const inject = ['webServer', 'webRuntime']

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** Per-session full-history cache TTL (ms): fast repeat opens, short enough
 *  that new messages surface within a few seconds. */
const HISTORY_CACHE_TTL = 5000

/** One cached full-history payload per session. */
interface HistoryCacheEntry {
  at: number
  items: { seq: number; time: number; text: string }[]
}

/** module-level cache: keyed by sessionId, shared across requests. */
const historyCache = new Map<string, HistoryCacheEntry>()

/** Cache size cap: evict oldest-first so a long-lived server cannot grow the
 *  map unboundedly across many sessions. */
const HISTORY_CACHE_MAX = 50

/** Normalize a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether the request Host matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const canonical = entryUrl.port === '' ? entryUrl.hostname : entryUrl.host
    return canonical === hostUrl.host
  })
}

/**
 * Browser-trust fence, behaviorally identical to the /api gateway's fence
 * (loopback Host header or a configured trusted authority; cross-site
 * browser markers refuse). DNS-rebinding / cross-site defense, not
 * authentication.
 */
function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read and parse the JSON request body (bounded; malformed → null). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('malformed JSON body')
  }
}

/** Flatten one message's content blocks to a single preview string. */
function textOf(content: readonly HistoryContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b && b.type === 'image') parts.push('[图片]')
    else if (b && b.type === 'tool-call' && typeof b.name === 'string') parts.push('[工具: ' + b.name + ']')
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** One API method dispatch: list every user-sent message in the full log. */
async function listUserMessages(ctx: Context, payload: unknown): Promise<HistoryOk | HistoryErr> {
  const record = payload as { sessionId?: unknown } | null
  const sessionId = record?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少 sessionId' }
  }
  // 内存新鲜缓存：重复打开（及客户端预取）直接命中，零 I/O。
  const cached = historyCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < HISTORY_CACHE_TTL) {
    return { ok: true, items: cached.items }
  }
  // 磁盘缓存：命中即返回，不阻塞真实读取；后台按需渐进刷新（历史只增不改）。
  const disk = readDiskCache<{ seq: number; time: number; text: string }[]>('messages', sessionId)
  if (disk !== undefined) {
    storeHistoryCache(sessionId, disk.data)
    scheduleRefresh(ctx, 'messages', sessionId, disk.at)
    return { ok: true, items: disk.data }
  }
  // 无缓存：首次生成（实时读 → 内存 + 落盘）。
  let events: readonly HistorySessionEvent[] | undefined
  try {
    events = await readSessionEvents(ctx, sessionId)
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
  if (events === undefined) return { ok: false, error: 'sessionQuery 服务不可用' }
  const items = collectUserMessages(events ?? [])
  storeHistoryCache(sessionId, items)
  writeDiskCache('messages', sessionId, items)
  return { ok: true, items }
}

/** Filter one event list down to human-sent user messages, seq-ascending. */
function collectUserMessages(events: readonly HistorySessionEvent[]): { seq: number; time: number; text: string }[] {
  const items: { seq: number; time: number; text: string }[] = []
  for (const ev of events) {
    if (!ev || ev.type !== 'user/message') continue
    const source = ev.data?.source
    if (!source || source.kind !== 'user') continue
    items.push({
      seq: typeof ev.seq === 'number' ? ev.seq : 0,
      time: typeof ev.time === 'number' ? ev.time : 0,
      text: textOf(ev.data?.content),
    })
  }
  items.sort((a, b) => a.seq - b.seq)
  return items
}

/** Count non-text content blocks (images / attachments) in one message. */
function attachmentCount(content: readonly HistoryContentBlock[] | undefined): number {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (b && typeof b.type === 'string' && b.type !== 'text') n++
  }
  return n
}

/**
 * Build the interaction-turn list from one event log (spec F2): a new turn
 * opens at every human `user/message`; a following `steering` user message
 * joins the same turn; `assistant/message` text and `tool/call` events
 * accumulate into the turn they fall inside. Seq-ascending output.
 */
function collectTurns(events: readonly HistorySessionEvent[]): TurnItem[] {
  const turns: TurnItem[] = []
  let cur: TurnItem | null = null
  for (const ev of events) {
    if (!ev || typeof ev.seq !== 'number') continue
    const source = ev.data?.source
    const kind = source?.kind
    if (ev.type === 'user/message') {
      if (kind === 'user') {
        cur = {
          seq: ev.seq,
          time: typeof ev.time === 'number' ? ev.time : 0,
          userText: textOf(ev.data?.content),
          userAttachments: attachmentCount(ev.data?.content),
          assistantText: '',
          toolCalls: 0,
        }
        turns.push(cur)
        continue
      }
      // Steering belongs to the open turn's user part.
      if (kind === 'steering' && cur !== null) {
        const t = textOf(ev.data?.content)
        if (t !== '') cur.userText = cur.userText === '' ? t : `${cur.userText} ${t}`
        continue
      }
    }
    if (cur === null) continue
    if (ev.type === 'assistant/message') {
      const t = textOf(ev.data?.content)
      if (t !== '') cur.assistantText = cur.assistantText === '' ? t : `${cur.assistantText} ${t}`
    } else if (ev.type === 'assistant/chunk') {
      // Streaming text lives in text-delta chunks; reasoning deltas are the
      // thinking block and must not appear in the preview (spec F3).
      const chunk = ev.data?.chunk
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        cur.assistantText += chunk.text
      }
    } else if (ev.type === 'tool/call') {
      cur.toolCalls += 1
    }
  }
  return turns
}

/** Per-session turn-list cache (mirrors the user-message cache). */
const turnCache = new Map<string, { at: number; turns: TurnItem[] }>()

const TURN_CACHE_TTL = 3000
const TURN_CACHE_MAX = 50

/* ------------------------- 磁盘缓存（持久层） ------------------------- */

/**
 * 会话历史只增不改，轮次/消息列表可以持久化：请求命中磁盘缓存时直接返回，
 * 真实数据由后台任务按间隔渐进刷新（先展示、再校准），冷启动/大会话不再
 * 阻塞在 `readSession` 磁盘读取上。
 */
type DiskKind = 'turns' | 'messages'

/** 缓存根目录：~/.dsh/timeline-cache/（与 DSH 用户数据同层）。 */
const CACHE_ROOT = join(homedir(), '.dsh', 'timeline-cache')
/** 同会话真实数据刷新的最小间隔：历史不会自己改动，无需高频。 */
const CACHE_REFRESH_GAP_MS = 15000
/** 启动温:逐会话生成缓存时的间隔，避免扫描风暴。 */
const WARMUP_STAGGER_MS = 500

/** 后台刷新单飞：正在刷新中的会话 id 集合。 */
const refreshJobs = new Set<string>()

/** 缓存文件名安全化：sessionId 中的异常字符防路径逃逸。 */
function safeCacheName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

function diskCachePath(kind: DiskKind, id: string): string {
  return join(CACHE_ROOT, `${kind}-${safeCacheName(id)}.json`)
}

/** 读磁盘缓存；不存在或损坏视为未命中。 */
function readDiskCache<T>(kind: DiskKind, id: string): { at: number; data: T } | undefined {
  try {
    const path = diskCachePath(kind, id)
    if (!existsSync(path)) return undefined
    const box = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; data?: unknown }
    if (typeof box.at !== 'number' || !Array.isArray(box.data)) return undefined
    return { at: box.at, data: box.data as T }
  } catch {
    return undefined
  }
}

/** 写磁盘缓存（原子写：先写临时文件再 rename，避免半写坏档）。 */
function writeDiskCache<T>(kind: DiskKind, id: string, data: T): void {
  try {
    mkdirSync(CACHE_ROOT, { recursive: true })
    const path = diskCachePath(kind, id)
    const tmp = join(CACHE_ROOT, `.tmp-${safeCacheName(id)}-${process.pid}`)
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), data }), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    console.warn('[dsh-timeline] 缓存写入失败:', err)
  }
}

/** 内存缓存写入（带容量上限的简单 FIFO 淘汰）。 */
function storeHistoryCache(sessionId: string, items: { seq: number; time: number; text: string }[]): void {
  if (historyCache.size >= HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest !== undefined) historyCache.delete(oldest)
  }
  historyCache.set(sessionId, { at: Date.now(), items })
}

function storeTurnCache(sessionId: string, turns: TurnItem[]): void {
  if (turnCache.size >= TURN_CACHE_MAX) {
    const oldest = turnCache.keys().next().value
    if (oldest !== undefined) turnCache.delete(oldest)
  }
  turnCache.set(sessionId, { at: Date.now(), turns })
}

/** 读某会话的真实事件列表（live 内存优先、磁盘回退）；undefined = 无可用来源。 */
async function readSessionEvents(ctx: Context, sessionId: string): Promise<readonly HistorySessionEvent[] | undefined> {
  const sessions = ctx.get('sessions') as HistorySessionStore | undefined
  const liveEvents = sessions?.get(sessionId)?.events
  if (liveEvents !== undefined) return liveEvents
  const sessionQuery = ctx.get('sessionQuery') as HistorySessionQuery | undefined
  if (sessionQuery === undefined) return undefined
  const snapshot = await sessionQuery.readSession(sessionId)
  return snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
}

/** 后台渐进刷新：读真实数据 → 写盘 + 写内存缓存（单飞，失败静默待下轮）。 */
async function refreshSession(ctx: Context, kind: DiskKind, sessionId: string): Promise<void> {
  let events: readonly HistorySessionEvent[] | undefined
  try {
    events = await readSessionEvents(ctx, sessionId)
  } catch {
    return
  }
  if (events === undefined) return
  if (kind === 'turns') {
    const turns = collectTurns(events ?? [])
    writeDiskCache(kind, sessionId, turns)
    storeTurnCache(sessionId, turns)
  } else {
    const items = collectUserMessages(events ?? [])
    writeDiskCache(kind, sessionId, items)
    storeHistoryCache(sessionId, items)
  }
}

/** 调度一次后台刷新：距上次真实数据足够久且没有在途任务时才开始。 */
function scheduleRefresh(ctx: Context, kind: DiskKind, sessionId: string, lastAt: number): void {
  if (Date.now() - lastAt < CACHE_REFRESH_GAP_MS) return
  if (refreshJobs.has(sessionId)) return
  refreshJobs.add(sessionId)
  void refreshSession(ctx, kind, sessionId)
    .catch(() => { /* 静默：下一请求再试 */ })
    .finally(() => { refreshJobs.delete(sessionId) })
}

/**
 * 启动预热：扫描 DSH 会话目录（~/.dsh/sessions/<workspace>/<sessionId>/），
 * 对还没有磁盘缓存的会话逐个后台生成（一次 500ms 节流）；目录形态变化时
 * 静默跳过，不影响正常请求路径。
 */
async function warmUpCache(ctx: Context): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  await sleep(2000)
  const root = join(homedir(), '.dsh', 'sessions')
  let dirs: string[] = []
  try {
    const workspaces = existsSync(root) ? readdirSync(root) : []
    for (const workspace of workspaces) {
      try {
        dirs.push(...readdirSync(join(root, workspace)))
      } catch {
        /* 单个工作区不可读则跳过 */
      }
    }
  } catch (err) {
    console.warn('[dsh-timeline] 会话目录扫描失败:', err)
    return
  }
  let built = 0
  for (const name of dirs) {
    if (built >= 300) return
    // 目录名可能是 "session-<uuid>" 形态，剥离前缀后再试
    const candidates = [name, name.replace(/^session-/, '')]
    for (const id of candidates) {
      if (id === '' || built >= 300) continue
      if (readDiskCache<TurnItem[]>('turns', id) !== undefined) break // 已有缓存：跳过
      if (refreshJobs.has(id)) break
      refreshJobs.add(id)
      void refreshSession(ctx, 'turns', id)
        .catch(() => {})
        .finally(() => { refreshJobs.delete(id) })
      built++
      await sleep(WARMUP_STAGGER_MS)
      break
    }
  }
  console.log(`[dsh-timeline] 启动预热完成：本次生成 ${built} 个轮次缓存`)
}

/** One API method dispatch: full turn list for the timeline (spec F2-F5). */
async function listTurns(ctx: Context, payload: unknown): Promise<TurnsOk | HistoryErr> {
  const record = payload as { sessionId?: unknown } | null
  const sessionId = record?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少 sessionId' }
  }
  const cached = turnCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < TURN_CACHE_TTL) {
    return { ok: true, turns: cached.turns, total: cached.turns.length }
  }
  // 磁盘缓存：命中即返回，不阻塞真实读取；后台按需渐进刷新（历史只增不改）。
  const disk = readDiskCache<TurnItem[]>('turns', sessionId)
  if (disk !== undefined) {
    storeTurnCache(sessionId, disk.data)
    scheduleRefresh(ctx, 'turns', sessionId, disk.at)
    return { ok: true, turns: disk.data, total: disk.data.length }
  }
  // 无缓存：首次生成（实时读 → 内存 + 落盘）。
  let events: readonly HistorySessionEvent[] | undefined
  try {
    events = await readSessionEvents(ctx, sessionId)
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
  if (events === undefined) return { ok: false, error: 'sessionQuery 服务不可用' }
  const turns = collectTurns(events ?? [])
  storeTurnCache(sessionId, turns)
  writeDiskCache('turns', sessionId, turns)
  return { ok: true, turns, total: turns.length }
}

/** Write a JSON response with the given status. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(text)
}

/**
 * Plugin body: mount the fenced /history/api route.
 * @param ctx - host plugin context (webServer, webRuntime).
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/history/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/history/api/') ? pathname.slice('/history/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'unknown history API method' })
        return
      }
      if (method === 'list-user-messages') {
        try {
          const payload = await readJsonBody(req)
          const result = await listUserMessages(ctx, payload)
          writeJson(res, result.ok ? 200 : 400, result)
        } catch (err) {
          writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      if (method === 'list-turns') {
        try {
          const payload = await readJsonBody(req)
          const result = await listTurns(ctx, payload)
          writeJson(res, result.ok ? 200 : 400, result)
        } catch (err) {
          writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      writeJson(res, 404, { ok: false, error: `unknown history API method "${method}"` })
    },
  }), 'dsh-timeline: /history/api route')
  // 启动预热：后台为没有磁盘缓存的会话逐个生成轮次缓存，不阻塞启动。
  void warmUpCache(ctx)
}
