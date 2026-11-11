import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Timer,
} from 'claude-code'

const PORT = 59125
const BASE_URL = `http://127.0.0.1:${PORT}`
const READY_TIMEOUT_MS = 45_000
const POLL_MS = 400
/** The server exits after IDLE_EXIT_SECONDS without a call; we check in well within that. */
const IDLE_EXIT_SECONDS = 180
const CHECK_IN_MS = 60_000

export type Device = 'gpu' | 'cpu'

type Launch = { device: Device; python: string }
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

// The running voice process and its check-in timer, owned by this module: a
// reload or the session's end unloads the module, which kills the process; if
// Claude Code dies instead, the missing check-ins make the server exit itself.
let child: Child | undefined
let checkIn: Timer | undefined

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function debug($: EngineInterface, text: string): void {
  $.ui.log(`kokoro-voice: ${text}`, { to: 'debug' })
}

function sleep($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
}

function isWindowsPath(folder: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('\\\\')
}

function join(folder: string, ...parts: string[]): string {
  const separator = isWindowsPath(folder) ? '\\' : '/'
  return [folder.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

/**
 * Tried in order. On Windows: the GPU through DirectML (`.venv-gpu`), then the
 * CPU (`.venv`). Elsewhere DirectML does not exist, so only the CPU.
 */
function launchesFor(folder: string): readonly Launch[] {
  if (!isWindowsPath(folder)) return [{ device: 'cpu', python: join(folder, '.venv', 'bin', 'python') }]
  return [
    { device: 'gpu', python: join(folder, '.venv-gpu', 'Scripts', 'python.exe') },
    { device: 'cpu', python: join(folder, '.venv', 'Scripts', 'python.exe') },
  ]
}

async function post($: EngineInterface, path: '/say' | '/stop' | '/quit', body = ''): Promise<boolean> {
  try {
    const response = await $.http.fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body,
    })
    if (!response.ok) debug($, `${path} answered ${response.status}: ${response.text}`)
    return response.ok
  } catch (error: unknown) {
    debug($, `${path} failed: ${describe(error)}`)
    return false
  }
}

/** The device a running voice answers with, or undefined when none answers. */
async function runningDevice($: EngineInterface): Promise<Device | undefined> {
  try {
    const response = await $.http.fetch(`${BASE_URL}/health`)
    if (!response.ok) return undefined
    return response.text.includes('gpu') ? 'gpu' : 'cpu'
  } catch {
    return undefined // not listening (yet): the caller polls again or starts one
  }
}

async function watch($: EngineInterface, stream: Child): Promise<void> {
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') debug($, text.trim())
    }
  } catch (error: unknown) {
    debug($, `voice process could not start: ${describe(error)}`)
  } finally {
    if (child === stream) child = undefined
  }
}

function startCheckIn($: EngineInterface): void {
  if (checkIn !== undefined) return
  checkIn = $.clock.every(CHECK_IN_MS, () => {
    void runningDevice($)
  })
}

function stopCheckIn(): void {
  checkIn?.cancel()
  checkIn = undefined
}

async function launch($: EngineInterface, folder: string, { device, python }: Launch): Promise<Device | undefined> {
  const script = join(folder, 'speak_server.py')
  const started = $.process.spawn({
    argv: [python, script, '--port', String(PORT), '--device', device, '--idle-exit', String(IDLE_EXIT_SECONDS)],
    cwd: folder,
  })
  child = started
  void watch($, started)
  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += POLL_MS) {
    const running = await runningDevice($)
    if (running !== undefined) return running
    if (child !== started) return undefined // it exited: the stderr line is in the debug log
    await sleep($, POLL_MS)
  }
  debug($, `${device} voice not ready after ${READY_TIMEOUT_MS} ms`)
  await shutdown()
  return undefined
}

/**
 * Starts the voice from `folder` (the one holding speak_server.py) unless one
 * already answers, GPU first where there is one; resolves the device, or undefined.
 */
export async function ensureServer($: EngineInterface, folder: string): Promise<Device | undefined> {
  const running = await runningDevice($)
  if (running !== undefined) {
    startCheckIn($)
    return running
  }
  if (child !== undefined) await shutdown() // a process that stopped answering
  for (const candidate of launchesFor(folder)) {
    const started = await launch($, folder, candidate)
    if (started !== undefined) {
      startCheckIn($)
      return started
    }
    debug($, `${candidate.device} voice failed; trying the next device`)
  }
  return undefined
}

/** Speaks `text`, cutting off whatever was playing. */
export async function speak($: EngineInterface, folder: string, text: string): Promise<boolean> {
  return (await ensureServer($, folder)) !== undefined && post($, '/say', text)
}

/** Silences the voice if it is running; never starts it. */
export async function silence($: EngineInterface): Promise<void> {
  if (child !== undefined || (await runningDevice($)) !== undefined) await post($, '/stop')
}

/** Ends the voice process this module started. */
export async function shutdown(): Promise<void> {
  const running = child
  child = undefined
  await running?.return(undefined as unknown as ProcessSpawnResult)
}

/**
 * Closes the voice completely: stops checking in, asks the server to exit
 * (even one another session started), then ends this module's process
 * handle. The process exits, so all its RAM, GPU share included, is freed.
 */
export async function closeVoice($: EngineInterface): Promise<void> {
  stopCheckIn()
  if (child !== undefined || (await runningDevice($)) !== undefined) await post($, '/quit')
  await shutdown()
}
