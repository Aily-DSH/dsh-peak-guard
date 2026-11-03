/**
 * dsh-peak-guard — browser half.
 *
 * Seats one settings section ("峰谷价自动停启") where the user:
 *   - enables the guard,
 *   - picks which conversations should auto-stop at peak and auto-resume at
 *     off-peak (the checkbox list),
 *   - tunes the warning lead time and the stop grace period,
 *   - edits the resume/stop prompts and holiday overrides, and
 *   - fires the three actions manually for a dry run.
 *
 * The host half owns the calendar, the tick, the message delivery and the
 * turn cancellation; this bundle only drives the API and renders state.
 *
 * @module dsh-peak-guard/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-peak-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-peak-guard'
    const SETTINGS_SECTION = 'settings.section'
    const SECTION_ID = 'dsh-peak-guard'
    const SECTION_ORDER = 154

    /** Host API paths (document-relative: the GUI is served with `<base href="./">`). */
    const STATE_PATH = 'api/dsh-peak-guard/state'
    const CONFIG_PATH = 'api/dsh-peak-guard/config'
    const ACTION_PATH = 'api/dsh-peak-guard/action'

    const FETCH_TIMEOUT_MS = 30000

    const dictionaries = {
      zh: { 'dsh-peak-guard.title': '峰谷价自动停启' },
      en: { 'dsh-peak-guard.title': 'Peak-hour guard' },
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Fetch JSON from the host half.
     * @param {string} path document-relative API path
     * @param {object} [options] fetch options
     * @returns {Promise<object>} parsed payload
     */
    async function apiFetch(path, options = {}) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
      try {
        const response = await fetch(path, {
          method: options.method || 'GET',
          headers: options.body ? { 'content-type': 'application/json' } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined,
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
        })
        const text = await response.text()
        let payload = null
        try {
          payload = text ? JSON.parse(text) : null
        } catch {
          payload = null
        }
        if (!response.ok) {
          const reason = payload && payload.error ? payload.error : 'HTTP ' + response.status
          throw new Error(reason)
        }
        return payload || {}
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /** Format an instant as local HH:MM. */
    function clock(iso) {
      if (!iso) return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return '—'
      return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    /** Human countdown to an instant. */
    function countdown(iso) {
      if (!iso) return '—'
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return '—'
      const total = Math.max(0, Math.round((at.getTime() - Date.now()) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return hours + ' 小时 ' + minutes + ' 分后'
      if (minutes > 0) return minutes + ' 分 ' + seconds + ' 秒后'
      return seconds + ' 秒后'
    }

    /** Phase appearance. */
    function phaseMeta(phase) {
      if (phase === 'peak') return { label: '高峰价时段', color: '#e05a47' }
      if (phase === 'warn') return { label: '即将进入高峰', color: '#d99323' }
      return { label: '低谷价时段', color: '#3c9a6a' }
    }

    /** Convert a day-override map to editable text. */
    function daysToText(days) {
      return Object.entries(days || {})
        .map(([date, flag]) => date + '=' + flag)
        .join('\n')
    }

    /** Parse editable text back to a day-override map. */
    function textToDays(text) {
      const out = {}
      for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const [date, flag] = trimmed.split('=').map(part => part.trim())
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue
        if (flag === 'holiday' || flag === 'workday') out[date] = flag
      }
      return out
    }

    // ----------------------------------------------------------------- styles

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0 24px', maxWidth: '820px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
      subtitle: { marginTop: '4px', fontSize: '12px', opacity: 0.62, lineHeight: 1.6 },
      group: { display: 'flex', flexDirection: 'column', gap: '8px' },
      groupTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.75 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' },
      card: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(128,128,128,0.18)' },
      switchRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', lineHeight: 1.5, cursor: 'pointer' },
      switchHint: { fontSize: '11px', opacity: 0.55, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' },
      input: { width: '80px', padding: '4px 8px', fontSize: '13px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' },
      textarea: { width: '100%', minHeight: '58px', padding: '6px 8px', fontSize: '12px', lineHeight: 1.5, borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', resize: 'vertical', fontFamily: 'inherit' },
      sessionList: { display: 'flex', flexDirection: 'column', gap: '4px' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '6px 8px', borderRadius: '8px', background: 'rgba(128,128,128,0.08)' },
      select: { padding: '3px 8px', fontSize: '12px', lineHeight: '18px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.32)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      folderRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', padding: '5px 8px', borderRadius: '6px', background: 'rgba(128,128,128,0.10)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', userSelect: 'none' },
      caret: { width: '12px', flex: '0 0 auto', opacity: 0.7 },
      folderText: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
      folderName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
      folderPath: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10.5px', fontWeight: 400, opacity: 0.45 },
      folderNameRow: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      agentBadge: { flex: '0 0 auto', padding: '0 6px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, lineHeight: '16px', background: 'rgba(91, 141, 239, 0.14)', color: '#4b7bd6' },
      folderCount: { flex: '0 0 auto', fontSize: '11px', fontWeight: 400, opacity: 0.55 },
      folderButtons: { display: 'flex', gap: '4px', flex: '0 0 auto' },
      folderButton: { flex: '0 0 auto', padding: '2px 6px', fontSize: '10.5px', lineHeight: '16px', borderRadius: '5px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
      sessionRow: { display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '16px', padding: '6px 9px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.22)', fontSize: '13px' },
      sessionTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sessionMeta: { fontSize: '11px', opacity: 0.5, marginLeft: '6px' },
      badge: { padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, color: '#fff' },
      primaryButton: { padding: '5px 14px', fontSize: '13px', lineHeight: '18px', borderRadius: '6px', border: '1px solid transparent', background: '#5b8def', color: '#fff', cursor: 'pointer' },
      ghostButton: { padding: '4px 10px', fontSize: '12px', lineHeight: '18px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.32)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      muted: { fontSize: '12px', opacity: 0.55, lineHeight: 1.6 },
      error: { fontSize: '12px', color: '#e05a47', lineHeight: 1.6 },
      details: { border: '1px solid rgba(128,128,128,0.18)', borderRadius: '10px', padding: '8px 12px' },
      summary: { fontSize: '12px', fontWeight: 600, opacity: 0.75, cursor: 'pointer', userSelect: 'none' },
      detailsBody: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '10px' },
    }

    /**
     * One patch that sets a single flag (autoStop / autoResume) on every given
     * session; an entry is cleared only when both flags end up off.
     */
    function bulkSessionsPatch(sessions, overrides, field, on) {
      const patch = {}
      for (const session of sessions) {
        const flags = overrides[session.id] || {}
        const next = { autoStop: Boolean(flags.autoStop), autoResume: Boolean(flags.autoResume), [field]: on }
        patch[session.id] = next.autoStop || next.autoResume ? next : null
      }
      return patch
    }

    /** Sort modes for the session picker. */
    const SORT_MODES = [
      { value: 'workspace', label: '工作区顺序' },
      { value: 'recent', label: '最近运行' },
      { value: 'size', label: '会话数量' },
      { value: 'title', label: '会话名称' },
    ]
    const SORT_STORAGE_KEY = 'dsh-peak-guard.sortMode'

    /** Normalized workspace path used to match the sidebar order. */
    function workspaceKey(path) {
      return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    /** True when a workspace is a Super Agent project clone under the DSH home. */
    function isSuperAgentPath(path) {
      return /[\\/]\.dsh[\\/]state[\\/]superagent[^\\/]*[\\/]repos[\\/]/i.test(String(path || ''))
    }

    /** Short "x 分钟前" label for the last activity stamp. */
    function relativeTime(iso) {
      if (!iso) return ''
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const diff = Math.max(0, Date.now() - at)
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
      if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前'
      return new Date(at).toISOString().slice(0, 10)
    }

    /** Session type: prefer the explicit project label when the host sends one. */
    function projectOf(session) {
      const parts = String(session.workspace || '').split(/[\\/]+/).filter(Boolean)
      return session.project || parts[parts.length - 1] || '未绑定工作区'
    }

    /** Selection summary; quiet when every session is already picked. */
    function selectionLabel(picked, total) {
      if (total === 0) return '还没有会话'
      if (picked === 0) return total + ' 个会话'
      if (picked === total) return total + ' 个会话已全选'
      return '已选 ' + picked + ' / ' + total + ' 个会话'
    }

    /**
     * Group sessions by workspace and order the groups by the chosen mode.
     * The sidebar's workspace order is used for "工作区顺序" when available.
     */
    function groupSessions(sessions, sortMode, workspaces) {
      const order = new Map()
      for (let index = 0; index < (workspaces || []).length; index += 1) {
        const item = workspaces[index]
        if (!item || !item.path) continue
        const key = workspaceKey(item.path)
        if (!order.has(key)) order.set(key, index)
      }
      const groups = new Map()
      for (const session of sessions) {
        const path = String(session.workspace || '')
        const key = path || '未绑定工作区'
        const stamp = Date.parse(session.lastActiveAt || session.createdAt || '') || 0
        const bucket = groups.get(key)
        if (bucket === undefined) {
          groups.set(key, { workspace: key, path, project: projectOf(session), rows: [session], latest: stamp })
        } else {
          bucket.rows.push(session)
          bucket.latest = Math.max(bucket.latest, stamp)
        }
      }
      const list = [...groups.values()]
      for (const group of list) {
        group.rows.sort((a, b) => {
          if (sortMode === 'title') return String(a.title || a.id).localeCompare(String(b.title || b.id), 'zh-Hans-CN')
          const left = Date.parse(b.lastActiveAt || b.createdAt || '') || 0
          const right = Date.parse(a.lastActiveAt || a.createdAt || '') || 0
          return left - right
        })
      }
      const rank = group => order.has(workspaceKey(group.path)) ? order.get(workspaceKey(group.path)) : Number.MAX_SAFE_INTEGER
      list.sort((a, b) => {
        if (sortMode === 'recent') return b.latest - a.latest
        if (sortMode === 'size') return b.rows.length - a.rows.length || b.latest - a.latest
        if (sortMode === 'title') return a.project.localeCompare(b.project, 'zh-Hans-CN')
        return rank(a) - rank(b) || a.project.localeCompare(b.project, 'zh-Hans-CN')
      })
      return list
    }

    /**
     * Session picker as a folder tree: one collapsible row per workspace, the
     * conversations of that workspace nested underneath.
     */
    function buildSessionTree(groups, overrides, busy, patchConfig, openFolders, setOpenFolders) {
      const nodes = []
      groups.forEach((group, index) => {
        const workspace = group.workspace
        const rows = group.rows
        // First folder starts open; the rest stay folded.
        const open = openFolders[workspace] ?? index === 0
        const picked = rows.filter(row => overrides[row.id] !== undefined).length
        const summary = rows.length + ' 个会话' + (picked > 0 && picked < rows.length ? ' · 已选 ' + picked : '')
        nodes.push(
          h('div', {
            key: 'folder-' + workspace,
            style: styles.folderRow,
            title: group.path || workspace,
            'data-pg': 'folder',
            onClick: () => setOpenFolders(previous => ({ ...previous, [workspace]: !open })),
          }, [
            h('span', { key: 'caret', style: styles.caret }, open ? '▾' : '▸'),
            h('div', { key: 'text', style: styles.folderText }, [
              h('div', { key: 'nameRow', style: styles.folderNameRow }, [
                h('span', { key: 'name', style: styles.folderName, 'data-pg': 'folder-name' }, group.project),
                isSuperAgentPath(group.path) ? h('span', { key: 'agent', style: styles.agentBadge }, 'Super Agent') : null,
              ]),
              group.path ? h('span', { key: 'path', style: styles.folderPath, 'data-pg': 'folder-path' }, group.path) : null,
            ]),
            h('span', { key: 'count', style: styles.folderCount, 'data-pg': 'folder-count' }, summary),
            h('div', { key: 'buttons', style: styles.folderButtons }, [
              h('button', {
                key: 'folder-stop-on',
                type: 'button',
                style: styles.folderButton,
                disabled: busy,
                title: '本区全部勾选「高峰停止」',
                onClick: event => {
                  event.stopPropagation()
                  patchConfig({ sessions: bulkSessionsPatch(rows, overrides, 'autoStop', true) })
                },
              }, '停止开'),
              h('button', {
                key: 'folder-stop-off',
                type: 'button',
                style: styles.folderButton,
                disabled: busy,
                title: '本区全部取消「高峰停止」',
                onClick: event => {
                  event.stopPropagation()
                  patchConfig({ sessions: bulkSessionsPatch(rows, overrides, 'autoStop', false) })
                },
              }, '停止关'),
              h('button', {
                key: 'folder-resume-on',
                type: 'button',
                style: styles.folderButton,
                disabled: busy,
                title: '本区全部勾选「低谷恢复」',
                onClick: event => {
                  event.stopPropagation()
                  patchConfig({ sessions: bulkSessionsPatch(rows, overrides, 'autoResume', true) })
                },
              }, '恢复开'),
              h('button', {
                key: 'folder-resume-off',
                type: 'button',
                style: styles.folderButton,
                disabled: busy,
                title: '本区全部取消「低谷恢复」',
                onClick: event => {
                  event.stopPropagation()
                  patchConfig({ sessions: bulkSessionsPatch(rows, overrides, 'autoResume', false) })
                },
              }, '恢复关'),
            ]),
          ]),
        )
        if (open) for (const session of rows) nodes.push(sessionRowNode(session, overrides, busy, patchConfig))
      })
      return nodes
    }

    function sessionRowNode(session, overrides, busy, patchConfig) {
      const flags = overrides[session.id] || {}
      const toggle = (field, checked) => {
        const next = { ...overrides, [session.id]: { autoStop: Boolean(flags.autoStop), autoResume: Boolean(flags.autoResume), [field]: checked } }
        if (!next[session.id].autoStop && !next[session.id].autoResume) delete next[session.id]
        patchConfig({ sessions: { [session.id]: next[session.id] || null } })
      }
      const stamp = relativeTime(session.lastActiveAt || session.createdAt)
      return h('div', { key: session.id, style: styles.sessionRow, title: session.fullTitle || session.title || session.id, 'data-pg': 'session' }, [
        h('div', { key: 'title', style: styles.sessionTitle }, [
          h('span', { key: 't' }, session.title || session.id),
          h('span', { key: 'm', style: styles.sessionMeta }, [stamp, session.id.replace(/^session-/, '').slice(0, 8)].filter(Boolean).join(' · ')),
        ]),
        h('label', { key: 'stop', style: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', flex: '0 0 auto' } }, [
          h('input', { key: 'cb', type: 'checkbox', checked: Boolean(flags.autoStop), disabled: busy, onChange: event => toggle('autoStop', event.target.checked) }),
          h('span', { key: 'l' }, '高峰停止'),
        ]),
        h('label', { key: 'resume', style: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', flex: '0 0 auto' } }, [
          h('input', { key: 'cb', type: 'checkbox', checked: Boolean(flags.autoResume), disabled: busy, onChange: event => toggle('autoResume', event.target.checked) }),
          h('span', { key: 'l' }, '低谷恢复'),
        ]),
      ])
    }

    // ------------------------------------------------------------------ panel

    /** Settings section body. */
    function PeakGuardPanel() {
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [daysText, setDaysText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [, forceTick] = React.useState(0)
      const [openFolders, setOpenFolders] = React.useState({})
      const [sortMode, setSortMode] = React.useState(() => {
        try {
          const stored = window.localStorage.getItem(SORT_STORAGE_KEY)
          return SORT_MODES.some(mode => mode.value === stored) ? stored : 'workspace'
        } catch {
          return 'workspace'
        }
      })

      const reload = React.useCallback(async () => {
        setLoading(true)
        try {
          const payload = await apiFetch(STATE_PATH)
          setState(payload)
          setDraft({ ...payload.config })
          setDaysText(daysToText(payload.config.days))
          setError('')
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        reload()
      }, [reload])

      React.useEffect(() => {
        const timer = setInterval(() => forceTick(value => value + 1), 1000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        try {
          window.localStorage.setItem(SORT_STORAGE_KEY, sortMode)
        } catch {
          // A read-only or partitioned storage still keeps the in-memory mode.
        }
      }, [sortMode])

      const patchConfig = React.useCallback(async patch => {
        setBusy(true)
        try {
          const payload = await apiFetch(CONFIG_PATH, { method: 'POST', body: patch })
          setState(previous => ({ ...previous, config: payload.config }))
          setDraft({ ...payload.config })
          setDaysText(daysToText(payload.config.days))
          setError('')
          return true
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      const runAction = React.useCallback(async (kind, sessionId) => {
        setBusy(true)
        try {
          await apiFetch(ACTION_PATH, { method: 'POST', body: sessionId ? { kind, sessionId } : { kind } })
          await reload()
          return true
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
          return false
        } finally {
          setBusy(false)
        }
      }, [reload])

      if (loading && state === null) {
        return h('div', { style: styles.root }, h('div', { style: styles.muted }, '正在读取峰谷价状态…'))
      }

      const phase = state ? state.phase : 'offpeak'
      const meta = phaseMeta(phase)
      const config = draft || (state ? state.config : {})
      const sessions = (state && state.sessions) || []
      const overrides = (config.sessions) || {}

      const header = h('div', { style: styles.header }, [
        h('div', { key: 'text' }, [
          h('div', { key: 'title', style: styles.title }, '峰谷价自动停启'),
          h('div', { key: 'sub', style: styles.subtitle },
            '按 DeepSeek 官方峰谷价规则（工作日 UTC 01:00–04:00、06:00–10:00 为高峰，周末与法定节假日全天低谷；'
            + (state && state.holidaySource === 'chinese-days' ? '节假日含调休，数据来自 chinese-days' : '节假日数据不可用，仅按周末判断')
            + '）在高峰前提醒、高峰时停止、低谷时恢复你勾选的会话。'),
        ]),
        h('div', { key: 'status', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h('span', { key: 'badge', style: { ...styles.badge, background: meta.color } }, meta.label),
          h('span', { key: 'count', style: styles.muted },
            state && state.nextChangeAt ? '下次切换：' + clock(state.nextChangeAt) + '（' + countdown(state.nextChangeAt) + '）' : '下次切换：—'),
        ]),
      ])

      const switches = h('div', { key: 'switches', style: styles.group }, [
        h('div', { key: 't', style: styles.groupTitle }, '总开关'),
        h('label', { key: 'enabled', style: styles.switchRow }, [
          h('input', {
            key: 'cb',
            type: 'checkbox',
            checked: Boolean(config.enabled),
            disabled: busy,
            onChange: event => patchConfig({ enabled: event.target.checked }),
          }),
          h('div', { key: 'txt' }, [
            h('div', { key: 'h' }, '启用峰谷价守护'),
            h('div', { key: 'sub', style: styles.switchHint }, '关闭后不再自动提醒/停止/恢复，手动按钮仍可用。'),
          ]),
        ]),
        h('label', { key: 'warn', style: styles.switchRow }, [
          h('input', {
            key: 'cb',
            type: 'checkbox',
            checked: Boolean(config.notifyOnWarn),
            disabled: busy,
            onChange: event => patchConfig({ notifyOnWarn: event.target.checked }),
          }),
          h('div', { key: 'txt' }, [
            h('div', { key: 'h' }, '高峰前提前预告'),
            h('div', { key: 'sub', style: styles.switchHint }, '在高峰开始前给勾选了「高峰停止」的会话发一条收尾提醒。'),
          ]),
        ]),
      ])

      const timing = h('div', { key: 'timing', style: styles.group }, [
        h('div', { key: 't', style: styles.groupTitle }, '时间'),
        h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
          h('div', { key: 'warn', style: styles.row }, [
            h('span', { key: 'l' }, '提前预告（分钟）'),
            h('input', {
              key: 'i',
              style: styles.input,
              type: 'number',
              min: 0,
              max: 180,
              value: String(config.warnMinutes ?? 30),
              disabled: busy,
              onChange: event => setDraft(previous => ({ ...previous, warnMinutes: Number(event.target.value) })),
              onBlur: event => patchConfig({ warnMinutes: Number(event.target.value) }),
            }),
          ]),
          h('div', { key: 'grace', style: styles.row }, [
            h('span', { key: 'l' }, '停止宽限（分钟）'),
            h('input', {
              key: 'i',
              style: styles.input,
              type: 'number',
              min: 0,
              max: 60,
              value: String(config.graceMinutes ?? 3),
              disabled: busy,
              onChange: event => setDraft(previous => ({ ...previous, graceMinutes: Number(event.target.value) })),
              onBlur: event => patchConfig({ graceMinutes: Number(event.target.value) }),
            }),
            h('span', { key: 'hint', style: styles.muted }, '先发停止提醒，等这么久再强制取消仍在跑的回合'),
          ]),
        ]),
      ])

      const workspaces = (state && state.workspaces) || []
      const groups = groupSessions(sessions, sortMode, workspaces)
      const pickedSessions = sessions.filter(session => overrides[session.id] !== undefined).length
      const bulk = (field, on) =>
        patchConfig({ sessions: bulkSessionsPatch(sessions, overrides, field, on) })
      const bulkButton = (key, label, field, on, primary) =>
        h('button', {
          key,
          type: 'button',
          style: primary ? styles.primaryButton : styles.ghostButton,
          disabled: busy,
          onClick: () => bulk(field, on),
        }, label)
      const setAllFolders = open =>
        setOpenFolders(Object.fromEntries(groups.map(group => [group.workspace, open])))
      const sortControl = h('div', { key: 'sortbar', style: styles.toolbar }, [
        h('span', { key: 'l', style: styles.muted }, '排序'),
        h('select', {
          key: 'select',
          style: styles.select,
          'data-pg': 'sort',
          value: sortMode,
          disabled: busy,
          title: '工作区顺序＝侧边栏顺序；最近运行＝按最后活动时间',
          onChange: event => setSortMode(event.target.value),
        }, SORT_MODES.map(mode => h('option', { key: mode.value, value: mode.value }, mode.label))),
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h('button', { key: 'expand', type: 'button', style: styles.ghostButton, disabled: busy, onClick: () => setAllFolders(true) }, '展开全部'),
        h('button', { key: 'collapse', type: 'button', style: styles.ghostButton, disabled: busy, onClick: () => setAllFolders(false) }, '折叠全部'),
      ])
      const sessionSection = h('div', { key: 'sessions', style: styles.group }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } }, [
          h('div', { key: 't', style: styles.groupTitle }, '勾选要自动停止 / 恢复的会话'),
          h('div', { key: 'count', style: styles.muted, 'data-pg': 'count' }, selectionLabel(pickedSessions, sessions.length)),
        ]),
        h('div', { key: 'hint', style: styles.muted },
          '只有勾选过的会话会被处理；「高峰停止」＝高峰时收尾并停止，「低谷恢复」＝低谷时唤醒并继续。Super Agent 项目的会话带「Super Agent」标签，同样可以勾选。'),
        sortControl,
        h('div', { key: 'bulk', style: styles.toolbar }, [
          h('span', { key: 'l-stop', style: styles.muted }, '高峰停止'),
          bulkButton('stop-on', '全部开', 'autoStop', true, true),
          bulkButton('stop-off', '全部关', 'autoStop', false, false),
          h('span', { key: 'l-resume', style: { ...styles.muted, marginLeft: '10px' } }, '低谷恢复'),
          bulkButton('resume-on', '全部开', 'autoResume', true, true),
          bulkButton('resume-off', '全部关', 'autoResume', false, false),
        ]),
        h('div', { key: 'list', style: styles.sessionList },
          sessions.length === 0
            ? [h('div', { key: 'empty', style: styles.muted }, '还没有读到会话')]
            : buildSessionTree(groups, overrides, busy, patchConfig, openFolders, setOpenFolders),
        ),
      ])

      const prompts = h('div', { key: 'prompts', style: styles.group }, [
        h('div', { key: 't', style: styles.groupTitle }, '提示语'),
        h('div', { key: 'stop', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('div', { key: 'l', style: styles.muted }, '高峰停止提醒：'),
          h('textarea', {
            key: 'ta',
            style: styles.textarea,
            value: String(config.stopPrompt || ''),
            disabled: busy,
            onChange: event => setDraft(previous => ({ ...previous, stopPrompt: event.target.value })),
            onBlur: event => patchConfig({ stopPrompt: event.target.value }),
          }),
        ]),
        h('div', { key: 'resume', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
          h('div', { key: 'l', style: styles.muted }, '低谷恢复提醒：'),
          h('textarea', {
            key: 'ta',
            style: styles.textarea,
            value: String(config.resumePrompt || ''),
            disabled: busy,
            onChange: event => setDraft(previous => ({ ...previous, resumePrompt: event.target.value })),
            onBlur: event => patchConfig({ resumePrompt: event.target.value }),
          }),
        ]),
      ])

      const holidays = h('div', { key: 'days', style: styles.group }, [
        h('div', { key: 't', style: styles.groupTitle }, '节假日覆盖（每行 YYYY-MM-DD=holiday 或 =workday）'),
        h('div', { key: 'hint', style: styles.muted }, '用于日历数据未覆盖的年份或临时调休；留空表示按内置换算规则判断。'),
        h('textarea', {
          key: 'ta',
          style: styles.textarea,
          value: daysText,
          disabled: busy,
          onChange: event => setDaysText(event.target.value),
          onBlur: () => patchConfig({ days: textToDays(daysText) }),
        }),
      ])

      const actions = h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
        h('button', { key: 'warn', style: styles.ghostButton, disabled: busy, onClick: () => runAction('warn') }, '测试：发预告'),
        h('button', { key: 'stop', style: styles.ghostButton, disabled: busy, onClick: () => runAction('stop') }, '测试：立即停止'),
        h('button', { key: 'resume', style: styles.primaryButton, disabled: busy, onClick: () => runAction('resume') }, '测试：立即恢复'),
        h('button', { key: 'reload', style: styles.ghostButton, disabled: busy, onClick: reload }, '刷新状态'),
      ])

      const settingsGrid = h('div', { key: 'settings', style: styles.grid }, [
        h('div', { key: 'switches', style: styles.card }, switches),
        h('div', { key: 'timing', style: styles.card }, timing),
      ])

      const advanced = h('details', { key: 'advanced', style: styles.details }, [
        h('summary', { key: 'summary', style: styles.summary }, '高级设置 · 提示语与节假日覆盖'),
        h('div', { key: 'body', style: styles.detailsBody }, [prompts, holidays]),
      ])

      const lastAction = state && state.lastAction
        ? h('div', { key: 'last', style: styles.muted },
          '上次动作：' + String(state.lastAction.kind) + ' @ ' + clock(state.lastAction.at))
        : null

      return h('div', { style: styles.root }, [
        header,
        error ? h('div', { key: 'err', style: styles.error }, '出错了：' + error) : null,
        settingsGrid,
        sessionSection,
        actions,
        lastAction,
        advanced,
      ])
    }

    // ------------------------------------------------------------------ mount

    /**
     * Seat the section, tolerating a slot host that is not ready yet.
     * @param {object} ctx client root context
     * @param {Function} label nav label resolver
     * @returns {() => void} disposer
     */
    function installSection(ctx, label) {
      let dispose
      let mounted = false
      const mount = () => {
        if (mounted || !ctx.slots) return
        try {
          if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(SETTINGS_SECTION) === undefined) return
          dispose = ctx.slots.register({
            name: SETTINGS_SECTION,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label,
            locale: NS,
            inject: () => ({}),
          }, PeakGuardPanel)
          mounted = true
        } catch (cause) {
          const message = cause && typeof cause.message === 'string' ? cause.message : ''
          if (message.includes('already has an entry with id')) {
            mounted = true
            return
          }
          console.warn('[dsh-peak-guard] section mount failed', cause)
        }
      }
      mount()
      if (!mounted && typeof ctx.on === 'function') {
        try {
          ctx.on('slots/changed', () => {
            if (!mounted) mount()
          })
        } catch {
          // Without the change feed the first attempt is all we get.
        }
      }
      return () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            // Already disposed.
          }
        }
        mounted = false
      }
    }

    /** Required client services. */
    const inject = ['slots', 'locale']

    /**
     * Client plugin body: register the dictionary and seat the section.
     * @param {object} ctx client root context
     */
    function apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        try {
          ctx.locale.register(NS, dictionaries)
        } catch {
          // A locale host that refuses the dictionary still gets a literal label.
        }
      }

      const label = () => {
        try {
          if (ctx && ctx.locale && typeof ctx.locale.t === 'function') {
            const translate = ctx.locale.bind(NS)
            const text = translate('dsh-peak-guard.title')
            if (typeof text === 'string' && text !== '') return text
          }
        } catch {
          // Fall through to the literal label.
        }
        return '峰谷价自动停启'
      }

      const dispose = installSection(ctx, label)
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            dispose()
          } catch {
            // Section already gone.
          }
        }, 'dsh-peak-guard: settings section')
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
