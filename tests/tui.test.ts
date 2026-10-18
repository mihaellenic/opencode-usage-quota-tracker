import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZEN_PROVIDER } from "opencode-plugin-kit"

const mockState = vi.hoisted(() => ({ authKeys: [] as string[] }))

vi.mock("opencode-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("opencode-plugin-kit")>()
  return {
    ...actual,
    authKeys: vi.fn(() => mockState.authKeys),
  }
})

const {
  apiKeys,
  providerTotals,
  isFreeModel,
  parseCooldown,
  providerUsage,
  fetchUsage,
  createUsageStore,
  parseOllamaBalance,
  ollamaKey,
  fetchOllamaBalance,
  renderUsageRow,
  renderWindowRow,
  renderRow,
  __resetProviderUsageCache,
} = await import("../tui.tsx")

// Fixed clock: Wednesday 2026-01-14 12:00 UTC.
const T0 = Date.UTC(2026, 0, 14, 12)
const IN_5H = T0 - 3600_000
const IN_WEEK = Date.UTC(2026, 0, 12, 6) // Monday 06:00 — in week+month, outside 5h
const IN_MONTH = Date.UTC(2026, 0, 3)
const OLD = Date.UTC(2025, 11, 20)

function fakeCtx(sessions: () => unknown, messages: (sid: string) => unknown) {
  return {
    data: {
      session: {
        list: sessions,
        message: { list: (sid: string) => messages(sid) },
      },
    },
  }
}

function msg(over: Record<string, unknown> = {}) {
  return {
    info: {
      type: "assistant",
      providerID: ZEN_PROVIDER,
      modelID: "claude-free",
      tokens: { input: 10, output: 5 },
      time: { created: IN_5H },
      ...over,
    },
  }
}

beforeEach(() => {
  __resetProviderUsageCache()
  vi.useFakeTimers({ now: T0 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("apiKeys", () => {
  it("delegates to kit authKeys", () => {
    mockState.authKeys = ["zen-key", "go-key"]
    expect(apiKeys()).toEqual(["zen-key", "go-key"])
  })
  it("returns empty when no keys", () => {
    mockState.authKeys = []
    expect(apiKeys()).toEqual([])
  })
})

describe("providerTotals", () => {
  it("sums tokens and cost for a provider", () => {
    const ctx = fakeCtx(
      () => [],
      () => [
        { info: { type: "assistant", providerID: "opencode", tokens: { input: 5, output: 2 }, cost: 0.5 } },
        { info: { type: "assistant", providerID: "opencode", tokens: { input: 1, output: 1 }, cost: 0.25 } },
        { info: { type: "assistant", providerID: "google", tokens: { input: 99 } } },
      ],
    )
    expect(providerTotals(ctx as any, "opencode", "s1")).toEqual({ input: 6, output: 3, cost: 0.75 })
  })
  it("returns zeros without a session", () => {
    const ctx = fakeCtx(
      () => [],
      () => [msg()],
    )
    expect(providerTotals(ctx as any, "opencode")).toEqual({ input: 0, output: 0, cost: 0 })
  })
})

describe("isFreeModel", () => {
  it("detects -free suffix and big-pickle, case-insensitively", () => {
    expect(isFreeModel("claude-FREE")).toBe(true)
    expect(isFreeModel("Big-Pickle")).toBe(true)
    expect(isFreeModel("gpt-5")).toBe(false)
    expect(isFreeModel("")).toBe(false)
  })
})

describe("parseCooldown", () => {
  it("returns null for empty text", () => {
    expect(parseCooldown("")).toBeNull()
  })
  it("parses a future absolute reset date", () => {
    expect(parseCooldown("rate limit exceeded, reset 2099-01-01T00:00:00Z")).toBe(Date.parse("2099-01-01T00:00:00Z"))
  })
  it("returns null for a stale absolute date (>1h past)", () => {
    expect(parseCooldown("reset 2020-01-01T00:00:00Z")).toBeNull()
  })
  it("falls through when the absolute date is unparseable", () => {
    expect(parseCooldown("reset 9999-99-99T99:99:99Z")).toBeNull()
  })
  it.each([
    ["retry in 5 minutes", 5 * 60_000],
    ["retry in 2 hours", 2 * 3_600_000],
    ["retry in 3 days", 3 * 86_400_000],
    ["retry in 1 week", 604_800_000],
  ] as const)("parses relative cooldown %s", (text, delta) => {
    expect(parseCooldown(text)).toBe(T0 + delta)
  })
  it("falls through to null for an unknown relative cooldown unit", () => {
    // "fortnights" isn't a known unit, so the relative match yields no
    // multiplier and the text falls through to the final null.
    expect(parseCooldown("retry in 3 fortnights")).toBeNull()
  })
  it("returns null when a relative cooldown has no unit word at all", () => {
    // "retry in 5" matches the relative regex but captures no unit group, so
    // rel[2] is undefined and the unknown-unit path falls through to null.
    expect(parseCooldown("retry in 5")).toBeNull()
  })
  it("assumes >=1h for limit-reached errors", () => {
    expect(parseCooldown("usage limit reached")).toBe(T0 + 3600_000)
    expect(parseCooldown("UsageLimitError: slow down")).toBe(T0 + 3600_000)
  })
  it("returns null when nothing matches", () => {
    expect(parseCooldown("all good here")).toBeNull()
  })
})

describe("providerUsage", () => {
  it("buckets messages into h5/week/month windows", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      (sid) =>
        sid === "a"
          ? [
              msg({ modelID: "m1-free", tokens: { input: 100 }, time: { created: IN_5H } }),
              msg({ modelID: "m2-free", tokens: { input: 40 }, time: { created: IN_WEEK } }),
              msg({ modelID: "m3-free", tokens: { input: 20 }, time: { created: IN_MONTH } }),
              msg({ modelID: "m4-free", tokens: { input: 999 }, time: { created: OLD } }),
            ]
          : [],
    )
    const u = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(u.totals).toEqual({ h5: 100, week: 140, month: 160 })
    expect(u.byModel["m1-free"]).toEqual({ h5: 100, week: 100, month: 100 })
    expect(u.byModel["m2-free"]).toEqual({ h5: 0, week: 40, month: 40 })
    expect(u.byModel["m3-free"]).toEqual({ h5: 0, week: 0, month: 20 })
    // Older than the month window: pruned at scan time, so it is absent
    // rather than present with zero buckets.
    expect(u.byModel["m4-free"]).toBeUndefined()
  })
  it("uses Monday as the week start", () => {
    vi.setSystemTime(Date.UTC(2026, 0, 18, 10)) // Sunday
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [msg({ tokens: { input: 7 }, time: { created: Date.UTC(2026, 0, 12, 6) } })],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.week).toBe(7)
  })
  it("counts cache reads (numeric and nested shapes) and reasoning", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        msg({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4 } } }),
        msg({ tokens: { input: 1, cache: { read: { input: 10 } } } }),
        msg({ tokens: { input: 1, cache: { read: {} } } }),
      ],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(22)
  })
  it("handles sessions with info-wrapped ids and skips id-less sessions", () => {
    const ctx = fakeCtx(
      () => [{ info: { id: "a" } }, {}],
      (sid) => (sid === "a" ? [msg()] : []),
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(15)
  })
  it("tolerates null session/message lists", () => {
    const ctx = fakeCtx(
      () => null,
      () => null,
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 0, week: 0, month: 0 })
  })
  it("tolerates a message list returning undefined and messages with sparse shapes", () => {
    const ctx = {
      data: {
        session: {
          list: () => [{ id: "a" }, { id: "b" }],
          message: {
            list: (sid: string) => {
              if (sid === "a") return undefined // ?? [] fallback
              return [
                {
                  info: {
                    type: "assistant",
                    providerID: ZEN_PROVIDER,
                    modelID: "claude-free",
                    time: { created: IN_5H },
                  },
                }, // no tokens
                msg({ tokens: { output: 5 } as any }), // no input field
                msg({ tokens: { input: 1, cache: { read: {} } } as any }), // cache.read object without input
              ]
            },
          },
        },
      },
    }
    // input-less message totals 5, input-only message totals 1; the token-less one is skipped
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 6, week: 6, month: 6 })
  })
  it("skips non-assistant and other-provider messages, zero tokens, bad timestamps", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        { info: { type: "user", providerID: ZEN_PROVIDER, tokens: { input: 5 }, time: { created: IN_5H } } },
        msg({ providerID: "google", tokens: { input: 5 } }),
        msg({ modelID: "claude-sonnet", tokens: { input: 5 } }), // zen non-free
        msg({ tokens: { input: 0, output: 0 } }),
        msg({ time: { created: "not-a-date" } }),
        msg({ time: {} }),
      ],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 0, week: 0, month: 0 })
  })
  it("tracks all models for non-zen providers (no free filter)", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [msg({ providerID: "google", modelID: "gemini-pro", tokens: { input: 11 } })],
    )
    const u = providerUsage(ctx as any, "google")
    expect(u.totals.h5).toBe(11)
    expect(u.byModel["gemini-pro"].h5).toBe(11)
  })
  it("harvests cooldowns from error parts, with message-model fallback", () => {
    const future = T0 + 7200_000
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        msg({
          modelID: "m-default-free",
          tokens: { input: 1 },
          parts: [
            { error: { message: "usage limit reached", modelID: "m-err" } },
            { error: "rate limit exceeded", modelID: "m-str" },
            { error: { message: `limit reached, reset at ${new Date(future).toISOString()}`, modelID: "m-abs" } },
            { error: { message: "nothing actionable here" } }, // error, but no cooldown
            { text: "no cooldown here" }, // not an error part → ignored
            { error: null }, // falsy error → ignored
            {}, // no error → ignored
          ],
        }),
        // In the week/month windows but not 5h, with no cooldown: exercises
        // the model-row filter's cooldown-missing path.
        msg({ modelID: "weekonly-free", tokens: { input: 2 }, time: { created: T0 - 86_400_000 } }),
      ],
    )
    const u = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(u.cooldowns["m-err"]).toBe(T0 + 3600_000)
    // Bare string error: the model id lives on the part, not the error.
    expect(u.cooldowns["m-str"]).toBe(T0 + 3600_000)
    expect(u.cooldowns["m-abs"]).toBe(future)
    expect(Object.keys(u.cooldowns)).toHaveLength(3)
  })
  it("ignores limit wording in ordinary prose (no phantom cooldown)", () => {
    // Regression: cooldowns must come from error payloads only. Matching free
    // text let a user (or an assistant explaining a limit) fake a ⏳ badge.
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        {
          info: {
            type: "user",
            providerID: ZEN_PROVIDER,
            modelID: "claude-free",
            time: { created: IN_5H },
            parts: [{ text: "the docs say: if you hit a limit, retry in 3 hours. limit exceeded is the error" }],
          },
        },
        {
          info: {
            type: "assistant",
            providerID: ZEN_PROVIDER,
            modelID: "claude-free",
            tokens: { input: 10 },
            time: { created: IN_5H },
            // An assistant narrating a limit it hit is still just prose.
            parts: [{ text: "I was rate limited, please retry in 2 hours" }],
          },
        },
      ],
    )
    const u = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(u.cooldowns).toEqual({})
    expect(u.totals.h5).toBe(10)
  })
  it("keeps the max cooldown for repeated errors on one model", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        msg({
          tokens: { input: 1 },
          parts: [
            { error: { message: "limit reached, retry in 1 hour", modelID: "m1" } },
            { error: { message: "limit exceeded, retry in 3 hours", modelID: "m1" } },
          ],
        }),
      ],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).cooldowns.m1).toBe(T0 + 3 * 3600_000)
  })
  it("harvests cooldowns even from messages that are not counted (zero tokens)", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [
        {
          info: {
            type: "assistant",
            providerID: ZEN_PROVIDER,
            modelID: "cooldown-model-free",
            tokens: { input: 0 },
            time: { created: IN_5H },
            parts: [{ error: { message: "limit reached, retry in 2 hours" } }],
          },
        },
      ],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).cooldowns["cooldown-model-free"]).toBe(T0 + 2 * 3600_000)
  })
  it("keeps partial accumulators when message.list throws mid-walk", () => {
    const ctx = {
      data: {
        session: {
          list: () => [{ id: "a" }, { id: "b" }],
          message: {
            list: (sid: string) => {
              if (sid === "b") throw new Error("boom")
              return [msg({ tokens: { input: 42 } })]
            },
          },
        },
      },
    }
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(42)
  })
  it("keeps zeros when session.list throws", () => {
    const ctx = fakeCtx(
      () => {
        throw new Error("boom")
      },
      () => [],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 0, week: 0, month: 0 })
  })
  it("serves a cached result within 30s and merges per-provider entries", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [msg({ tokens: { input: 10 } })],
    )
    const first = providerUsage(ctx as any, ZEN_PROVIDER)
    // Second call inside 30s is served from cache even though data changed.
    ;(ctx.data.session.message as any).list = () => [msg({ tokens: { input: 999 } })]
    expect(providerUsage(ctx as any, ZEN_PROVIDER)).toStrictEqual(first)

    const other = fakeCtx(
      () => [{ id: "a" }],
      () => [msg({ providerID: "google", modelID: "gemini", tokens: { input: 3 } })],
    )
    expect(providerUsage(other as any, "google").totals.h5).toBe(3)
    expect(providerUsage(ctx as any, ZEN_PROVIDER)).toStrictEqual(first) // merge kept the zen entry

    // After 31s the stale entry is recomputed against fresh data.
    ctx.data.session.list = () => [{ id: "a" }]
    ;(ctx.data.session.message as any).list = () => [msg({ tokens: { input: 50 } })]
    vi.advanceTimersByTime(31_000)
    const refreshed = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(refreshed).not.toBe(first)
    expect(refreshed.totals.h5).toBe(50)
  })

  it("reuses an unchanged session's scan and drops sessions that disappear", () => {
    // Two messages, so the tail entry can change independently of the head.
    const head = (n: number) => msg({ tokens: { input: n }, time: { created: IN_5H } })
    const tail = () => msg({ tokens: { input: 1 }, time: { created: IN_5H } })
    let messages: Record<string, unknown[]> = { a: [head(5), tail()], b: [] }
    const ctx = fakeCtx(
      () => [{ id: "a" }, { id: "b" }],
      (sid) => messages[sid] ?? [],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(6)

    // Editing a message that is NOT the tail leaves the fingerprint intact, so
    // the cached scan is reused and the edit is not picked up yet. This is the
    // documented trade-off: the tail stands in for "did anything change".
    messages = { a: [head(500), tail()], b: [] }
    vi.advanceTimersByTime(31_000)
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(6)

    // Touching the tail does invalidate the scan.
    messages = { a: [head(500), msg({ tokens: { input: 9 }, time: { created: IN_5H } })], b: [] }
    vi.advanceTimersByTime(31_000)
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(509)

    // Session "b" is gone; nothing of it may linger in the scan.
    messages = { a: [head(500), msg({ tokens: { input: 9 }, time: { created: IN_5H } })] }
    ;(ctx.data.session as any).list = () => [{ id: "a" }]
    vi.advanceTimersByTime(31_000)
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(509)
  })

  it("re-derives window membership as time crosses a week and month boundary", () => {
    // 2026-05-31 is a Sunday and the last day of the month, so 20s later both
    // the week and the month roll over. Entries scanned before the boundary
    // stay in the 5h window but fall out of the week and month windows.
    vi.setSystemTime(Date.UTC(2026, 4, 31, 23, 59, 40))
    const ctx = fakeCtx(
      () => [{ id: "a" }],
      () => [msg({ tokens: { input: 7 }, time: { created: Date.UTC(2026, 4, 31, 23, 59, 40) } })],
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 7, week: 7, month: 7 })

    vi.advanceTimersByTime(20_000) // now Mon 2026-06-01T00:00:00Z
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals).toEqual({ h5: 7, week: 0, month: 0 })
  })

  it("handles sessions with an empty list and messages with an id", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }, { id: "empty" }],
      (sid) =>
        sid === "empty"
          ? []
          : [
              {
                info: {
                  type: "assistant",
                  providerID: ZEN_PROVIDER,
                  modelID: "claude-free",
                  id: "m1",
                  tokens: { input: 4 },
                  time: { created: IN_5H },
                },
              },
              // No id and no tokens: exercises the fingerprint fallbacks.
              {
                info: { type: "assistant", providerID: ZEN_PROVIDER, modelID: "claude-free", time: { created: IN_5H } },
              },
            ],
    )
    const u = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(u.totals.h5).toBe(4)
    expect(u.byModel["claude-free"].h5).toBe(4)
  })

  it("accumulates token buckets across two sessions (multi-session aggregation)", () => {
    // Each session list returns a distinct id; providerTotals' walker runs
    // over every cached session independently, so totals must add across them
    // rather than reset/clobber as successive sessions are processed.
    const ctx = fakeCtx(
      () => [{ id: "a" }, { id: "b" }],
      (sid) =>
        sid === "a"
          ? [msg({ tokens: { input: 30 }, time: { created: IN_5H } })]
          : [msg({ tokens: { input: 70 }, time: { created: IN_5H } })],
    )
    const u = providerUsage(ctx as any, ZEN_PROVIDER)
    expect(u.totals.h5).toBe(100)
    expect(u.byModel["claude-free"].h5).toBe(100)
  })

  it("a stale session (second id missing) does not disturb the first session's bucket", () => {
    const ctx = fakeCtx(
      () => [{ id: "a" }, { id: "b" }, null as any],
      (sid) => (sid === "a" ? [msg({ tokens: { input: 12 }, time: { created: IN_5H } })] : []),
    )
    expect(providerUsage(ctx as any, ZEN_PROVIDER).totals.h5).toBe(12)
  })
})

describe("fetchUsage", () => {
  it("returns null without keys and never fetches", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    mockState.authKeys = []
    await expect(fetchUsage()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("falls back to the next key when one fails, sending bearer auth", async () => {
    mockState.authKeys = ["k1", "k2"]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ usage: { rolling: { percent: 10 } } }) })
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchUsage()).resolves.toEqual({ usage: { rolling: { percent: 10 } } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer k2")
  })
  it("keeps trying when a 200 returns an unrecognized shape", async () => {
    mockState.authKeys = ["k1"]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => "not an object" }))
    await expect(fetchUsage()).resolves.toBeNull()
  })
  it("returns null when every fetch throws", async () => {
    mockState.authKeys = ["k1"]
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    await expect(fetchUsage()).resolves.toBeNull()
  })
})

describe("createUsageStore", () => {
  it("wraps a cached store with 2-minute staleness", () => {
    const cells: Record<string, unknown> = {}
    const ctx = {
      storage: {
        store<T extends object>(key: string, opts: { initial: T }): [T, T] {
          const restored = (cells[key] ??= structuredClone(opts.initial)) as T
          return [restored, restored]
        },
      },
    }
    const store = createUsageStore(ctx as any)
    expect(store.value).toBeNull()
    expect(store.lastSet).toBe(0)
    expect(store.stale).toBe(true)
    store.set({ usage: { rolling: { percent: 10 } } })
    expect(store.value).toEqual({ usage: { rolling: { percent: 10 } } })
    expect(store.lastSet).toBe(T0)
    expect(store.stale).toBe(false)
    vi.advanceTimersByTime(121_000)
    expect(store.stale).toBe(true)
  })
})

describe("parseOllamaBalance", () => {
  const UNTIL = new Date(T0 + 600_000).toISOString()

  it("parses credit and legacy plans", () => {
    expect(
      parseOllamaBalance({
        included: { balance_usd: 55.08, allowance_usd: 60, period: { until: UNTIL } },
        purchased: { balance_usd: 4.27 },
      }),
    ).toEqual({ mode: "credits", balanceUsd: 55.08, allowanceUsd: 60, periodUntil: UNTIL, purchasedUsd: 4.27 })

    expect(
      parseOllamaBalance({
        included: {
          session: { remaining_percent: 75, resets_at: UNTIL },
          weekly: { remaining_percent: 40, resets_at: "not-a-date" },
        },
        purchased: { balance_usd: 0 },
      }),
    ).toEqual({
      mode: "limits",
      session: { remainingPercent: 75, resetsAt: UNTIL },
      weekly: { remainingPercent: 40, resetsAt: undefined },
      purchasedUsd: 0,
    })
  })

  it("clamps percentages and ignores a non-numeric purchased balance", () => {
    expect(
      parseOllamaBalance({
        included: {
          session: { remaining_percent: 150 },
          weekly: { remaining_percent: -5, resets_at: 123 },
        },
      }),
    ).toEqual({
      mode: "limits",
      session: { remainingPercent: 100, resetsAt: undefined },
      weekly: { remainingPercent: 0, resetsAt: undefined },
      purchasedUsd: undefined,
    })
    expect(
      parseOllamaBalance({
        included: { balance_usd: 5, allowance_usd: 10, period: { until: UNTIL } },
        purchased: { balance_usd: "2" },
      }),
    ).toMatchObject({ purchasedUsd: undefined })
  })

  it("rejects malformed payloads and incomplete plans", () => {
    expect(parseOllamaBalance(null)).toBeNull()
    expect(parseOllamaBalance({ included: "nope" })).toBeNull()
    expect(parseOllamaBalance({ included: {} })).toBeNull()
    expect(parseOllamaBalance({ included: { session: { remaining_percent: 50 } } })).toBeNull()
    expect(parseOllamaBalance({ included: { session: { remaining_percent: Number.POSITIVE_INFINITY } } })).toBeNull()
    expect(parseOllamaBalance({ included: { balance_usd: 5, allowance_usd: 10 } })).toBeNull()
    expect(parseOllamaBalance({ included: { balance_usd: 5, allowance_usd: 10, period: { until: "bad" } } })).toBeNull()
    expect(parseOllamaBalance({ included: { allowance_usd: 10, period: { until: UNTIL } } })).toBeNull()
    expect(parseOllamaBalance({ included: { balance_usd: 5, period: { until: UNTIL } } })).toBeNull()
    expect(parseOllamaBalance({ included: { balance_usd: 5, allowance_usd: 0, period: { until: UNTIL } } })).toBeNull()
  })
})

describe("ollamaKey", () => {
  it("resolves, trims, and caches the stored key with an env fallback", () => {
    mockState.authKeys = [" stored "]
    expect(ollamaKey()).toBe("stored")
    mockState.authKeys = []
    expect(ollamaKey()).toBe("stored") // cached
    __resetProviderUsageCache()
    vi.stubEnv("OLLAMA_API_KEY", " env ")
    expect(ollamaKey()).toBe("env")
    __resetProviderUsageCache()
    vi.unstubAllEnvs()
    expect(ollamaKey()).toBe("")
  })
})

describe("fetchOllamaBalance", () => {
  const CREDITS = {
    included: { balance_usd: 55.08, allowance_usd: 60, period: { until: new Date(T0 + 600_000).toISOString() } },
    purchased: { balance_usd: 4.27 },
  }

  it("returns null without a key and never fetches", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    mockState.authKeys = []
    await expect(fetchOllamaBalance()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches with bearer auth and parses the balance", async () => {
    mockState.authKeys = ["ollama-key"]
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => CREDITS })
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchOllamaBalance()).resolves.toEqual({
      mode: "credits",
      balanceUsd: 55.08,
      allowanceUsd: 60,
      periodUntil: CREDITS.included.period.until,
      purchasedUsd: 4.27,
    })
    expect(fetchMock.mock.calls[0][0]).toBe("https://ollama.com/api/balance")
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ollama-key")
  })

  it("honors Retry-After and falls back to the poll interval", async () => {
    mockState.authKeys = ["ollama-key"]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => "2" }, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchOllamaBalance()).resolves.toBeNull() // Retry-After: 2s
    await expect(fetchOllamaBalance()).resolves.toBeNull() // skipped
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_001)
    await expect(fetchOllamaBalance()).resolves.toBeNull() // no header → 60s
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(fetchOllamaBalance()).resolves.toBeNull() // skipped
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns null on error responses and network failures", async () => {
    mockState.authKeys = ["ollama-key"]
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    await expect(fetchOllamaBalance()).resolves.toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    await expect(fetchOllamaBalance()).resolves.toBeNull()
  })
})

describe("render helpers", () => {
  it("renderUsageRow shows usage when active, — otherwise (tokens or cost)", () => {
    const ctx = fakeCtx(
      () => [],
      (sid) =>
        sid === "rich"
          ? [{ info: { type: "assistant", providerID: "opencode", tokens: { input: 1500, output: 1 }, cost: 0.25 } }]
          : sid === "costly"
            ? [{ info: { type: "assistant", providerID: "opencode", tokens: {}, cost: 1.5 } }]
            : [],
    )
    const row = { kind: "usage", label: "zen", providerID: ZEN_PROVIDER } as const
    expect(renderUsageRow(ctx as any, row, "rich")).toBe("zen usage 1,501 tok · $0.2500")
    expect(renderUsageRow(ctx as any, row, "costly")).toBe("zen usage 0 tok · $1.5000")
    expect(renderUsageRow(ctx as any, row, "empty")).toBe("zen usage —")
  })
  it("renderWindowRow renders bars, values, warn and reset suffixes", () => {
    expect(renderWindowRow({ kind: "window", label: "5h", value: "", percent: 50 })).toContain("50%")
    expect(renderWindowRow({ kind: "window", label: "5h", value: "12 tok" })).toContain("12 tok")
    expect(renderWindowRow({ kind: "window", label: "5h", value: "12 tok", warn: true })).toContain("⚠")
    expect(renderWindowRow({ kind: "window", label: "5h", value: "12 tok", warn: false })).not.toContain("⚠")
    expect(
      renderWindowRow({ kind: "window", label: "5h", value: "12 tok", resetsAt: new Date(T0 + 600_000).toISOString() }),
    ).toContain("· resets 10m")
    expect(renderWindowRow({ kind: "window", label: "5h", value: "12 tok" })).not.toContain("resets")
  })
  it("renderRow dispatches on kind", () => {
    const ctx = fakeCtx(
      () => [],
      () => [],
    )
    expect(renderRow(ctx as any, { kind: "text", text: "hello" })).toBe("hello")
    expect(renderRow(ctx as any, { kind: "window", label: "1w", value: "3 tok" })).toBe("1w 3 tok")
    expect(renderRow(ctx as any, { kind: "usage", label: "go", providerID: "opencode-go" }, undefined)).toBe(
      "go usage —",
    )
  })
})
