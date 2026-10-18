import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bar, until, ZEN_PROVIDER } from "opencode-plugin-kit"

const mockState = vi.hoisted(() => ({
  keys: [] as string[],
  providers: ["opencode-go"] as string[],
}))

vi.mock("opencode-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("opencode-plugin-kit")>()
  return {
    ...actual,
    authKeys: vi.fn(() => mockState.keys),
    availableProviders: vi.fn(() => [...mockState.providers]),
    hasKey: vi.fn((id: string) => mockState.providers.includes(id)),
  }
})

const tui = (await import("../tui.tsx")).default as { setup: (ctx: any) => () => void }
const { __resetProviderUsageCache, OLLAMA_PROVIDER } = await import("../tui.tsx")

const T0 = Date.UTC(2026, 0, 14, 12)
const FUTURE = new Date(Date.now() + 600_000).toISOString()

interface Cfg {
  options?: Record<string, unknown>
  cells?: Record<string, unknown>
  integrations?: Array<Record<string, unknown>>
  sessions?: () => unknown
  messages?: (sid: string) => unknown
  slotReturn?: unknown
}

function makeCtx(cfg: Cfg = {}) {
  const slots: Array<Record<string, any>> = []
  const layerCalls: any[] = []
  const toastCalls: any[] = []
  const alertCalls: any[] = []
  const integrationList = vi.fn(async () => ({ data: cfg.integrations ?? [] }))
  const slotDisposer = vi.fn()
  const ctx: any = {
    options: cfg.options,
    storage: {
      store<T extends object>(key: string, opts: { initial: T }): [T, T] {
        const cells = (cfg.cells ?? {}) as Record<string, unknown>
        const restored = (cells[key] ??= structuredClone(opts.initial)) as T
        return [restored, restored]
      },
    },
    ui: {
      slot: vi.fn((options: Record<string, unknown>) => {
        slots.push(options)
        return cfg.slotReturn === "undefined" ? undefined : slotDisposer
      }),
      toast: { show: vi.fn((input: unknown) => toastCalls.push(input)) },
      dialog: {
        alert: vi.fn(async (input: unknown) => {
          alertCalls.push(input)
        }),
        select: vi.fn(async () => ""),
      },
    },
    keymap: {
      layer: vi.fn((register: () => unknown) => {
        layerCalls.push(register())
      }),
    },
    data: {
      session: {
        list: cfg.sessions ?? (() => []),
        message: { list: cfg.messages ?? (() => []) },
      },
    },
    client: { integration: { list: integrationList } },
  }
  return { ctx, slots, layerCalls, toastCalls, alertCalls, integrationList, slotDisposer }
}

const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(1) : new Promise<void>((r) => setTimeout(r, 0)))

interface Running {
  cleanup: () => void
  slots: Array<Record<string, any>>
  layerCalls: any[]
  toastCalls: any[]
  alertCalls: any[]
  slotDisposer: ReturnType<typeof vi.fn>
}

async function startPlugin(cfg: Cfg = {}): Promise<Running> {
  const parts = makeCtx(cfg)
  const cleanup = tui.setup(parts.ctx)
  await flush()
  await flush()
  return { cleanup, ...parts }
}

/** Invoke the sidebar.footer slot renderer and return the rendered text. */
function footerText(run: Running, sessionID?: string): string {
  const footer = run.slots[1]
  expect(footer?.replace).toBe("sidebar.footer")
  const res = footer.render({ sessionID })
  if (res === null) return ""
  return String((res as HTMLElement).textContent)
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete process.env.HF_TOKEN
})
beforeEach(() => {
  __resetProviderUsageCache()
  mockState.keys = ["k1"]
  mockState.providers = ["opencode-go"]
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  )
})

describe("setup: lifecycle", () => {
  it("cleanup stops polling, disconnects providers and disposes the slot", async () => {
    const run = await startPlugin({ integrations: [{ id: "opencode-go", connections: [{}] }] })
    expect(run.slots).toHaveLength(2)
    run.cleanup()
    expect(run.slotDisposer).toHaveBeenCalledTimes(1)
  })
  it("tolerates a slot registration that returns no disposer", async () => {
    const run = await startPlugin({ slotReturn: "undefined" })
    expect(() => run.cleanup()).not.toThrow()
  })
  it("renders nothing when no workspace keys are configured", async () => {
    mockState.keys = []
    const run = await startPlugin()
    expect(footerText(run)).toBe("")
  })
})

describe("setup: go view (plan quota rows)", () => {
  const OK_USAGE = {
    usage: {
      rolling: { percent: 50 },
      weekly: { percent: 80, status: "throttled", resetsAt: FUTURE },
      monthly: { percent: 30 },
    },
  }

  it("renders the usage line plus all quota windows with bars", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => OK_USAGE })),
    )
    const run = await startPlugin({ integrations: [{ id: "opencode-go", connections: [{}] }] })
    await flush()
    const text = footerText(run)
    const expected = [
      "go usage —",
      `5h ${bar(50)} 50%`,
      `1w ${bar(80)} 80% ⚠ · resets ${until(FUTURE)}`,
      `1mo ${bar(30)} 30%`,
    ].join("\n")
    expect(text).toBe(expected)
  })

  it("compact mode keeps only the tightest window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => OK_USAGE })),
    )
    const run = await startPlugin({ options: { compact: true } })
    await flush()
    expect(footerText(run)).toBe(["go usage —", `1w ${bar(80)} 80% ⚠ · resets ${until(FUTURE)}`].join("\n"))
  })

  it("shows a pending placeholder while nothing was fetched", async () => {
    const run = await startPlugin()
    expect(footerText(run)).toBe(["go usage —", "quota —"].join("\n"))
  })

  it("shows a pending placeholder when the fetch succeeded but reported no percents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ usage: { rolling: {} } }) })),
    )
    const run = await startPlugin()
    await flush()
    expect(footerText(run)).toBe(["go usage —", "quota —"].join("\n"))
  })

  it("marks stale fetch failures as ✗ and appends a stale note", async () => {
    vi.useFakeTimers({ now: T0 })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ usage: {} }) })),
    )
    const run = await startPlugin()
    await vi.advanceTimersByTimeAsync(1)
    expect(footerText(run)).toContain("quota —")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    )
    await vi.advanceTimersByTimeAsync(121_000)
    const text = footerText(run)
    expect(text).toContain("quota ✗ (fetch failed)")
    run.cleanup()
  })

  it("appends a stale note when window data is old and refetches failed", async () => {
    vi.useFakeTimers({ now: T0 })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ usage: { rolling: { percent: 5 } } }) })),
    )
    const run = await startPlugin()
    await vi.advanceTimersByTimeAsync(1)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    )
    await vi.advanceTimersByTimeAsync(121_000)
    const text = footerText(run)
    expect(text).toContain("5h")
    expect(text).toContain("· stale")
    run.cleanup()
  })
})

describe("setup: ollama cloud view (balance rows)", () => {
  const CREDITS = {
    included: { balance_usd: 3.61, allowance_usd: 60, period: { until: FUTURE } },
    purchased: { balance_usd: 4.27 },
  }
  const CREDIT_ONLY = { included: { balance_usd: 30, allowance_usd: 60, period: { until: FUTURE } } }
  const LIMITS = {
    included: { session: { remaining_percent: 75, resets_at: FUTURE }, weekly: { remaining_percent: 40 } },
  }

  // Both pollers share the process, so answer the Ollama endpoint and fail the
  // workspace endpoint. That keeps the Go fetch from poisoning the assertion.
  function ollamaFetch(body: unknown) {
    return vi.fn(async (url: unknown) => {
      if (String(url).includes("ollama.com")) return { ok: true, status: 200, json: async () => body }
      return { ok: false, status: 500, json: async () => ({}) }
    })
  }

  it("renders credits with a low-balance warning and merged dollars", async () => {
    mockState.keys = ["ollama-key"]
    mockState.providers = [OLLAMA_PROVIDER]
    vi.stubGlobal("fetch", ollamaFetch(CREDITS))
    const run = await startPlugin({ integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }] })
    await flush()
    expect(footerText(run)).toBe(
      ["Ollama usage:", `1mo ${bar(94)} 94% ⚠ · resets ${until(FUTURE)}`, "$3.61 / $60.00 · +$4.27"].join("\n"),
    )
  })

  it("shows a pending placeholder until the first balance arrives", async () => {
    mockState.keys = ["ollama-key"]
    mockState.providers = [OLLAMA_PROVIDER]
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    )
    const run = await startPlugin({ integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }] })
    await flush()
    expect(footerText(run)).toBe("Ollama usage:\nollama quota —")
  })

  it("renders legacy limits", async () => {
    mockState.keys = ["ollama-key"]
    mockState.providers = [OLLAMA_PROVIDER]
    vi.stubGlobal("fetch", ollamaFetch(LIMITS))
    const run = await startPlugin({ integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }] })
    await flush()
    expect(footerText(run)).toBe(
      ["Ollama usage:", `5h  ${bar(25)} 25% · resets ${until(FUTURE)}`, `1w  ${bar(60)} 60%`].join("\n"),
    )
  })

  it("compact mode keeps the tighter window", async () => {
    mockState.keys = ["ollama-key"]
    mockState.providers = [OLLAMA_PROVIDER]
    vi.stubGlobal("fetch", ollamaFetch(LIMITS))
    const weekly = await startPlugin({
      options: { compact: true },
      integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }],
    })
    await flush()
    expect(footerText(weekly)).toBe(`Ollama usage:\n1w  ${bar(60)} 60%`)

    vi.stubGlobal(
      "fetch",
      ollamaFetch({ included: { session: { remaining_percent: 20 }, weekly: { remaining_percent: 80 } } }),
    )
    const session = await startPlugin({
      options: { compact: true },
      integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }],
    })
    await flush()
    expect(footerText(session)).toBe(`Ollama usage:\n5h  ${bar(80)} 80%`)
  })

  it("keeps the last credits and marks them stale after failed refreshes", async () => {
    vi.useFakeTimers({ now: T0 })
    mockState.keys = ["ollama-key"]
    mockState.providers = [OLLAMA_PROVIDER]
    vi.stubGlobal("fetch", ollamaFetch(CREDIT_ONLY))
    const run = await startPlugin({ integrations: [{ id: OLLAMA_PROVIDER, connections: [{}] }] })
    await vi.advanceTimersByTimeAsync(1)
    expect(footerText(run)).toContain("$30.00 / $60.00")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    )
    await vi.advanceTimersByTimeAsync(121_000)
    const text = footerText(run)
    expect(text).toContain("$30.00 / $60.00")
    expect(text).toContain("· stale")
    run.cleanup()
  })

  it("renders the Ollama view with an env-only key", async () => {
    mockState.keys = []
    mockState.providers = []
    vi.stubEnv("OLLAMA_API_KEY", "env-key")
    vi.stubGlobal("fetch", ollamaFetch(CREDIT_ONLY))
    const run = await startPlugin({ integrations: [] })
    await flush()
    expect(footerText(run)).toBe(
      ["Ollama usage:", `1mo ${bar(50)} 50% · resets ${until(FUTURE)}`, "$30.00 / $60.00"].join("\n"),
    )
  })
})

describe("setup: view auto-pick precedence", () => {
  function freeMsg(tokens = 10) {
    return {
      info: {
        type: "assistant",
        providerID: "opencode",
        modelID: "claude-free",
        tokens: { input: tokens },
        cost: 0.5,
        time: { created: Date.now() - 1000 },
      },
    }
  }

  it("follows the provider the session is using", async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({
      integrations: [
        { id: "opencode-go", connections: [{}] },
        { id: "opencode", connections: [{}] },
      ],
      sessions: () => [{ id: "s1" }],
      messages: (sid) =>
        sid === "s1" ? [freeMsg(), { ...freeMsg(4), info: { ...freeMsg(4).info, modelID: "gemma-free" } }] : [],
    })
    const text = footerText(run, "s1")
    expect(text).toContain("zen usage 14 tok · $1.0000")
    expect(text).toContain("free 5h 14 tok")
    expect(text).toContain("claude-free 10")
    expect(text).toContain("gemma-free 4")
  })

  it("appends a cooldown countdown for a model with an active limit error", async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({
      integrations: [{ id: "opencode", connections: [{}] }],
      sessions: () => [{ id: "s1" }],
      messages: (sid) =>
        sid === "s1"
          ? [
              freeMsg(0),
              {
                info: {
                  type: "assistant",
                  providerID: "opencode",
                  modelID: "week-model-free",
                  tokens: { input: 3 },
                  time: { created: Date.now() - 86_400_000 }, // in week/month, outside 5h
                  parts: [{ error: { message: "usage limit reached, retry in 1 hour" } }],
                },
              },
              {
                info: {
                  type: "assistant",
                  providerID: "opencode",
                  modelID: "weekonly-free",
                  tokens: { input: 2 },
                  time: { created: Date.now() - 86_400_000 }, // counted, but no cooldown and outside 5h
                },
              },
            ]
          : [],
    })
    const text = footerText(run, "s1")
    expect(text).toContain("week-model-free 0 ⏳1h 0m")
    expect(text).not.toContain("claude-free") // zero tokens and no cooldown → filtered out
  })

  it("restores the persisted pick when it is available", async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({
      // Persisted picks are keyed by provider id, not by display label.
      cells: { view: { id: ZEN_PROVIDER } },
      integrations: [
        { id: "opencode-go", connections: [{}] },
        { id: "opencode", connections: [{}] },
      ],
    })
    expect(footerText(run)).toContain("free 5h 0 tok")
  })

  it("falls back to the first available view when the persisted pick is unavailable", async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({
      // A stale pick: this provider is no longer in the registry at all.
      cells: { view: { id: "retired-provider" } },
      integrations: [{ id: "opencode", connections: [{}] }],
    })
    expect(footerText(run)).toContain("free 5h 0 tok")
  })

  it('falls back to the "go" view when no view is available', async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({ integrations: [] })
    expect(footerText(run)).toContain("go usage —")
  })

  it("falls back to the first registered view when no view is connected", async () => {
    // Only provider is Google and it is not connected: the registry still has
    // an entry, so rendering falls back to it rather than going blank.
    mockState.providers = ["google"]
    const run = await startPlugin({ integrations: [] })
    expect(footerText(run)).toContain("google usage")
  })

  it("keeps a usable registry when no provider is discoverable at all", async () => {
    mockState.providers = []
    const run = await startPlugin({ integrations: [] })
    expect(footerText(run)).toBe("go usage —\nquota —")
  })

  it("surfaces a provider connected after startup without a restart", async () => {
    vi.useFakeTimers()
    mockState.providers = ["opencode-go", "google"]
    const run = await startPlugin({ integrations: [{ id: "opencode-go", connections: [{}] }] })
    await vi.advanceTimersByTimeAsync(1)
    expect(footerText(run)).toContain("go usage")

    // /connect now reports Google as connected too.
    run.integrationList.mockResolvedValue({
      data: [
        { id: "opencode-go", connections: [{}] },
        { id: "google", connections: [{}] },
      ],
    })
    await vi.advanceTimersByTimeAsync(61_000) // one connected-provider poll

    // The picker offers Google even though it was absent at startup.
    run.slots[0].render()
    run.layerCalls[0].commands[0].run()
    await vi.advanceTimersByTimeAsync(1)
    const titles = run.ctx.ui.dialog.select.mock.calls.at(-1)[0].options.map((o: any) => o.title)
    expect(titles).toContain("Google")
    run.cleanup()
  })

  it("renders other providers without the free prefix", async () => {
    mockState.providers = ["google"]
    const run = await startPlugin({ integrations: [{ id: "google", connections: [{}] }] })
    const text = footerText(run)
    expect(text).toBe(["google usage —", "5h 0 tok", "1w 0 tok", "1mo 0 tok"].join("\n"))
  })

  it("sorts unprioritized providers after go and zen", async () => {
    // Both comparator call orders are exercised: [google, zen] swaps, [zen, google] keeps.
    for (const providers of [
      ["google", "opencode"],
      ["opencode", "google"],
    ]) {
      mockState.providers = providers
      const run = await startPlugin({ integrations: [{ id: "opencode", connections: [{}] }] })
      expect(footerText(run)).toContain("zen usage")
      run.cleanup()
    }
  })

  it("includes env-only providers like HuggingFace", async () => {
    process.env.HF_TOKEN = "hf-test"
    mockState.providers = ["huggingface"]
    const run = await startPlugin()
    expect(footerText(run)).toBe(["hf usage —", "5h 0 tok", "1w 0 tok", "1mo 0 tok"].join("\n"))
  })
})

describe("setup: picker gating", () => {
  it("alerts with the unavailable message for a view without a key, and applies an available one", async () => {
    mockState.providers = ["opencode-go", "opencode"]
    const run = await startPlugin({
      // Persisted pick ≠ Go so apply() actually switches.
      cells: { view: { id: ZEN_PROVIDER } },
      integrations: [{ id: "opencode-go", connections: [{}] }],
    })
    // registerCommand registered an "app" slot whose render registers the keymap layer.
    const appSlot = run.slots[0]
    expect(appSlot.append).toBe("app")
    appSlot.render()
    const command = run.layerCalls[0].commands[0]
    expect(command.id).toBe("usage.view")
    expect(command.title).toContain("Usage footer: view provider")

    command.run("zen")
    await flush()
    expect(run.alertCalls[0].message).toContain("Zen has no API key added. Run /connect to add it first.")

    command.run("go")
    await flush()
    expect(run.toastCalls[0].message).toBe("Usage footer: Go view")
  })
})
