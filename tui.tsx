/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import {
  availableProviders,
  authKeys,
  bar,
  createCachedStore,
  createConnectedProviders,
  createPollingFetcher,
  createViewPicker,
  fmt,
  fmtCost,
  GO_PROVIDER,
  isAssistant,
  modelId,
  parseUsage,
  providerId,
  providerLabel,
  providerTitle,
  resolveCurrentModel,
  sumProviderTokens,
  until,
  unwrap,
  ZEN_PROVIDER,
} from "opencode-plugin-kit"

// This plugin shows provider quota and usage for the OpenCode workspace
// (go/zen plan quota; Ollama Cloud balance and limits; usage + model breakdown
// for every authenticated provider via local message history).
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
// Ollama Cloud reports remaining plan credits and limits here. Unlike
// /api/usage (request history without limits), this endpoint is authoritative
// for the footer's quota rows.
const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance"
export const OLLAMA_PROVIDER = "ollama-cloud"
// Ollama's dashboard talks in "% remaining", but the footer's bars fill with
// consumption like every other view. Warn when almost nothing is left.
const LOW_LEFT_PERCENT = 10
const POLL_MS = 60_000
const STALE_AFTER_MS = 2 * POLL_MS
// A hung request would otherwise pin the polling fetcher's in-flight flag
// forever, silently freezing the footer on a stale value.
const FETCH_TIMEOUT_MS = 10_000
// TTL for the disk-backed key list and for the message scan.
const SCAN_TTL_MS = 30_000

interface Window {
  status?: string
  percent?: number
  resetsAt?: string
}

interface GoUsage {
  usage?: {
    rolling?: Window
    weekly?: Window
    monthly?: Window
  }
}

interface GoTotals {
  input: number
  output: number
  cost: number
}

/** One legacy Ollama Cloud window: how much of the limit is left, and when it
 *  resets. Percentages are the API's own 0..100 values, before conversion to
 *  the footer's "% used" convention. */
interface OllamaLimit {
  remainingPercent: number
  resetsAt?: string
}

/** Parsed `GET https://ollama.com/api/balance`. Plans report either legacy
 *  session/weekly percentages or included monthly credits in USD. */
interface OllamaBalance {
  mode: "limits" | "credits"
  session?: OllamaLimit
  weekly?: OllamaLimit
  balanceUsd?: number
  allowanceUsd?: number
  periodUntil?: string
  purchasedUsd?: number
}

// The usage endpoint accepts any workspace key. Try the Zen (opencode)
// provider key first, then fall back to the Go provider key, so the widget
// also works for users who only have a Zen key.
//
// The kit's authKeys() already reads BOTH credential stores OpenCode has ever
// used — the v2 SQLite `credential` table (trying bun:sqlite, then node:sqlite)
// and the legacy auth.json, with SQLite winning on conflict — and returns the
// keys in the order given here. So this is the single credential read; do not
// re-open the database here.
export function apiKeys(): string[] {
  const now = Date.now()
  if (_keysCache && now - _keysCache.at < SCAN_TTL_MS) return _keysCache.keys
  const keys = authKeys([ZEN_PROVIDER, GO_PROVIDER])
  _keysCache = { at: now, keys }
  return keys
}
let _keysCache: { at: number; keys: string[] } | null = null

// Sum tokens/cost across the session's assistant messages that used the
// given provider. Delegates to the kit's defensive message walker.
export function providerTotals(context: any, providerID: string, sessionID?: string): GoTotals {
  const t = sumProviderTokens(context, sessionID, providerID)
  return { input: t.input, output: t.output, cost: t.cost }
}

// Free Zen models: explicit -free suffixes plus the known always-free
// standbys. The server does not expose free-tier quota, so usage here is a
// local estimate from message history — useful for pace, not an authority.
export function isFreeModel(id: string): boolean {
  const m = String(id || "").toLowerCase()
  return m.endsWith("-free") || m === "big-pickle"
}

interface FreeWindows {
  h5: number
  week: number
  month: number
}

interface FreeModelUsage {
  totals: FreeWindows
  byModel: Record<string, FreeWindows>
  // Per-model cooldowns parsed from limit errors found in message history
  // ("Try again in N hours" / resetsAt), keyed by model id.
  cooldowns: Record<string, number> // model id -> epoch ms when the window frees up
}

// ---------------------------------------------------------------------------
// Incremental message scan
// ---------------------------------------------------------------------------
//
// Summing usage means reading every session's message history, so the naive
// shape — re-walk everything every 30s — is O(sessions x messages) forever, and
// it used to repeat once per rendered provider view. Instead each message is
// parsed at most once into a compact ScanEntry, and the 5h / week / month
// windows are derived from the stored timestamps at query time. Two wins:
//
//   * unchanged sessions are skipped entirely (fingerprint match), so a long
//     history costs nothing on the common path, and
//   * rolling windows stay correct without re-parsing, because window
//     membership is recomputed from `ts` on every call rather than baked in.
//
// The scan is shared by every provider view, so N views cost one walk, not N.

/** One parsed assistant message. Small by design: it holds aggregates, not the
 *  message itself, so memory tracks the month window rather than all history. */
interface ScanEntry {
  providerID: string
  model: string
  /** Epoch ms, always >= the current month's start — older messages cannot
   *  land in any window, so they are never stored. */
  ts: number
  tokens: number
  /** Model id -> cooldown epoch harvested from this message's error parts. */
  cooldowns?: Record<string, number>
}

interface SessionScan {
  /** Cheap change detector for the session's message list. Message lists are
   *  append-only, so the length plus the identity of the last entry suffices. */
  fingerprint: string
  entries: ScanEntry[]
}

// Per context, so two plugin instances never share a scan. Reassigned (not
// cleared) by __resetProviderUsageCache — a WeakMap has no clear().
let _scans = new WeakMap<object, Map<string, SessionScan>>()
let _scannedAt = new WeakMap<object, number>()

// Test-only: clear the message-scan and API-key caches between tests (both are
// time-cached and the tests freeze the clock).
export function __resetProviderUsageCache(): void {
  _scans = new WeakMap()
  _scannedAt = new WeakMap()
  _keysCache = null
  _ollamaKeyCache = null
  _ollamaRetryAt = 0
}

/** Epoch ms boundaries of the three tracked windows. The week starts Monday
 *  00:00 UTC, matching the server's weekly window. */
function windowStarts(now: number): { h5: number; week: number; month: number } {
  const weekStart = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()),
  )
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7)) // Monday
  return {
    h5: now - 5 * 3600_000,
    week: weekStart.getTime(),
    month: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1),
  }
}

/** Identity of a session's last message, used to skip re-parsing an unchanged
 *  session. Falls back to created + tokens when the shape carries no id. */
function fingerprintOf(list: readonly unknown[]): string {
  const last = list.length ? unwrap(list[list.length - 1] as any) : undefined
  if (!last) return "0"
  const created = last?.time?.created ?? last?.timeCreated ?? last?.createdAt ?? ""
  return `${list.length}:${last?.id ?? ""}:${created}:${last?.tokens ? JSON.stringify(last.tokens) : ""}`
}

/** Re-parse one session's messages into compact entries. Skipped entirely when
 *  the fingerprint is unchanged since the last scan. */
function scanSession(context: any, sid: string, into: Map<string, SessionScan>, monthStart: number): void {
  const list = context.data.session.message.list(sid) as readonly any[] | undefined
  if (!list) {
    into.delete(sid)
    return
  }
  const fingerprint = fingerprintOf(list)
  const prev = into.get(sid)
  if (prev && prev.fingerprint === fingerprint) return

  const entries: ScanEntry[] = []
  for (const raw of list) {
    const m = unwrap(raw)
    // Only assistant messages carry usage, and only they carry limit errors.
    if (!isAssistant(m)) continue
    const created = m?.time?.created ?? m?.timeCreated ?? m?.createdAt
    const ts = typeof created === "number" ? created : Date.parse(created ?? "")
    if (!Number.isFinite(ts)) continue
    // Beyond the month window nothing is tracked, so drop it at the door
    // rather than carrying dead history in memory.
    if (ts < monthStart) continue

    // Limit errors ride along as error parts. Match on `part.error` only:
    // scanning free text let ordinary prose ("if you hit a limit, retry in 3
    // hours") fake a cooldown badge onto a model.
    let cooldowns: Record<string, number> | undefined
    for (const part of (m?.parts ?? []) as any[]) {
      const err = part?.error
      if (!err) continue
      const untilMs = parseCooldown(String(err?.message ?? err))
      if (!untilMs) continue
      // A part may name the model it applies to, on the error or the part
      // itself (a bare string error has no fields); else the message's model.
      const pmodel = String(err?.modelID ?? part?.modelID ?? modelId(m))
      cooldowns ??= {}
      cooldowns[pmodel] = Math.max(cooldowns[pmodel] ?? 0, untilMs)
    }

    const tokens = m?.tokens ?? {}
    const read = tokens?.cache?.read
    const readTokens = Number(typeof read === "object" ? (read?.input ?? 0) : (read ?? 0)) || 0
    const total =
      (Number(tokens?.input ?? 0) || 0) +
      (Number(tokens?.output ?? 0) || 0) +
      (Number(tokens?.reasoning ?? 0) || 0) +
      readTokens
    // A limit error is worth keeping even when the message burned no tokens.
    if (total <= 0 && !cooldowns) continue
    entries.push({ providerID: providerId(m), model: modelId(m), ts, tokens: total, cooldowns })
  }
  into.set(sid, { fingerprint, entries })
}

/** Refresh (at most) this context's scan and return it. A single session that
 *  fails to read keeps its previous scan; the rest still update. */
function scanSessions(context: any): Map<string, SessionScan> {
  const now = Date.now()
  const scans = _scans.get(context) ?? new Map<string, SessionScan>()
  if (now - (_scannedAt.get(context) ?? 0) < SCAN_TTL_MS) return scans

  let listed: readonly any[] = []
  try {
    listed = context.data.session.list() ?? []
  } catch {
    // Keep the previous scan rather than blanking the footer.
    _scans.set(context, scans)
    _scannedAt.set(context, now)
    return scans
  }

  const { month } = windowStarts(now)
  const seen = new Set<string>()
  for (const s of listed) {
    const sid = String(s?.id ?? s?.info?.id ?? "")
    if (!sid) continue
    seen.add(sid)
    try {
      scanSession(context, sid, scans, month)
    } catch {
      // This session's history is unreadable — keep whatever we had for it.
    }
  }
  // Drop sessions that no longer exist so deleted history stops counting.
  for (const sid of scans.keys()) if (!seen.has(sid)) scans.delete(sid)

  _scans.set(context, scans)
  _scannedAt.set(context, now)
  return scans
}

// Sum tokens per model over the rolling 5h window, the current UTC week, and
// the current calendar month, scoped to one provider's assistant messages. The
// zen view tracks free-tier models; other providers track all of their models.
// Reads the shared incremental scan (above) and derives window membership per
// call, so this is cheap enough to run on every render. Local estimate only —
// the server keeps no per-provider quota API outside the go/zen endpoint.
export function providerUsage(context: any, providerID: string): FreeModelUsage {
  const totals: FreeWindows = { h5: 0, week: 0, month: 0 }
  const byModel: Record<string, FreeWindows> = {}
  const cooldowns: Record<string, number> = {}
  const { h5, week, month } = windowStarts(Date.now())
  for (const session of scanSessions(context).values()) {
    for (const e of session.entries) {
      if (e.providerID !== providerID) continue
      if (providerID === ZEN_PROVIDER && !isFreeModel(e.model)) continue
      if (e.cooldowns) {
        for (const [mid, untilMs] of Object.entries(e.cooldowns))
          cooldowns[mid] = Math.max(cooldowns[mid] ?? 0, untilMs)
      }
      if (e.tokens <= 0) continue
      const w = (byModel[e.model] ??= { h5: 0, week: 0, month: 0 })
      if (e.ts >= h5) {
        w.h5 += e.tokens
        totals.h5 += e.tokens
      }
      if (e.ts >= week) {
        w.week += e.tokens
        totals.week += e.tokens
      }
      if (e.ts >= month) {
        w.month += e.tokens
        totals.month += e.tokens
      }
    }
  }
  return { totals, byModel, cooldowns }
}

// Extract a retry/cooldown epoch from a limit-error payload. The Zen API is
// the only place per-model free limits surface; the TUI persists those
// errors as message parts, so history doubles as our cooldown ledger.
export function parseCooldown(text: string): number | null {
  if (!text) return null
  const now = Date.now()
  const absolute = text.match(/reset[^.\d]*(\d{4}-\d{2}-\d{2}[\dT .:+-]*Z)/i)
  if (absolute) {
    const ms = Date.parse(absolute[1])
    if (Number.isFinite(ms) && ms > now - 3600_000) return ms
  }
  const rel = text.match(/retry in (\d+)\s*(\w+)?s?/i)
  if (rel) {
    const mult: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }
    const unit = (rel[2] ?? "").toLowerCase().replace(/s$/, "")
    const factor = mult[unit]
    if (factor !== undefined) return now + Number(rel[1]) * factor
  }
  if (/limit (reached|exceeded)|usagelimiterror/i.test(text)) return now + 3600_000 // unknown window: assume ≥1h
  return null
}

// Plan quota from the same endpoint the console uses. The durable cache needs
// the plugin context, so the store is created inside setup().
export function createUsageStore(context: any) {
  return createCachedStore<GoUsage | null>(context, "usage", { initial: null, staleAfterMs: STALE_AFTER_MS })
}

// Fetch usage, trying each workspace key in order. Returns the parsed
// usage on success, null to keep the last-known-good cache on failure.
export async function fetchUsage(): Promise<GoUsage | null> {
  const keys = apiKeys()
  if (keys.length === 0) return null
  for (const key of keys) {
    try {
      // Without a timeout a hung request pins the polling fetcher's in-flight
      // flag forever, and the footer silently freezes on a stale value.
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) {
        // Parse, don't cast: an unrecognized shape degrades to the last
        // known-good cache instead of poisoning it.
        const parsed = parseUsage(await res.json())
        if (parsed) return parsed
      }
    } catch {
      // Try the next key; keep the last known usage on total failure.
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Ollama Cloud balance
// ---------------------------------------------------------------------------
//
// Plans come in two shapes: legacy plans report session (5h) and weekly (7d)
// percentages, while credit plans report an included monthly allowance plus
// any purchased credits. Both expose reset timestamps, so the footer can
// count down without guessing window boundaries.

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isoString(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function parseLimit(raw: any): OllamaLimit | undefined {
  const remaining = finiteNumber(raw?.remaining_percent)
  if (remaining === undefined) return undefined
  return { remainingPercent: clampPercent(remaining), resetsAt: isoString(raw?.resets_at) }
}

/** Parse the balance payload into the footer's normalized shape. Returns null
 *  for an unrecognized payload so callers keep the last known-good value. */
export function parseOllamaBalance(raw: unknown): OllamaBalance | null {
  const included = (raw as any)?.included
  if (!included || typeof included !== "object") return null

  const purchasedUsd = finiteNumber((raw as any)?.purchased?.balance_usd)

  // Legacy plans: session/weekly percentages. The API reports both together.
  const session = parseLimit(included.session)
  const weekly = parseLimit(included.weekly)
  if (session && weekly) return { mode: "limits", session, weekly, purchasedUsd }

  // Credit plans: included monthly allowance. The percentage only exists when
  // both sides of the ratio are present, so require them together.
  const balanceUsd = finiteNumber(included.balance_usd)
  const allowanceUsd = finiteNumber(included.allowance_usd)
  const periodUntil = isoString(included.period?.until)
  if (balanceUsd === undefined || allowanceUsd === undefined || allowanceUsd <= 0 || !periodUntil) return null
  return { mode: "credits", balanceUsd, allowanceUsd, periodUntil, purchasedUsd }
}

// The Ollama key lives in the same OpenCode credential stores as the Go/Zen
// keys. OLLAMA_API_KEY is the integration's declared env method and is a valid
// fallback when no key was saved with /connect.
let _ollamaKeyCache: { at: number; key: string } | null = null
let _ollamaRetryAt = 0

export function ollamaKey(): string {
  const now = Date.now()
  if (_ollamaKeyCache && now - _ollamaKeyCache.at < SCAN_TTL_MS) return _ollamaKeyCache.key
  const key = (authKeys([OLLAMA_PROVIDER])[0] ?? "").trim() || (process.env.OLLAMA_API_KEY ?? "").trim()
  _ollamaKeyCache = { at: now, key }
  return key
}

/** Fetch the balance, honoring the endpoint's 429 backoff. Returns null to
 *  keep the last-known-good cache on any failure. */
export async function fetchOllamaBalance(): Promise<OllamaBalance | null> {
  const key = ollamaKey()
  if (!key || Date.now() < _ollamaRetryAt) return null
  try {
    const res = await fetch(OLLAMA_BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 429) {
      const seconds = Number(res.headers?.get?.("retry-after"))
      _ollamaRetryAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : POLL_MS)
      return null
    }
    if (!res.ok) return null
    return parseOllamaBalance(await res.json())
  } catch {
    // Network error, timeout, or malformed JSON: keep the cached balance.
    return null
  }
}

function createOllamaBalanceStore(context: any) {
  return createCachedStore<OllamaBalance | null>(context, "ollama-balance", {
    initial: null,
    staleAfterMs: STALE_AFTER_MS,
  })
}

// ---------------------------------------------------------------------------
// Shared row vocabulary — the common UI every view renders through.
// ---------------------------------------------------------------------------

/** A window row: label + value, with an optional server-reported percent
 * (renders the bar) and reset countdown. */
interface WindowRow {
  kind: "window"
  label: string
  value: string
  percent?: number
  resetsAt?: string
  warn?: boolean
}

/** A provider usage line: `label usage <tokens> tok · $<cost>`. */
interface UsageRow {
  kind: "usage"
  label: string
  providerID: string
}

/** Free-form line (model breakdown, status notes). */
interface TextRow {
  kind: "text"
  text: string
}

type Row = WindowRow | UsageRow | TextRow

export function renderUsageRow(context: any, row: UsageRow, sessionID?: string): string {
  const t = providerTotals(context, row.providerID, sessionID)
  const active = t.input + t.output > 0 || t.cost > 0
  return active ? `${row.label} usage ${fmt(t.input + t.output)} tok · ${fmtCost(t.cost)}` : `${row.label} usage —`
}

export function renderWindowRow(row: WindowRow): string {
  const value = typeof row.percent === "number" ? `${bar(row.percent)} ${row.percent}%` : row.value
  const line = `${row.label} ${value}${row.warn ? " ⚠" : ""}`
  const eta = until(row.resetsAt)
  return eta ? `${line} · resets ${eta}` : line
}

export function renderRow(context: any, row: Row, sessionID?: string): string {
  switch (row.kind) {
    case "usage":
      return renderUsageRow(context, row, sessionID)
    case "window":
      return renderWindowRow(row)
    case "text":
      return row.text
  }
}

// Owns the sidebar footer via `replace` — the built-in aggregate USAGE block
// (cost/sessions/streak) is not shown; only the provider quota line is.
// Never touches sidebar content or session messages.
export default Plugin.define({
  id: "opencode-go.usage.tui",
  setup(context: any) {
    // Scoped to this instance on purpose: a module-level store would be
    // clobbered by the next setup(), so a reloaded plugin's fetcher would
    // write into the new instance's cache instead of its own.
    const usageCache = createUsageStore(context)

    // Polling fetcher: throttles, guards concurrent fetches, and keeps the
    // last-known-good value on failure. Replaces manual setInterval + flags.
    const polling = createPollingFetcher({
      fetch: fetchUsage,
      intervalMs: POLL_MS,
      throttleMs: POLL_MS,
      onResult: (usage) => usageCache.set(usage),
    })

    // Ollama Cloud keeps its own cache and poller: the endpoint, auth, and
    // failure modes are unrelated to the workspace usage endpoint, and a
    // user can have either key without the other.
    const balanceCache = createOllamaBalanceStore(context)
    const ollamaPolling = createPollingFetcher({
      fetch: fetchOllamaBalance,
      intervalMs: POLL_MS,
      throttleMs: POLL_MS,
      onResult: (balance) => balanceCache.set(balance),
    })

    const compact = context.options?.compact === true

    // Footer view selection. VIEWS is the single extension point: each entry
    // owns its rows() builder, so adding a provider means appending one entry
    // here — the picker, slash command, persistence, and footer renderer all
    // derive from the registry. The active view is persisted across restarts
    // and held in a signal so switching re-renders the footer.
    type ViewID = string
    interface ProviderView {
      readonly id: ViewID
      readonly title: string
      readonly description: string
      /** Provider whose key gates this view (like /connect's list). */
      readonly providerID: string
      readonly rows: (sessionID?: string) => Row[]
    }

    // A view is available only when its provider is connected — read from
    // the same source /connect uses: the integration list, where an entry
    // with a non-empty `connections` array means an added key/credential.
    // The kit's createConnectedProviders polls the integration list and
    // falls back to availableProviders() (auth.json + HF_TOKEN) when the
    // client is unavailable.
    const connected = createConnectedProviders(context, { pollMs: POLL_MS })
    // Ollama availability follows its own key (stored or env): the balance
    // endpoint works even before the integration poll reports /connect.
    const hasKey = (providerID: string): boolean =>
      providerID === OLLAMA_PROVIDER ? ollamaKey() !== "" : connected.has(providerID)
    const availableViews = () => VIEWS.filter((v) => hasKey(v.providerID))

    // Plan quota rows (shared workspace quota; aggregates all providers).
    // Server-reported percents → bars. Never fetched: distinguish pending
    // from fetch failure. Compact mode keeps only the tightest window.
    const planQuotaRows = (): Row[] => {
      const windows: Array<[string, Window | undefined]> = [
        ["5h", usageCache.value?.usage?.rolling],
        ["1w", usageCache.value?.usage?.weekly],
        ["1mo", usageCache.value?.usage?.monthly],
      ]
      const known = windows.filter(([, w]) => w && typeof w.percent === "number") as Array<[string, Window]>
      if (known.length === 0) {
        const failed =
          usageCache.lastSet > 0 && Date.now() - usageCache.lastSet >= STALE_AFTER_MS && !polling.inFlight()
        return [{ kind: "text", text: failed ? "quota ✗ (fetch failed)" : "quota —" }]
      }
      const tightestIdx = known.reduce(
        (best, [, w], i) => ((w.percent as number) > (known[best][1].percent as number) ? i : best),
        0,
      )
      const shown = compact ? [known[tightestIdx]] : known
      const rows: Row[] = shown.map(([label, w]) => ({
        kind: "window",
        label,
        value: "",
        percent: w.percent,
        resetsAt: w.resetsAt,
        warn: !!w.status && w.status !== "ok",
      }))
      if (usageCache.lastSet > 0 && usageCache.stale) rows.push({ kind: "text", text: "· stale" })
      return rows
    }

    // Ollama Cloud balance rows. Credit plans get a monthly bar plus the
    // remaining/purchased dollars; legacy plans get session/weekly bars. Bars
    // fill with consumption, and ⚠ flags a window with ≤10% left.
    const ollamaQuotaRows = (): Row[] => {
      const balance = balanceCache.value
      if (!balance) return [{ kind: "text", text: "ollama quota —" }]

      const windowRow = (label: string, remaining: number, resetsAt?: string): Row => ({
        kind: "window",
        // Padded so the bars of 5h / 1w / 1mo line up vertically.
        label: label.padEnd(3),
        value: "",
        percent: Math.round(clampPercent(100 - remaining)),
        resetsAt,
        warn: remaining <= LOW_LEFT_PERCENT,
      })

      const rows: Row[] = []
      if (balance.mode === "limits") {
        const windows = [
          ["5h", balance.session!],
          ["1w", balance.weekly!],
        ] as const
        // Compact mode keeps the window closest to running out.
        const shown = compact
          ? [windows.reduce((best, entry) => (entry[1].remainingPercent < best[1].remainingPercent ? entry : best))]
          : windows
        for (const [label, w] of shown) rows.push(windowRow(label, w.remainingPercent, w.resetsAt))
      } else {
        rows.push(windowRow("1mo", (balance.balanceUsd! / balance.allowanceUsd!) * 100, balance.periodUntil))
        const purchased = balance.purchasedUsd ?? 0
        const extra = purchased > 0 ? ` · +$${purchased.toFixed(2)}` : ""
        rows.push({
          kind: "text",
          text: `$${balance.balanceUsd!.toFixed(2)} / $${balance.allowanceUsd!.toFixed(2)}${extra}`,
        })
      }
      if (balanceCache.lastSet > 0 && balanceCache.stale) rows.push({ kind: "text", text: "· stale" })
      return rows
    }

    // One view per provider (plus go's plan-quota rows and zen's free-tier
    // breakdown). Built from the same discovery the picker and tool use, so a
    // new provider needs no code change. Go stays first — it was the original
    // default view, so persisted picks keep matching.
    const buildViewsFrom = (ids: readonly string[]): ProviderView[] => {
      const priority = new Map<string, number>([
        [GO_PROVIDER, 0],
        [ZEN_PROVIDER, 1],
        [OLLAMA_PROVIDER, 2],
      ])
      return [...ids]
        .sort((a, b) => (priority.get(a) ?? 99) - (priority.get(b) ?? 99))
        .map((pid): ProviderView => {
          const label = providerLabel(pid)
          // The view id is the provider id, NOT the display label: labels are
          // cosmetic and can be reworded, and persisted picks must survive that.
          if (pid === GO_PROVIDER) {
            return {
              id: pid,
              title: providerTitle(pid),
              description: "Go plan usage line and quota windows",
              providerID: pid,
              rows: (_sessionID) => [{ kind: "usage", label, providerID: pid }, ...planQuotaRows()],
            }
          }
          // Ollama Cloud reports its own limits/credits. OpenCode already shows
          // the local token/cost totals, so the view just labels the section.
          if (pid === OLLAMA_PROVIDER) {
            return {
              id: pid,
              title: "Ollama Cloud",
              description: "Ollama Cloud plan limits and remaining credits",
              providerID: pid,
              rows: () => [{ kind: "text", text: "Ollama usage:" }, ...ollamaQuotaRows()],
            }
          }
          // zen = free-tier breakdown; any other provider = its model usage.
          const zenLike = pid === ZEN_PROVIDER
          return {
            id: pid,
            title: providerTitle(pid),
            description: `${providerTitle(pid)} usage and model breakdown`,
            providerID: pid,
            rows: (_sessionID) => {
              const fw = providerUsage(context, pid)
              const wl = (s: string) => (zenLike ? `free ${s}` : s)
              const freeRows: Row[] = [
                { kind: "window", label: wl("5h"), value: `${fmt(fw.totals.h5)} tok` },
                { kind: "window", label: wl("1w"), value: `${fmt(fw.totals.week)} tok` },
                { kind: "window", label: wl("1mo"), value: `${fmt(fw.totals.month)} tok` },
              ]
              // Per-model breakdown: models active in the 5h window, with any
              // known cooldown countdown appended. Server limits are not
              // queryable, so the cooldown only appears after a limit error.
              const modelRows: Row[] = Object.entries(fw.byModel)
                .filter(([id, w]) => w.h5 > 0 || (fw.cooldowns[id] ?? 0) > Date.now())
                .sort((a, b) => b[1].h5 - a[1].h5)
                .map(([id, w]) => {
                  const cd = fw.cooldowns[id]
                  const cdTxt = cd && cd > Date.now() ? ` ⏳${until(new Date(cd).toISOString())}` : ""
                  return { kind: "text", text: `${id} ${fmt(w.h5)}${cdTxt}` } as Row
                })
              return [{ kind: "usage", label, providerID: pid }, ...freeRows, ...modelRows]
            },
          }
        })
    }

    // VIEWS is a live registry, not a setup-time snapshot. Its identity is
    // stable (the picker captures this array exactly once) but its contents
    // track the connected set, so running /connect mid-session surfaces a new
    // provider within one poll instead of needing a TUI restart.
    const VIEWS: ProviderView[] = []
    let viewsKey = ""
    const syncViews = () => {
      // Union of what /connect reports and what the auth store knows. The
      // connected set alone would drop known-but-disconnected providers, and
      // the picker needs those in the registry to explain how to add them.
      const ids = new Set([...availableProviders(), ...connected.ids()])
      // An env-only Ollama key is not in the auth store, but the integration
      // still treats it as configured, so surface its view too.
      if (process.env.OLLAMA_API_KEY && !ids.has(OLLAMA_PROVIDER)) ids.add(OLLAMA_PROVIDER)
      // Never empty: the picker needs a first entry and a registry-less footer
      // has nothing to paint. Mirrors the kit's own Zen+Go fallback.
      if (ids.size === 0) ids.add(GO_PROVIDER).add(ZEN_PROVIDER)
      const key = [...ids].sort().join(",")
      if (key === viewsKey) return
      viewsKey = key
      VIEWS.splice(0, VIEWS.length, ...buildViewsFrom([...ids]))
    }
    syncViews()

    // Provider the current session is actually using: the provider of the
    // most recent assistant message. Delegates to the kit's resolver.
    const sessionProvider = (sessionID?: string): string | null => {
      const m = resolveCurrentModel(context, sessionID)
      return m?.providerID ?? null
    }

    // Auto-pick precedence:
    // 1. The view matching the provider the session is actively using
    //    (only when its key is added) — the footer follows what you use.
    // 2. The user's persisted/manual pick via /usage-view, if still available.
    // 3. The first connected view.
    // Computed, never set during render, so reactivity stays clean.
    const effectiveView = (sessionID?: string): ViewID => {
      const available = availableViews()
      if (available.length === 0) return GO_PROVIDER
      const used = sessionProvider(sessionID)
      const usedView = used ? available.find((v) => v.providerID === used) : undefined
      const persisted = VIEWS.find((v) => v.id === picker.currentID())
      return (usedView ?? (available.includes(persisted!) ? persisted : undefined) ?? available[0]).id as ViewID
    }
    const currentView = (sessionID?: string) => VIEWS.find((v) => v.id === effectiveView(sessionID)) ?? VIEWS[0]

    // Picker (registry + persistence + /usage-view command + dialog + toast).
    // A view is selectable only when its provider key is added; a non-empty
    // argument selects that view directly (e.g. `/usage-view zen`).
    const picker = createViewPicker(context, {
      registry: VIEWS,
      storageKey: "view",
      command: {
        id: "usage.view",
        group: "Usage",
        name: "usage-view",
        aliases: ["usage"],
        title: () => `Usage footer: view provider (${currentView().title})`,
        description: "Pick which provider's usage the sidebar footer shows",
      },
      dialog: { title: "Usage view", message: "Choose the provider view shown in the sidebar footer" },
      toastPrefix: "Usage footer",
      selectable: (v) => availableViews().includes(v),
      unavailableMessage: (v) => `${v.title} has no API key added. Run /connect to add it first.`,
    })
    picker.registerCommand()

    const slot = context.ui.slot({
      replace: "sidebar.footer",
      render: ({ sessionID }: { sessionID?: string }) => {
        // No workspace key configured: render nothing instead of dead weight.
        // Ollama Cloud keeps its key in the same stores but is not a
        // workspace plan key, so check it separately.
        if (apiKeys().length === 0 && ollamaKey() === "") return null

        // Pick up providers connected since the last render. This is a plain
        // array mutation behind a change check — it writes no signal, so it
        // cannot re-enter the render loop it runs in.
        syncViews()

        // One shared renderer: the active view's registry entry supplies the
        // rows, the footer just paints them. VIEWS is never empty (see
        // syncViews), so currentView always resolves.
        const view = currentView(sessionID)
        return (
          <text>
            {view
              .rows(sessionID)
              .map((row) => renderRow(context, row, sessionID))
              .join("\n")}
          </text>
        )
      },
    })

    return () => {
      polling.stop()
      ollamaPolling.stop()
      connected.stop()
      slot?.()
    }
  },
})
