/** @jsxImportSource @opentui/solid */
/**
 * (c) Bohdan Futerko, 2026, https://www.bf.com.ua, https://github.com/LeBohdan
 */
import { onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { TextRenderable } from "@opentui/core"

const HEALTH_CHECK_INTERVAL = 30_000
const DISPLAY_REFRESH_MS = 3_000
const LAST_FINISHED_TTL_MS = 30_000
const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const METRICS_BACKFILL_DELAY_MS = 300
const UPSTREAM_STATE_STALE_MS = 5_000

type StreamSample = {
  at: number
  tokens: number
}

type UpstreamStateData = {
  upstream?: string
  engine?: string
  state?: "idle" | "reading" | "generating" | "queued" | "unloaded"
  phase?: string | null
  queued?: number
  model?: string
  gpu?: {
    util?: number
    mem_used?: number
    mem_total?: number
    temp?: number
    power?: number
  }
  ram?: { used?: number; total?: number }
  cpu?: number
  updated_at?: string
}

type MetricEvent = {
  type: string
  upstream?: string
  slot?: number
  task?: number
  phase?: "prefill" | "generation" | "finished"
  prompt_tokens?: number
  prompt_tps?: number
  prompt_eval_ms?: number
  progress?: number
  generated_tokens?: number
  generation_tps?: number
  generation_tps_3s?: number
  truncated?: number
  graphs_reused?: number
  n_tokens?: number
  total_ms?: number
  total_tokens?: number
  keep?: number
  sim?: number
  upstream_state?: UpstreamStateData
  timestamp?: string
}

type TaskSnapshot = {
  slot: number
  task: number
  upstream?: string
  phase: "prefill" | "generation" | "finished"
  promptTokens: number
  generatedTokens: number
  promptTPS: number
  generationTPS: number
  generationTPS3s: number
  progress: number
  finished: boolean
  cancelled: boolean
  updatedAt: number
  totalMs: number
  totalTokens: number
  keep?: number
  sim?: number
}

type RawTaskState = {
  slot: number
  task: number
  upstream?: string
  phase?: "prefill" | "generation" | "finished"
  prompt_tokens?: number
  generated_tokens?: number
  prompt_tps?: number
  generation_tps?: number
  generation_tps_3s?: number
  progress?: number
  updated_at?: string
  finished?: boolean
  cancelled?: boolean
  total_ms?: number
  total_tokens?: number
  keep?: number
}

type SnapshotData = {
  active?: boolean
  current_task?: RawTaskState
  tasks?: RawTaskState[]
  upstreams?: UpstreamStateData[]
}

type PluginState = {
  state: "inactive" | "active" | "disc" | "disconnected"
  currentTask: TaskSnapshot | null
  lastFinished: TaskSnapshot | null
  lastFinishedAt: number | null
  startAt: number
  durationMs: number | null
  upstream: UpstreamStateData | null
  upstreamAt: number
  streamSamples: Record<string, StreamSample[]>
  streamCumulative: Record<string, number>
  version: number
}

type LogFn = (msg: string) => void

function createLog(debug: boolean): LogFn | undefined {
  if (!debug) return undefined
  const opencodeDir = process.env.OPENCODE_DIR?.replace(/^~/, process.env.HOME || "") || join(process.env.HOME || "~", ".opencode")
  const logDir = join(opencodeDir, "logs")
  const fn = (msg: string) => {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [INFO] ${msg}\n`
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, "oc-pulse.log"), line)
    } catch {
      console.error(`[oc-pulse] failed to write log: ${msg}`)
    }
    console.error(`[oc-pulse] ${msg}`)
  }
  return fn
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-"
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatTokens(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString("en-US")
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function estimateStreamTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function activeDurationMs(samples: StreamSample[], tailAt?: number): number {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }
  let duration = 0
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i].at - samples[i - 1].at)
  }
  if (tailAt) {
    duration += Math.max(0, tailAt - samples[samples.length - 1].at)
  }
  return Math.max(duration, SINGLE_SAMPLE_MS)
}

function calcLiveTps(samples: StreamSample[]): string | null {
  const now = Date.now()
  const relevant = samples.filter((s) => now - s.at <= STREAM_WINDOW_MS)
  if (relevant.length === 0) return null
  const last = relevant[relevant.length - 1]
  if (!last || now - last.at > LIVE_STALE_MS) return null
  const total = relevant.reduce((sum, s) => sum + s.tokens, 0)
  const durSec = activeDurationMs(relevant, now) / 1000
  if (durSec <= 0) return null
  return formatRate(total / durSec)
}

function formatReuseDisplay(keep?: number, sim?: number): string {
  const parts: string[] = []
  if (sim != null) parts.push(`Match ${(sim * 100).toFixed(0)}%`)
  if (keep != null) parts.push(`Reuse ${(keep * 100).toFixed(0)}%`)
  return parts.join(" | ")
}

function semanticPhase(phase: string | null | undefined): string | null {
  if (!phase) return null
  if (phase === "thinking") return "Thinking"
  if (phase.startsWith("writing a tool call:")) return "Tool call"
  // "reading the prompt" and anything else must not override the task phases
  return null
}

function formatStreamDisplay(samples: StreamSample[], cumulative: number): string {
  const tps = calcLiveTps(samples)
  if (tps) return `Generation | ~${tps} t/s | ~${formatTokens(cumulative)} tokens`
  return `Generation | ~- t/s | ~${formatTokens(cumulative)} tokens`
}

function SessionPromptRight(props: {
  state: PluginState
  sessionID: string | undefined
  subscribe: (listener: () => void) => () => void
}) {
  const ctx = usePlugin()
  let text: TextRenderable | undefined

  const sync = () => {
    if (!text) return
    text.content = displayText()
    ctx.renderer.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref
        sync()
      }}
      fg={ctx.theme.text.muted}
    >
      {displayText()}
    </text>
  )

  function displayText() {
    // middle-dot separator + leading space so the status does not visually
    // merge with the preceding prompt/message content
    const body = statusText()
    return body ? ` · ${body}` : ""
  }

  function statusText() {
    const s = props.state
    if (s.state === "inactive") return ""
    if (s.state === "disc") return "✕"
    if (s.state === "disconnected") return "◯"

    const sessionID = props.sessionID
    const ttlOk = s.lastFinishedAt && (Date.now() - s.lastFinishedAt) <= LAST_FINISHED_TTL_MS
    const lastFinished = ttlOk ? s.lastFinished : null

    if (s.currentTask?.task === -1) {
      const samples = sessionID ? s.streamSamples[sessionID] : undefined
      if (samples?.length) {
        return formatStreamDisplay(samples, s.streamCumulative[sessionID!] || 0)
      }
      return formatReuseDisplay(s.currentTask.keep, s.currentTask.sim)
    }

    if (s.currentTask && !s.currentTask.finished && !s.currentTask.cancelled) {
      const t = s.currentTask
      if (t.phase === "prefill") {
        if (t.keep != null && t.promptTokens === 0 && t.promptTPS === 0 && t.progress === 0) {
          const samples = sessionID ? s.streamSamples[sessionID] : undefined
          if (samples?.length) {
            return formatStreamDisplay(samples, s.streamCumulative[sessionID!] || 0)
          }
          return formatReuseDisplay(t.keep, t.sim)
        }
        {
          const samples = sessionID ? s.streamSamples[sessionID] : undefined
          if (samples?.length) {
            return formatStreamDisplay(samples, s.streamCumulative[sessionID!] || 0)
          }
        }
        return `Processing | ${(t.progress * 100).toFixed(0)}% | ${t.promptTPS.toFixed(1)} t/s | ${formatTokens(t.promptTokens)} tokens`
      }
      const tps = t.generationTPS3s || t.generationTPS
      const semantic =
        s.upstream && Date.now() - s.upstreamAt <= UPSTREAM_STATE_STALE_MS
          ? semanticPhase(s.upstream.phase)
          : null
      if (semantic) return `${semantic} | ${formatRate(tps)} t/s | ${formatTokens(t.generatedTokens)} tokens`
      return `Generation | ${formatRate(tps)} t/s | ${formatTokens(t.generatedTokens)} tokens`
    }

    const t = s.currentTask
    const last = lastFinished || (t && (t.finished || t.cancelled) ? t : null)
    if (last) {
      if (last.cancelled) {
        return `Cancelled | ${formatTokens(last.generatedTokens)} tokens`
      }
      const durationMs = last.totalMs || s.durationMs || (s.startAt ? Date.now() - s.startAt : 0)
      const duration = formatDuration(durationMs)
      return `Done | ${duration ? `${duration} | ` : ""}${formatTokens(last.totalTokens || last.generatedTokens)} tokens`
    }

    if (!s.currentTask && !lastFinished) {
      const sessionStatus = sessionID ? ctx.data.session.status(sessionID) : undefined
      if (sessionStatus && sessionStatus !== "idle") {
        const samples = sessionID ? s.streamSamples[sessionID] : undefined
        if (samples?.length) {
          return formatStreamDisplay(samples, s.streamCumulative[sessionID!] || 0)
        }
      }
      return "—"
    }

    return "—"
  }
}

function parseSSEChunk(chunk: string, onEvent: (type: string, data: unknown) => void) {
  let eventType = "message"
  let data = ""
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    else if (line.startsWith("data:")) data = line.slice(5).trim()
  }
  if (!data) return
  try {
    onEvent(eventType, JSON.parse(data))
  } catch {
    // malformed JSON — skip the chunk, the stream is live, not reliable
  }
}

function connectSSE(
  url: string,
  onEvent: (type: string, data: unknown) => void,
  onClose: (err: Error) => void,
): { close: () => void } {
  let buffer = ""
  const decoder = new TextDecoder()
  let closed = false
  const controller = new AbortController()

  async function readLoop() {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error("No readable stream")

    while (!closed) {
      const { done, value } = await reader.read()
      if (done) {
        if (!closed) onClose(new Error("SSE stream closed"))
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() || ""
      for (const chunk of chunks) {
        parseSSEChunk(chunk, onEvent)
      }
    }
  }

  readLoop().catch((err: unknown) => {
    if (closed) return
    onClose(err instanceof Error ? err : new Error(String(err)))
  })

  return {
    close: () => {
      closed = true
      controller.abort()
    },
  }
}

async function fetchHealth(baseUrl: string): Promise<{ status: number; llama_swap_connected?: boolean }> {
  try {
    const res = await fetch(`${baseUrl}/pulse/health`)
    if (res.ok) {
      const body = await res.json()
      return { status: res.status, llama_swap_connected: body.llama_swap_connected }
    }
    return { status: res.status }
  } catch {
    return { status: 0 }
  }
}

function mapTaskState(raw: RawTaskState): TaskSnapshot {
  return {
    slot: raw.slot,
    task: raw.task,
    upstream: raw.upstream,
    phase: raw.phase ?? "prefill",
    promptTokens: raw.prompt_tokens || 0,
    generatedTokens: raw.generated_tokens || 0,
    promptTPS: raw.prompt_tps || 0,
    generationTPS: raw.generation_tps || 0,
    generationTPS3s: raw.generation_tps_3s || 0,
    progress: raw.progress || 0,
    finished: raw.finished || false,
    cancelled: raw.cancelled || false,
    updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : Date.now(),
    totalMs: raw.total_ms || 0,
    totalTokens: raw.total_tokens || 0,
    keep: raw.keep,
  }
}

async function fetchMetrics(baseUrl: string): Promise<TaskSnapshot | null> {
  try {
    const res = await fetch(`${baseUrl}/pulse/metrics`)
    if (!res.ok) return null
    const body: SnapshotData = await res.json()
    if (!body.current_task) return null
    return mapTaskState(body.current_task)
  } catch {
    return null
  }
}

function initEventHandlers(state: PluginState, bump: () => void, log?: LogFn) {
  const finalizeTask = (e: MetricEvent, cancelled: boolean) => {
    if (!state.currentTask) return
    state.currentTask.cancelled = cancelled
    state.currentTask.finished = true
    state.currentTask.updatedAt = Date.now()
    if (e.total_ms && e.total_ms > 0) {
      state.durationMs = e.total_ms
      state.currentTask.totalMs = e.total_ms
      state.currentTask.totalTokens = e.total_tokens || 0
    } else {
      state.durationMs = Date.now() - state.startAt
    }
    state.lastFinished = { ...state.currentTask }
    state.lastFinishedAt = Date.now()
    state.currentTask = null
    log?.(`${cancelled ? "task_cancelled" : "task_finished"}: duration=${state.durationMs}ms`)
    bump()
  }

  const handlers: Record<string, (e: MetricEvent) => void> = {
    slot_selected(e) {
      if (e.slot === -1 || e.slot === undefined) return
      state.currentTask = {
        slot: e.slot,
        task: -1,
        upstream: e.upstream,
        phase: "prefill",
        promptTokens: 0,
        generatedTokens: 0,
        promptTPS: 0,
        generationTPS: 0,
        generationTPS3s: 0,
        progress: 0,
        finished: false,
        cancelled: false,
        updatedAt: Date.now(),
        totalMs: 0,
        totalTokens: 0,
        keep: e.keep,
        sim: e.sim,
      }
      state.startAt = Date.now()
      state.durationMs = null
      log?.(`slot_selected: slot=${state.currentTask.slot}, keep=${state.currentTask.keep}, sim=${state.currentTask.sim}`)
      bump()
    },
    task_started(e) {
      if (e.slot === undefined) return
      const prevKeep = state.currentTask?.keep
      const prevSim = state.currentTask?.sim
      state.currentTask = {
        slot: e.slot,
        task: e.task ?? 0,
        upstream: e.upstream,
        phase: "prefill",
        promptTokens: 0,
        generatedTokens: 0,
        promptTPS: 0,
        generationTPS: 0,
        generationTPS3s: 0,
        progress: 0,
        finished: false,
        cancelled: false,
        updatedAt: Date.now(),
        totalMs: 0,
        totalTokens: 0,
        keep: prevKeep,
        sim: prevSim,
      }
      state.startAt = Date.now()
      state.durationMs = null
      log?.(`task_started: slot=${e.slot}, task=${e.task}, upstream=${e.upstream}`)
      bump()
    },
    prefill_progress(e) {
      if (!state.currentTask) return
      state.currentTask.task = e.task ?? state.currentTask.task
      state.currentTask.upstream = e.upstream ?? state.currentTask.upstream
      state.currentTask.phase = "prefill"
      state.currentTask.promptTokens = e.prompt_tokens || 0
      state.currentTask.promptTPS = e.prompt_tps || 0
      state.currentTask.progress = e.progress || 0
      state.currentTask.updatedAt = Date.now()
      log?.(`prefill_progress: tokens=${state.currentTask.promptTokens}, tps=${state.currentTask.promptTPS}`)
      bump()
    },
    generation_progress(e) {
      if (!state.currentTask) return
      state.currentTask.task = e.task ?? state.currentTask.task
      state.currentTask.upstream = e.upstream ?? state.currentTask.upstream
      state.currentTask.generatedTokens = e.generated_tokens || 0
      state.currentTask.generationTPS = e.generation_tps || 0
      state.currentTask.generationTPS3s = e.generation_tps_3s || 0
      state.currentTask.progress = e.progress || 0
      state.currentTask.phase = "generation"
      state.currentTask.updatedAt = Date.now()
      log?.(`generation_progress: tokens=${state.currentTask.generatedTokens}, tps=${state.currentTask.generationTPS}`)
      bump()
    },
    generation_complete(e) {
      if (!state.currentTask) return
      state.currentTask.generatedTokens = e.generated_tokens || 0
      state.currentTask.generationTPS = e.generation_tps || 0
      state.currentTask.updatedAt = Date.now()
      log?.(`generation_complete: tokens=${state.currentTask.generatedTokens}`)
      bump()
    },
    task_finished(e) {
      finalizeTask(e, false)
    },
    task_cancelled(e) {
      finalizeTask(e, true)
    },
    upstream_state(e) {
      const data = e.upstream_state
      if (!data) return
      // engine state, not task state: only accept it for the active task's
      // upstream, or while no task is in flight yet
      const current = state.currentTask
      if (current && e.upstream && current.upstream && e.upstream !== current.upstream) return
      const prevSemantic = semanticPhase(state.upstream?.phase)
      const nextSemantic = semanticPhase(data.phase)
      state.upstream = data
      state.upstreamAt = Date.now()
      // events come ~1/s; only re-render when the displayed semantic phase changes
      if (prevSemantic !== nextSemantic) bump()
    },
  }
  return handlers
}

function derivePulseUrl(ctx: Plugin.Context, sessionID: string, portOverride?: number): string | null {
  const session = ctx.data.session.get(sessionID)
  if (!session?.model?.providerID) return null

  const location = ctx.location ?? ctx.data.location.default()
  const providers = ctx.data.location.provider.list(location) ?? []
  const provider = providers.find((p) => p.id === session.model?.providerID)
  const baseURL = provider?.settings?.baseURL ? String(provider.settings.baseURL) : null
  if (!baseURL) return null

  const url = new URL(baseURL)
  const host = `${url.protocol}//${url.hostname}`

  const port = portOverride ?? (url.port ? Number(url.port) : undefined)
  const pulseBase = port ? `${host}:${port}` : host

  return pulseBase
}

const plugin: Plugin.Definition = Plugin.define({
  id: "oc-pulse",
  setup(ctx) {
    const debug = ctx.options?.debug === true
    const portOverride = typeof ctx.options?.port === "number" ? ctx.options.port : undefined

    const log = createLog(debug)

    const state: PluginState = {
      state: "inactive",
      currentTask: null,
      lastFinished: null,
      lastFinishedAt: null,
      startAt: 0,
      durationMs: null,
      upstream: null,
      upstreamAt: 0,
      streamSamples: {},
      streamCumulative: {},
      version: 0,
    }

    const listeners = new Set<() => void>()
    function bump() {
      state.version++
      for (const listener of listeners) listener()
      ctx.renderer.requestRender()
    }

    let currentPulseUrl: string | null = null
    let closeSSE: { close: () => void } | undefined
    let healthCheckTimer: ReturnType<typeof setInterval> | undefined
    let displayRefreshTimer: ReturnType<typeof setInterval> | undefined
    let pruneTimer: ReturnType<typeof setInterval> | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let backfillTimer: ReturnType<typeof setTimeout> | undefined
    let backoffMs = RECONNECT_BASE_MS
    let pollInFlight = false
    let pollQueued = false

    function closeStream() {
      closeSSE?.close()
      closeSSE = undefined
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    }

    function clearTaskData() {
      state.currentTask = null
      state.lastFinished = null
      state.lastFinishedAt = null
      state.startAt = 0
      state.durationMs = null
      state.upstream = null
      state.upstreamAt = 0
      state.streamSamples = {}
      state.streamCumulative = {}
    }

    function transitionTo(nextState: PluginState["state"]) {
      const prev = state.state
      state.state = nextState
      log?.(`State: ${prev} → ${nextState}`)

      if (nextState === "inactive") {
        closeStream()
        clearTaskData()
        clearInterval(displayRefreshTimer)
        displayRefreshTimer = undefined
        // healthCheckTimer keeps running to auto-reconnect
      }

      bump()
    }

    const eventHandlers = initEventHandlers(state, bump, log)

    function handleSSEEvent(type: string, data: unknown) {
      if (type === "snapshot") {
        // initial snapshot on SSE connect: resync, useful after reconnect
        const snap = data as SnapshotData
        state.upstream = null
        state.upstreamAt = 0
        if (snap.upstreams?.length) {
          const name = snap.current_task?.upstream
          const match = snap.upstreams.find((u) => (name ? u.upstream === name : true))
          if (match) {
            state.upstream = match
            state.upstreamAt = Date.now()
          }
        }
        if (snap.current_task) {
          const metrics = mapTaskState(snap.current_task)
          state.currentTask = metrics
          if (!metrics.finished && !metrics.cancelled) {
            state.startAt = metrics.updatedAt
          }
          log?.(`snapshot: phase=${metrics.phase}, upstream=${metrics.upstream}`)
          bump()
        }
        return
      }
      const event = data as MetricEvent
      const handler = eventHandlers[event.type ?? type]
      if (handler) handler(event)
    }

    function backfillTotals(expected: { slot: number; task: number }) {
      if (!currentPulseUrl) return
      if (backfillTimer) clearTimeout(backfillTimer)
      backfillTimer = setTimeout(async () => {
        backfillTimer = undefined
        if (!state.lastFinished) return
        if (state.lastFinished.slot !== expected.slot || state.lastFinished.task !== expected.task) return
        if (state.lastFinished.totalMs > 0) return
        const metrics = await fetchMetrics(currentPulseUrl!)
        if (!metrics || metrics.slot !== expected.slot || metrics.task !== expected.task) return
        if (metrics.totalMs <= 0) return
        state.lastFinished = { ...state.lastFinished, totalMs: metrics.totalMs, totalTokens: metrics.totalTokens }
        log?.(`backfill: ms=${metrics.totalMs}, tokens=${metrics.totalTokens}`)
        bump()
      }, METRICS_BACKFILL_DELAY_MS)
    }

    const wrappedHandlers: Record<string, (e: MetricEvent) => void> = {}
    for (const [type, handler] of Object.entries(eventHandlers)) {
      wrappedHandlers[type] = (e: MetricEvent) => {
        handler(e)
        if ((type === "task_finished" || type === "task_cancelled") && state.lastFinished && !(e.total_ms && e.total_ms > 0)) {
          backfillTotals({ slot: state.lastFinished.slot, task: state.lastFinished.task })
        }
      }
    }

    function onSSEClose(err: Error) {
      log?.(`SSE closed: ${err.message}`)
      closeSSE = undefined
      if (state.state === "active" || state.state === "disconnected") {
        transitionTo("disconnected")
        scheduleReconnect()
      }
    }

    function scheduleReconnect() {
      if (reconnectTimer || !currentPulseUrl) return
      const delay = backoffMs
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
      log?.(`reconnect in ${delay}ms`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        void reconnect()
      }, delay)
    }

    async function reconnect() {
      if (!currentPulseUrl || state.state === "inactive") return
      const metrics = await fetchMetrics(currentPulseUrl)
      if (metrics) {
        state.currentTask = metrics
        if (!metrics.finished && !metrics.cancelled) {
          state.startAt = metrics.updatedAt
        }
        closeSSE = connectSSE(`${currentPulseUrl}/pulse/live`, handleSSEEvent, onSSEClose)
        backoffMs = RECONNECT_BASE_MS
        transitionTo("active")
      } else {
        scheduleReconnect()
      }
    }

    async function doPoll() {
      if (pollInFlight) {
        pollQueued = true
        return
      }
      pollInFlight = true
      try {
        do {
          pollQueued = false
          await pollOnce()
        } while (pollQueued)
      } finally {
        pollInFlight = false
      }
    }

    async function pollOnce() {
      const route = ctx.ui.router.current()
      log?.(`doPoll: route=${route.type}, state=${state.state}`)
      if (route.type !== "session") {
        log?.("not a session route, inactive")
        transitionTo("inactive")
        return
      }

      const pulseUrl = derivePulseUrl(ctx, route.sessionID, portOverride)
      log?.(`pulseUrl=${pulseUrl ?? "null"}`)

      if (pulseUrl !== currentPulseUrl) {
        currentPulseUrl = pulseUrl
        if (!pulseUrl) {
          transitionTo("inactive")
          return
        }
        closeStream()
        clearTaskData()
        backoffMs = RECONNECT_BASE_MS
      }

      if (!pulseUrl) {
        transitionTo("inactive")
        return
      }

      const health = await fetchHealth(pulseUrl)
      log?.(`health=${health.status}, llama_swap=${health.llama_swap_connected}`)
      if (health.status === 200) {
        if (state.state !== "active") {
          const metrics = await fetchMetrics(pulseUrl)
          log?.(`metrics=${metrics ? `slot=${metrics.slot},task=${metrics.task},phase=${metrics.phase}` : "null"}`)
          if (metrics) {
            state.currentTask = metrics
            if (!metrics.finished && !metrics.cancelled) {
              state.startAt = metrics.updatedAt
            } else {
              // finished task picked up from the snapshot: no real start time;
              // rely on total_ms from the snapshot, do not fake a local duration
              state.startAt = 0
            }
            state.durationMs = metrics.totalMs || null
            closeSSE = connectSSE(`${pulseUrl}/pulse/live`, handleSSEEvent, onSSEClose)
            backoffMs = RECONNECT_BASE_MS
            transitionTo("active")
          } else {
            log?.("no metrics, inactive")
            transitionTo("inactive")
            return
          }
        }
      } else if (health.status === 503) {
        closeStream()
        transitionTo("disc")
      } else {
        closeStream()
        transitionTo("inactive")
      }
    }

    function onDelta(ev: { data: { sessionID: string; delta: string } }) {
      if (state.state !== "active" && state.state !== "disconnected") return
      const sessionID = ev.data.sessionID
      const now = Date.now()
      const tokens = estimateStreamTokens(ev.data.delta)
      state.streamCumulative[sessionID] = (state.streamCumulative[sessionID] || 0) + tokens
      state.streamSamples[sessionID] = [
        ...(state.streamSamples[sessionID] || []).filter((item: StreamSample) => now - item.at <= STREAM_WINDOW_MS),
        { at: now, tokens },
      ]
      bump()
    }

    const unsubscribers: Array<() => void> = [
      ctx.data.on("session.status", () => void doPoll()),
      ctx.data.on("session.model.selected", () => void doPoll()),
      ctx.data.on("session.text.delta", onDelta),
      ctx.data.on("session.reasoning.delta", onDelta),
    ]

    healthCheckTimer = setInterval(() => void doPoll(), HEALTH_CHECK_INTERVAL)
    displayRefreshTimer = setInterval(() => {
      if (state.state === "active") bump()
    }, DISPLAY_REFRESH_MS)
    pruneTimer = setInterval(() => {
      for (const [sid, samples] of Object.entries(state.streamSamples)) {
        const now = Date.now()
        const next = samples.filter((item: StreamSample) => now - item.at <= STREAM_WINDOW_MS)
        if (next.length !== samples.length) {
          if (next.length > 0) {
            state.streamSamples[sid] = next
          } else {
            delete state.streamSamples[sid]
            delete state.streamCumulative[sid]
          }
          bump()
        }
      }
    }, 1000)

    log?.(`init: portOverride=${portOverride}, debug=${debug}`)
    void doPoll()

    const slot = ctx.ui.slot({
      append: "prompt.footer",
      render: (input) => (
        <SessionPromptRight
          state={state}
          sessionID={input.sessionID}
          subscribe={(listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          }}
        />
      ),
    })

    return () => {
      slot?.()
      for (const unsub of unsubscribers) unsub?.()
      closeStream()
      if (backfillTimer) clearTimeout(backfillTimer)
      clearInterval(healthCheckTimer)
      clearInterval(displayRefreshTimer)
      clearInterval(pruneTimer)
    }
  },
})

export default plugin
