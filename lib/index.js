/**
 * dsh-peak-guard — host half.
 *
 * DeepSeek bills peak hours at roughly double the off-peak rate. Peak is
 * defined by the official price page as 01:00–04:00 and 06:00–10:00 UTC on
 * Monday–Friday, excluding Chinese public holidays; every other moment is
 * off-peak (all day on weekends and holidays).
 *
 * This plugin keeps a wall-clock state machine over that calendar:
 *
 *   warn     — a peak window starts within `warnMinutes`; selected sessions
 *              get a heads-up telling them to wrap up at the next boundary
 *   peak     — selected sessions are asked to stop, and after `graceMinutes`
 *              their running turn is cancelled the way the user's own stop
 *              button cancels it
 *   offpeak  — selected sessions get a resume reminder, which wakes even a
 *              cold session and tells the agent to continue from NEXT.md
 *
 * Deliveries ride the Host reminder service (`schedule.create`), the only
 * supported way to inject a durable user message into a session. Cancelling a
 * turn uses the same call the session API's stop button uses,
 * `agent.cancel({ kind: 'user' }, { keepInbox: true })`.
 *
 * @module dsh-peak-guard
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-peak-guard'

export const inject = ['webServer']

const API = '/api/dsh-peak-guard'

/** Harness home; honours DSH_HOME so a second (isolated) instance keeps its own state. */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const HOME_DIR = join(DSH_HOME, 'dsh-peak-guard')
const CONFIG_FILE = join(HOME_DIR, 'config.json')

/**
 * Phase snapshot read by other plugins (dsh-approval-inbox holds approvals for
 * the off-peak boundary). It is a projection, never a source of truth: this
 * plugin keeps the calendar in memory and rewrites the file on every tick.
 */
const STATE_FILE = join(HOME_DIR, 'state.json')

/** Peak windows in UTC hours: [startHour, endHour). */
const PEAK_WINDOWS = [
  [1, 4],
  [6, 10],
]

/** Minutes from UTC to the calendar the holiday rule is written in. */
const BEIJING_OFFSET_MINUTES = 8 * 60

const TICK_MS = 20000
const MAX_SCAN_MINUTES = 4 * 24 * 60

const DEFAULT_CONFIG = {
  enabled: true,
  warnMinutes: 30,
  graceMinutes: 3,
  notifyOnWarn: true,
  stopPrompt:
    '【高峰价时段开始】现在起进入 DeepSeek 高峰价计费（约为低谷价的 2 倍）。请立刻收尾：把当前进度、未完成项和下一步写进项目根目录的 NEXT.md，然后结束本轮，不要开启新的工具调用。',
  warnPrompt:
    '【高峰价预警】{minutes} 分钟后进入 DeepSeek 高峰价时段（约为低谷价 2 倍）。请抓紧把当前这一步做完，并把进度写进 NEXT.md；到点后我会通知你停止。',
  resumePrompt:
    '【低谷价时段开始】现在进入 DeepSeek 低谷价计费。继续之前被高峰暂停的开发任务：先读项目根目录的 NEXT.md（如果存在）接上进度，再继续推进，完成后更新 NEXT.md。',
  sessions: {},
  days: {},
}

let ctxRef = null
let config = null
let holidays = null
let holidaySource = 'weekend-only'
let state = { phase: null, lastChangeAt: null, lastAction: null, timers: new Set() }

// ------------------------------------------------------------------ helpers

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return { ...DEFAULT_CONFIG, ...parsed, sessions: { ...(parsed.sessions ?? {}) }, days: { ...(parsed.days ?? {}) } }
  } catch {
    return { ...DEFAULT_CONFIG, sessions: {}, days: {} }
  }
}

function saveConfig() {
  mkdirSync(HOME_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Publish the current phase for other plugins to read.
 *
 * Written on every tick rather than only on changes: a consumer that finds the
 * file older than a few minutes treats it as absent and falls back to its own
 * calendar, so freshness is the contract. A failed write is contained — it can
 * never break the guard itself.
 *
 * @param current - evaluated calendar
 */
function publishState(current) {
  try {
    mkdirSync(HOME_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      phase: current.phase,
      updatedAt: new Date().toISOString(),
      nextChangeAt: iso(current.nextChangeAt),
      nextPeakStartAt: iso(current.nextPeakStartAt),
      nextOffpeakStartAt: iso(current.nextOffpeakStartAt),
      workday: current.workday,
      enabled: config.enabled,
      lastAction: state.lastAction,
      version: 1,
    }, null, 2) + '\n')
  } catch {
    // The guard's own duties never depend on this file.
  }
}

/** Load the Chinese holiday calendar once; degrade to weekends when absent. */
async function loadHolidays() {
  if (holidays !== null) return
  try {
    const mod = await import('chinese-days')
    const api = mod.default ?? mod
    if (typeof api.isWorkday === 'function') {
      holidays = api
      holidaySource = 'chinese-days'
      return
    }
    holidays = false
  } catch {
    holidays = false
  }
}

function isWorkday(dateString) {
  const override = config.days[dateString]
  if (override === 'workday') return true
  if (override === 'holiday') return false
  if (holidays) {
    try {
      return Boolean(holidays.isWorkday(dateString))
    } catch {
      // Fall through to the weekday rule.
    }
  }
  const day = new Date(dateString + 'T00:00:00Z').getUTCDay()
  return day !== 0 && day !== 6
}

function iso(ts) {
  return ts === null || ts === undefined ? null : new Date(ts).toISOString()
}

function beijingDateString(ts) {
  return new Date(ts + BEIJING_OFFSET_MINUTES * 60000).toISOString().slice(0, 10)
}

function peakAt(ts) {
  const utc = new Date(ts)
  const hour = utc.getUTCHours()
  const inWindow = PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end)
  if (!inWindow) return false
  return isWorkday(beijingDateString(ts))
}

/** Next minute-aligned instant (>= from) where `predicate` differs from its value at `from`. */
function nextFlip(from, predicate) {
  const start = Math.floor(from / 60000) * 60000
  const initial = predicate(start)
  for (let index = 1; index <= MAX_SCAN_MINUTES; index += 1) {
    const at = start + index * 60000
    if (predicate(at) !== initial) return at
  }
  return null
}

/** Evaluate the calendar at `ts`. */
function evaluate(ts) {
  const now = Date.now()
  const peak = peakAt(ts)
  const nextFlipAt = nextFlip(ts, peakAt)
  const warnMs = Math.max(0, Number(config.warnMinutes) || 0) * 60000
  const warn = !peak && nextFlipAt !== null && peakAt(nextFlipAt) && nextFlipAt - ts <= warnMs
  return {
    phase: peak ? 'peak' : warn ? 'warn' : 'offpeak',
    workday: isWorkday(beijingDateString(ts)),
    beijingDate: beijingDateString(ts),
    nextChangeAt: nextFlipAt,
    nextPeakStartAt: peak ? ts : nextFlipAt !== null && peakAt(nextFlipAt) ? nextFlipAt : null,
    nextOffpeakStartAt: peak ? nextFlipAt : null,
    now,
  }
}

// --------------------------------------------------------------- sessions

/**
 * Session metadata comes from the host projection cache (one JSON per session).
 * The in-memory `sessions.list()` service only sees sessions this process has
 * loaded, which is why most of the user's workspace history was missing.
 */
const SESSION_CACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/** Any path inside the Harness home (.dsh) is infrastructure, not a user project. */
const HARNESS_PATH_RE = /[\\/]\.dsh[\\/]/i

/**
 * True when a path lives inside the Harness home directory.
 * @param path - workspace path from a session record.
 */
function isHarnessPath(path) {
  return HARNESS_PATH_RE.test(String(path ?? ''))
}

function projectLabel(cwd) {
  const text = String(cwd ?? '').trim()
  if (text === '') return '未绑定工作区'
  const parts = text.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || text
}

/**
 * Sessions under the Harness home are infrastructure — with one exception: the
 * Super Agent manager clones each managed repository into
 * `<DSH_HOME>/state/superagent-<name>/repos/<repo>` and registers that clone as a
 * sidebar workspace. Those sessions are the user's real work and stay visible;
 * only the orchestrator's own state-directory sessions are hidden.
 */
function isInternalSession(id, cwd, workspacePaths) {
  if (String(id).startsWith('orchestrator-')) return true
  if (!isHarnessPath(cwd)) return false
  const target = normalizePath(cwd)
  // Super Agent clones under any superagent state dir are user projects.
  if (/[\\/]\.dsh[\\/]state[\\/]superagent[^\\/]*[\\/]repos[\\/]/i.test(target)) return false
  // A registered clone workspace also counts; a bare state directory does not.
  return !workspacePaths.some(root => root.includes('\\repos\\') && insidePath(target, root))
}

/** Normalize a Windows path for case-insensitive containment checks. */
function normalizePath(path) {
  return String(path ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `cwd` is `root` itself or lives underneath it. */
function insidePath(cwd, root) {
  if (cwd === '' || root === '') return false
  if (cwd === root) return true
  return cwd.startsWith(root + '\\')
}

/** Registered workspace roots, normalized for containment checks. */
function workspaceRoots() {
  return workspaceOrder()
    .map(row => normalizePath(row.path))
    .filter(path => path !== '')
}

function readSessionMeta(raw, file, fileMtime) {
  const record = raw?.record ?? {}
  const identity = record.identity ?? {}
  const rows = record.rows ?? {}
  const rawTitle = typeof rows.title?.val === 'string' ? rows.title.val : ''
  const firstInput = rows.titleInput?.val?.first?.text
  const fallback = typeof firstInput === 'string' ? firstInput : ''
  const title = (rawTitle || fallback).replace(/\s+/g, ' ').trim()
  const cwd = String(identity.cwd ?? '')
  const display = title || '(未命名会话)'
  // The projection cache records the last user prompt; the file mtime covers
  // sessions that only ran turns after that (and older cache formats).
  const lastPromptAt = Number(rows.sessionListMetadata?.val?.lastPromptAt ?? 0)
  const createdAt = Number(identity.createdAt ?? 0)
  const lastActiveAt = Math.max(
    Number.isFinite(lastPromptAt) ? lastPromptAt : 0,
    Number.isFinite(fileMtime) ? fileMtime : 0,
    createdAt,
  )
  return {
    id: file.slice(0, -'.json'.length),
    title: display.length > 60 ? `${display.slice(0, 60)}…` : display,
    fullTitle: display,
    workspace: cwd,
    project: projectLabel(cwd),
    createdAt,
    lastActiveAt,
  }
}

async function readCachedSessions(workspacePaths) {
  let files = []
  try {
    files = (await readdir(SESSION_CACHE_DIR)).filter(entry => entry.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(await readFile(join(SESSION_CACHE_DIR, file), 'utf8'))
    } catch {
      continue
    }
    let mtime = 0
    try {
      mtime = (await stat(join(SESSION_CACHE_DIR, file))).mtimeMs
    } catch {
      // A vanished cache file still has usable content from the read above.
    }
    const meta = readSessionMeta(raw, file, mtime)
    if (isInternalSession(meta.id, meta.workspace, workspacePaths)) continue
    out.push(meta)
  }
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return out
}

async function listSessions() {
  const roots = workspaceRoots()
  const rows = await readCachedSessions(roots)
  const seen = new Set(rows.map(row => row.id))

  // Sessions created since the projection cache was last written still deserve a row.
  const live = ctxRef?.get?.('sessions')
  if (live !== undefined) {
    try {
      const listed = typeof live.list === 'function' ? live.list() : undefined
      for (const row of Array.isArray(listed) ? listed : []) {
        const id = String(row?.id ?? row?.header?.id ?? '')
        const cwd = String(row?.cwd ?? row?.header?.cwd ?? '')
        if (id === '' || seen.has(id) || isInternalSession(id, cwd, roots)) continue
        seen.add(id)
        const title = String(row?.title ?? row?.header?.title ?? '(新会话)')
        const workspace = cwd
        rows.unshift({ id, title, fullTitle: title, workspace, project: projectLabel(cwd), createdAt: Date.now(), lastActiveAt: Date.now() })
      }
    } catch {
      // The live service is a bonus source; the cache above already covers history.
    }
  }

  const limit = Math.min(200, Math.max(5, Number(config.maxSessions) || 120))
  return rows.slice(0, limit).map(row => ({
    id: row.id,
    title: row.title,
    fullTitle: row.fullTitle,
    workspace: row.workspace ?? row.cwd ?? '',
    project: row.project,
    createdAt: row.createdAt === 0 ? null : iso(row.createdAt),
    lastActiveAt: row.lastActiveAt ? iso(row.lastActiveAt) : null,
  }))
}

function selectedSessions(kind) {
  const out = []
  for (const [sessionId, flags] of Object.entries(config.sessions ?? {})) {
    if (flags && flags[kind]) out.push({ sessionId, flags })
  }
  return out
}

// -------------------------------------------------------------- delivery

/**
 * Deliver one durable user message to a session through the Host reminder
 * service. `after_seconds: 1` makes it land on the next drive pass.
 *
 * @param {string} sessionId target session
 * @param {string} prompt message text
 * @param {string} title short reminder title
 * @returns {Promise<{ok: boolean, error?: string}>} delivery outcome
 */
async function deliver(sessionId, prompt, title) {
  const schedule = ctxRef?.get?.('schedule')
  if (!schedule || typeof schedule.create !== 'function') {
    return { ok: false, error: 'schedule service unavailable' }
  }
  try {
    await schedule.create(sessionId, {
      title: String(title).slice(0, 120),
      prompt,
      after_seconds: 1,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Cancel one session's running turn the way the GUI stop button does. */
function stopTurn(sessionId) {
  const agents = ctxRef?.get?.('agents')
  if (!agents || typeof agents.get !== 'function') return { ok: false, error: 'agents service unavailable' }
  const agent = agents.get(sessionId)
  if (agent === undefined) return { ok: false, error: 'session not attached (idle)' }
  try {
    if (typeof agent.cancel === 'function') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { ok: true }
    }
    return { ok: false, error: 'agent has no cancel()' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function clearTimers() {
  for (const timer of state.timers) clearTimeout(timer)
  state.timers.clear()
}

function scheduleOnce(delayMs, fn) {
  const timer = setTimeout(() => {
    state.timers.delete(timer)
    try {
      fn()
    } catch (error) {
      ctxRef?.logger?.warn?.(`[dsh-peak-guard] action failed: ${String(error)}`)
    }
  }, Math.max(0, delayMs))
  timer.unref?.()
  state.timers.add(timer)
  return timer
}

// ---------------------------------------------------------------- actions

async function warnSelected(minutes) {
  const text = String(config.warnPrompt).replace('{minutes}', String(minutes))
  const results = []
  for (const { sessionId } of selectedSessions('autoStop')) {
    results.push({ sessionId, kind: 'warn', ...(await deliver(sessionId, text, '高峰价预警')) })
  }
  return results
}

async function stopSelected() {
  const results = []
  const targets = selectedSessions('autoStop')
  for (const { sessionId } of targets) {
    results.push({ sessionId, kind: 'stop-request', ...(await deliver(sessionId, config.stopPrompt, '高峰价：停止')) })
  }
  const graceMs = Math.max(0, Number(config.graceMinutes) || 0) * 60000
  scheduleOnce(graceMs, () => {
    const cancelled = []
    for (const { sessionId } of targets) {
      cancelled.push({ sessionId, ...stopTurn(sessionId) })
    }
    state.lastAction = { at: new Date().toISOString(), kind: 'hard-stop', cancelled }
  })
  return results
}

async function resumeSelected() {
  const results = []
  for (const { sessionId } of selectedSessions('autoResume')) {
    results.push({ sessionId, kind: 'resume', ...(await deliver(sessionId, config.resumePrompt, '低谷价：继续')) })
  }
  return results
}

async function runTransition(previous, current) {
  clearTimers()
  state.phase = current.phase
  state.lastChangeAt = new Date().toISOString()
  if (!config.enabled) {
    state.lastAction = { at: state.lastChangeAt, kind: 'disabled-transition', previous, current: current.phase }
    return
  }
  if (current.phase === 'warn' && previous !== 'warn' && config.notifyOnWarn) {
    const minutes = Math.max(1, Math.round((current.nextPeakStartAt - Date.now()) / 60000))
    const results = await warnSelected(minutes)
    state.lastAction = { at: new Date().toISOString(), kind: 'warn', minutes, results }
    return
  }
  if (current.phase === 'peak' && previous !== 'peak') {
    const results = await stopSelected()
    state.lastAction = { at: new Date().toISOString(), kind: 'stop', results }
    return
  }
  if (current.phase === 'offpeak' && (previous === 'peak' || previous === 'warn')) {
    const results = await resumeSelected()
    state.lastAction = { at: new Date().toISOString(), kind: 'resume', results }
    return
  }
  state.lastAction = { at: new Date().toISOString(), kind: 'transition', previous, current: current.phase }
}

async function tick() {
  if (!config) return
  const current = evaluate(Date.now())
  if (state.phase === null) {
    state.phase = current.phase
    publishState(current)
    return
  }
  const samePhase = state.phase === current.phase
  if (samePhase) {
    publishState(current)
    return
  }
  const previous = state.phase
  await runTransition(previous, current.phase)
  publishState(evaluate(Date.now()))
}

// ------------------------------------------------------------------ routes

/**
 * Workspaces in the order the sidebar lists them, used by the "工作区顺序"
 * sort. Falls back to an empty list (the client then sorts by name).
 * @returns ordered workspace paths
 */
function workspaceOrder() {
  const registry = ctxRef?.get?.('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return []
  try {
    const rows = registry.list()
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({ path: String(row?.path ?? ''), title: String(row?.title ?? '') }))
      .filter(row => row.path !== '')
  } catch {
    return []
  }
}

function statePayload() {
  const current = evaluate(Date.now())
  return {
    ok: true,
    now: new Date().toISOString(),
    phase: current.phase,
    workday: current.workday,
    beijingDate: current.beijingDate,
    nextChangeAt: iso(current.nextChangeAt),
    nextPeakStartAt: iso(current.nextPeakStartAt),
    nextOffpeakStartAt: iso(current.nextOffpeakStartAt),
    holidaySource,
    config,
    lastAction: state.lastAction,
    lastChangeAt: state.lastChangeAt,
    workspaces: workspaceOrder(),
  }
}

function routes() {
  return [
    {
      kind: 'exact',
      path: API + '/state',
      handler: async (req, res) => {
        const payload = statePayload()
        payload.sessions = await listSessions()
        writeJson(res, 200, payload)
      },
    },
    {
      kind: 'exact',
      path: API + '/action',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'POST required' })
          return
        }
        const body = await readBody(req).catch(error => ({ error: String(error) }))
        const kind = String(body.kind ?? '')
        if (kind === 'warn') {
          const results = await warnSelected(Number(config.warnMinutes) || 30)
          state.lastAction = { at: new Date().toISOString(), kind: 'warn-manual', results }
          writeJson(res, 200, { ok: true, results })
          return
        }
        if (kind === 'stop') {
          const results = await stopSelected()
          state.lastAction = { at: new Date().toISOString(), kind: 'stop-manual', results }
          writeJson(res, 200, { ok: true, results })
          return
        }
        if (kind === 'resume') {
          const results = await resumeSelected()
          state.lastAction = { at: new Date().toISOString(), kind: 'resume-manual', results }
          writeJson(res, 200, { ok: true, results })
          return
        }
        if (kind === 'cancel-now') {
          const sessionId = String(body.sessionId ?? '')
          const result = sessionId === '' ? { ok: false, error: 'sessionId required' } : stopTurn(sessionId)
          writeJson(res, 200, { ok: true, result })
          return
        }
        writeJson(res, 400, { ok: false, error: 'unknown kind: ' + kind })
      },
    },
    {
      kind: 'exact',
      path: API + '/config',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'POST required' })
          return
        }
        const patch = await readBody(req).catch(error => ({ error: String(error) }))
        if (patch.ok === false) {
          writeJson(res, 400, { ok: false, error: String(patch.error) })
          return
        }
        const next = { ...config }
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
        if (typeof patch.notifyOnWarn === 'boolean') next.notifyOnWarn = patch.notifyOnWarn
        if (Number.isFinite(Number(patch.warnMinutes))) next.warnMinutes = Math.min(180, Math.max(0, Number(patch.warnMinutes)))
        if (Number.isFinite(Number(patch.graceMinutes))) next.graceMinutes = Math.min(60, Math.max(0, Number(patch.graceMinutes)))
        if (typeof patch.stopPrompt === 'string' && patch.stopPrompt.trim() !== '') next.stopPrompt = patch.stopPrompt
        if (typeof patch.warnPrompt === 'string' && patch.warnPrompt.trim() !== '') next.warnPrompt = patch.warnPrompt
        if (typeof patch.resumePrompt === 'string' && patch.resumePrompt.trim() !== '') next.resumePrompt = patch.resumePrompt
        if (patch.sessions && typeof patch.sessions === 'object') {
          const merged = { ...next.sessions }
          for (const [sessionId, flags] of Object.entries(patch.sessions)) {
            if (flags === null) {
              delete merged[sessionId]
              continue
            }
            merged[sessionId] = {
              autoStop: Boolean(flags && flags.autoStop),
              autoResume: Boolean(flags && flags.autoResume),
            }
          }
          next.sessions = merged
        }
        if (patch.days && typeof patch.days === 'object') {
          const merged = { ...next.days }
          for (const [date, flag] of Object.entries(patch.days)) {
            if (flag !== 'holiday' && flag !== 'workday') {
              delete merged[date]
              continue
            }
            merged[date] = flag
          }
          next.days = merged
        }
        config = next
        saveConfig()
        const current = evaluate(Date.now())
        if (state.phase !== current.phase) state.phase = current.phase
        writeJson(res, 200, { ok: true, config })
      },
    },
  ]
}

// ------------------------------------------------------------------- apply

export function apply(ctx) {
  ctxRef = ctx
  config = loadConfig()

  const disposers = routes().map(route => ctx.webServer.register(route))

  const boot = async () => {
    await loadHolidays()
    if (!config) return
    const current = evaluate(Date.now())
    state.phase = current.phase
    publishState(current)
    ctx.logger?.info?.(`[dsh-peak-guard] calendar=${holidaySource} phase=${state.phase}`)
  }
  boot().catch(() => {})

  const interval = setInterval(() => {
    tick().catch(error => ctx.logger?.warn?.(`[dsh-peak-guard] tick failed: ${String(error)}`))
  }, TICK_MS)
  interval.unref?.()

  ctx.effect(() => () => {
    clearInterval(interval)
    clearTimers()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
  }, 'dsh-peak-guard: calendar routes and tick')
}
