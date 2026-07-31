/** @jsxImportSource @opentui/solid */
/**
 * (c) Bohdan Futerko, 2026, https://www.bf.com.ua, https://github.com/LeBohdan
 */
import { onCleanup } from "solid-js"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { TextRenderable } from "@opentui/core"

const HEALTH_CHECK_INTERVAL = 30_000
const DISPLAY_REFRESH_MS = 3_000
const LAST_FINISHED_TTL_MS = 30_000
const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000

type StreamSample = {
  at: number
  tokens: number
}

type MetricEvent =
  | { type: "slot_selected" | "task_started" | "prefill_progress" | "generation_progress" | "generation_complete" | "task_finished" | "task_cancelled" | "total_result" } & Partial<{
      slot: number
      task: number
      phase: "prefill" | "generation" | "finished"
      prompt_tokens: number
      prompt_tps: number
      progress: number
      generated_tokens: number
      generation_tps: number
      generation_tps_3s: number
      truncated: number
      total_ms: number
      total_tokens: number
      keep: number
      sim: number
      timestamp: string
    }>

type TaskSnapshot = {
  slot: number
  task: number
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

type PluginState = {
  state: "inactive" | "active" | "disc" | "disconnected"
  currentTask: TaskSnapshot | null
  lastFinished: TaskSnapshot | null
  lastFinishedAt: number | null
  startAt: number
  durationMs: number | null
  streamSamples: Record<string, StreamSample[]>
  streamCumulative: Record<string, number>
  version: number
}

type LogFn = (msg: string) => void

type ApiEvent = {
  properties: Record<string, unknown>
}

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
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, 'utf8') / 5))
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

function calcTotalSamples(samples: StreamSample[]): number {
  return samples.reduce((sum, s) => sum + s.tokens, 0)
}

function formatReuseDisplay(keep?: number, sim?: number): string {
  const parts: string[] = []
  if (sim != null) parts.push(`Match ${(sim * 100).toFixed(0)}%`)
  if (keep != null) parts.push(`Reuse ${(keep * 100).toFixed(0)}%`)
  return parts.join(' | ')
}

function formatStreamDisplay(samples: StreamSample[], cumulative: number): string {
  const tps = calcLiveTps(samples)
  if (tps) return `Generation | ~${tps} t/s | ~${formatTokens(cumulative)} tokens`
  return `Generation | ~- t/s | ~${formatTokens(cumulative)} tokens`
}

function SessionPromptRight(props: {
  api: Parameters<TuiPlugin>[0]
  state: PluginState
  sessionID: string
  subscribe: (listener: () => void) => () => void
}) {
  let text: TextRenderable | undefined

  const sync = () => {
    if (!text) return
    text.content = displayText()
    props.api.renderer.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref
        sync()
      }}
      fg={props.api.theme.current.textMuted}
    >
      {displayText()}
    </text>
  )

  function displayText() {
    const s = props.state
    if (s.state === "inactive") return ""
    if (s.state === "disc") return "✕"
    if (s.state === "disconnected") return "◯"

    const ttlOk = s.lastFinishedAt && (Date.now() - s.lastFinishedAt) <= LAST_FINISHED_TTL_MS
    const lastFinished = ttlOk ? s.lastFinished : null

    if (s.currentTask?.task === -1) {
      const samples = s.streamSamples[props.sessionID]
      if (samples?.length) {
        return formatStreamDisplay(samples, s.streamCumulative[props.sessionID] || 0)
      }
      return formatReuseDisplay(s.currentTask.keep, s.currentTask.sim)
    }

    if (s.currentTask && !s.currentTask.finished && !s.currentTask.cancelled) {
      const t = s.currentTask
      if (t.phase === "prefill") {
        if (t.keep != null && t.promptTokens === 0 && t.promptTPS === 0 && t.progress === 0) {
          const samples = s.streamSamples[props.sessionID]
          if (samples?.length) {
            return formatStreamDisplay(samples, s.streamCumulative[props.sessionID] || 0)
          }
          return formatReuseDisplay(t.keep, t.sim)
        }
        {
          const samples = s.streamSamples[props.sessionID]
          if (samples?.length) {
            return formatStreamDisplay(samples, s.streamCumulative[props.sessionID] || 0)
          }
        }
        return `Processing | ${(t.progress * 100).toFixed(0)}% | ${t.promptTPS.toFixed(1)} t/s | ${formatTokens(t.promptTokens)} tokens`
      }
      const tps = t.generationTPS3s || t.generationTPS
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
      const sessionStatus = props.api.state.session.status(props.sessionID)
      if (sessionStatus?.type !== "idle") {
        const samples = s.streamSamples[props.sessionID]
        if (samples?.length) {
          return formatStreamDisplay(samples, s.streamCumulative[props.sessionID] || 0)
        }
      }
      return "—"
    }

    return "—"
  }
}

function parseSSEChunk(chunk: string, onEvent: (event: MetricEvent) => void) {
  let eventType = "message"
  let data = ""
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim()
    else if (line.startsWith("data:")) data = line.slice(5).trim()
  }
  if (data) onEvent({ type: eventType, ...JSON.parse(data) } as MetricEvent)
}

async function connectSSE(
  url: string,
  onEvent: (event: MetricEvent) => void,
  onError: (err: Error) => void,
): Promise<{ close: () => void }> {
  let buffer = ""
  const decoder = new TextDecoder()
  let reader: ReadableStreamDefaultReader | null = null
  let closed = false
  const controller = new AbortController()

  async function readLoop() {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    })
    reader = res.body?.getReader()
    if (!reader) throw new Error("No readable stream")

    while (!closed) {
      const { done, value } = await reader.read()
      if (done) {
        if (!closed) onError(new Error("SSE stream closed"))
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() || ""
      for (const chunk of chunks) {
        parseSSEChunk(chunk, onEvent)
      }
    }
  }

  readLoop().catch(onError)

  return {
    close: () => {
      closed = true
      controller.abort()
      reader?.releaseLock()
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

async function fetchMetrics(baseUrl: string): Promise<TaskSnapshot | null> {
  try {
    const res = await fetch(`${baseUrl}/pulse/metrics`)
    if (!res.ok) return null
    const body = await res.json()
    if (!body.current_task) return null
    return {
      slot: body.current_task.slot,
      task: body.current_task.task,
      phase: body.current_task.phase as "prefill" | "generation" | "finished",
      promptTokens: body.current_task.prompt_tokens || 0,
      generatedTokens: body.current_task.generated_tokens || 0,
      promptTPS: body.current_task.prompt_tps || 0,
      generationTPS: body.current_task.generation_tps || 0,
      generationTPS3s: body.current_task.generation_tps_3s || 0,
      progress: body.current_task.progress || 0,
      finished: body.current_task.finished || false,
      cancelled: body.current_task.cancelled || false,
      updatedAt: new Date(body.current_task.updated_at).getTime(),
      totalMs: body.current_task.total_ms || 0,
      totalTokens: body.current_task.total_tokens || 0,
    }
  } catch {
    return null
  }
}

function initEventHandlers(state: PluginState, bump: () => void, log?: LogFn) {
  const handlers: Record<string, (e: MetricEvent) => void> = {
    slot_selected(e) {
      if (e.slot === -1 || e.slot === undefined) return
      state.currentTask = {
        slot: e.slot,
        task: -1,
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
        keep: e.keep || 0,
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
      log?.(`task_started: slot=${e.slot}, task=${e.task}`)
      bump()
    },
    prefill_progress(e) {
      if (!state.currentTask) return
      state.currentTask.task = e.task ?? state.currentTask.task
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
      if (!state.currentTask) return
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
      log?.(`task_finished: duration=${state.durationMs}ms`)
      bump()
    },
    task_cancelled(e) {
      if (!state.currentTask) return
      state.currentTask.cancelled = true
      state.currentTask.finished = true
      state.currentTask.updatedAt = Date.now()
      state.durationMs = Date.now() - state.startAt
      state.lastFinished = { ...state.currentTask }
      state.lastFinishedAt = Date.now()
      state.currentTask = null
      log?.("task_cancelled")
      bump()
    },
    total_result(e) {
      if (!state.currentTask) return
      if (e.total_ms && e.total_ms > 0) {
        state.currentTask.totalMs = e.total_ms
        state.currentTask.totalTokens = e.total_tokens || 0
        state.currentTask.updatedAt = Date.now()
        log?.(`total_result: ms=${e.total_ms}, tokens=${e.total_tokens}`)
        bump()
      }
    },
  }
  return handlers
}

function derivePulseUrl(api: Parameters<TuiPlugin>[0], portOverride?: number): string | null {
  const route = api.route.current
  if (route.name !== "session") return null

  const session = api.state.session.get(route.params.sessionID as string)
  if (!session) return null
  if (!session.model?.providerID) return null

  const provider = api.state.provider.find((p) => p.id === session.model.providerID)
  if (!provider?.options?.baseURL) return null

  const baseURL = String(provider.options.baseURL)
  const url = new URL(baseURL)
  const host = `${url.protocol}//${url.hostname}`

  const port = (portOverride as number | undefined) ?? url.port
  const pulseBase = port ? `${host}:${port}` : host

  return pulseBase
}

const tui: TuiPlugin = async (api, options) => {
  const debug = options?.debug === true
  const portOverride = options?.port

  let currentPulseUrl: string | null = null

  const log = createLog(debug)

  let state: PluginState = {
    state: "inactive",
    currentTask: null,
    lastFinished: null,
    lastFinishedAt: null,
    startAt: 0,
    durationMs: null,
    streamSamples: {},
    streamCumulative: {},
    version: 0,
  }

  const listeners = new Set<() => void>()
  function bump() {
    state.version++
    for (const listener of listeners) listener()
    api.renderer.requestRender()
  }

  const eventHandlers = initEventHandlers(state, bump, log)
  let closeSSE: { close: () => void } | undefined
  let healthCheckTimer: ReturnType<typeof setInterval> | undefined
  let displayRefreshTimer: ReturnType<typeof setInterval> | undefined
  let pruneTimer: ReturnType<typeof setInterval> | undefined

  function transitionTo(nextState: PluginState["state"]) {
    const prev = state.state
    state.state = nextState
    log?.(`State: ${prev} → ${nextState}`)

    if (nextState === "inactive") {
      closeSSE?.close()
      state.currentTask = null
      state.lastFinished = null
      state.lastFinishedAt = null
      state.streamSamples = {}
      state.streamCumulative = {}
      clearInterval(displayRefreshTimer)
      displayRefreshTimer = undefined
      // healthCheckTimer keeps running to auto-reconnect
    }

    log?.(`State: ${prev} → ${nextState}`)
    bump()
  }

  async function doPoll() {
    log?.(`doPoll: route=${JSON.stringify(api.route.current.name)}, state=${state.state}`)
    const route = api.route.current
    if (route.name !== "session") {
      log?.("not a session route, inactive")
      transitionTo("inactive")
      return
    }

    const pulseUrl = derivePulseUrl(api, portOverride as number | undefined)
    log?.(`pulseUrl=${pulseUrl ?? "null"}`)

    if (pulseUrl !== currentPulseUrl) {
      currentPulseUrl = pulseUrl
      if (!pulseUrl) {
        transitionTo("inactive")
        return
      }
      closeSSE?.close()
      state.currentTask = null
      state.lastFinished = null
      state.lastFinishedAt = null
      state.streamSamples = {}
      state.streamCumulative = {}
    }

    if (!pulseUrl) {
      transitionTo("inactive")
      return
    }

    log?.(`pulseUrl=${pulseUrl}`)
    const health = await fetchHealth(pulseUrl)
    log?.(`health=${health.status}, llama_swap=${health.llama_swap_connected}`)
    if (health.status === 200) {
      if (state.state !== "active") {
        const metrics = await fetchMetrics(pulseUrl)
        log?.(`metrics=${metrics ? JSON.stringify(metrics).slice(0, 80) : "null"}`)
        if (metrics) {
          state.currentTask = metrics
          if (!metrics.finished && !metrics.cancelled) {
            state.startAt = metrics.updatedAt
          } else {
            state.startAt = Date.now()
          }
          state.durationMs = null
          closeSSE = await connectSSE(`${pulseUrl}/pulse/live`, (e) => {
            const handler = eventHandlers[e.type]
            if (handler) handler(e)
          }, (err) => {
            console.error(`[oc-pulse] SSE error: ${err.message}`)
            if (state.state === "active") transitionTo("disconnected")
          })
          if (!closeSSE) {
            console.error(`[oc-pulse] no SSE connection, inactive`)
            transitionTo("inactive")
            return
          }
          transitionTo("active")
        } else {
          log?.("no metrics, inactive")
          transitionTo("inactive")
          return
        }
      }
    } else if (health.status === 503) {
      closeSSE?.close()
      transitionTo("disc")
    } else {
      closeSSE?.close()
      transitionTo("inactive")
    }
  }

  async function bootstrap() {
    log?.("bootstrap started")
    await doPoll()
  }

  function startTimers() {
    healthCheckTimer = setInterval(doPoll, HEALTH_CHECK_INTERVAL)
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
  }

  api.event.on("session.status", () => doPoll())

  api.event.on("session.next.model.switched", () => {
    doPoll()
  })

  const unsubDelta = api.event.on("message.part.delta", (evt: ApiEvent) => {
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID as string)
    const part = parts.find((item: any) => item.id === evt.properties.partID)
    if (!part) return
    if (part.type !== "text" && part.type !== "reasoning") return
    const sessionID = evt.properties.sessionID as string
    const delta = evt.properties.delta as string
    const now = Date.now()
    const tokens = estimateStreamTokens(delta)
    state.streamCumulative[sessionID] = (state.streamCumulative[sessionID] || 0) + tokens
    state.streamSamples[sessionID] = [
      ...(state.streamSamples[sessionID] || []).filter((item: StreamSample) => now - item.at <= STREAM_WINDOW_MS),
      { at: now, tokens },
    ]
    bump()
  })

  log?.(`init: portOverride=${portOverride}, debug=${debug}`)
  startTimers()
  bootstrap()

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return <SessionPromptRight api={api} state={state} sessionID={value.session_id as string} subscribe={(listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        }} />
      },
    },
  })

  api.lifecycle.onDispose(() => {
    unsubDelta?.()
    closeSSE?.close()
    clearInterval(healthCheckTimer)
    clearInterval(displayRefreshTimer)
    clearInterval(pruneTimer)
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "oc-pulse",
  tui,
}

export default plugin
