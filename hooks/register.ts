import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { VoiceMode, VoiceSettings } from '../types'
import { toSpeech } from './speech-text'
import { closeVoice, ensureServer, silence, speak } from './voice-server'
import type { Device } from './voice-server'

const OFF: VoiceSettings = { isOn: false, mode: 'reply' }
// Change the tag when VoiceSettings changes shape: it declines older values.
const settings = atom({ plugin: 'kokoro-voice', key: 'settings' } as const, OFF, {
  shape: 'settings-1',
})

const USAGE =
  'Usage: /enable (reads the whole final reply), /enable last (its last paragraph only), /enable--close or /enable --close (shuts the voice down)'
const NEEDS_FOLDER =
  'Set your voice folder first: run /config, find "kokoro-voice: Voice folder", and enter the full path of the folder that holds speak_server.py (see the README).'
const CLOSE_WORDS = new Set(['--close', '-close', 'close', '--off', 'off'])
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
const UNSAFE_PATH_CHARS = /["'\n\r\t\0]/

type EnableRequest = VoiceMode | 'close'

/** The configured voice folder, or undefined when unset or not an absolute path. */
export function parseFolder(options: PluginOptions): string | undefined {
  const raw = options.voiceFolder
  if (typeof raw !== 'string') return undefined
  const folder = raw.trim()
  if (!ABSOLUTE_PATH.test(folder) || UNSAFE_PATH_CHARS.test(folder)) return undefined
  return folder
}

function parseRequest(args: string): EnableRequest | undefined {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'reply') return 'reply'
  if (word === 'last') return 'last'
  if (CLOSE_WORDS.has(word)) return 'close'
  return undefined
}

function showStatus($: EngineInterface, current: VoiceSettings, device?: Device): void {
  const what = current.mode === 'last' ? 'last paragraph' : 'final reply'
  $.ui.status(current.isOn ? `voice: ${what}${device ? ` (${device.toUpperCase()})` : ''}` : undefined)
}

async function closeCompletely($: EngineInterface): Promise<{ text: string }> {
  await update($, settings, current => ({ ...current, isOn: false }))
  showStatus($, OFF)
  await closeVoice($)
  return { text: 'Voice closed: speech stopped and the voice process has exited (no memory in use).' }
}

export const register: Register = (on, options) => {
  const folder = parseFolder(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'enable',
      description: "Read Claude's final reply aloud with the Kokoro voice",
      argumentHint: '[last | --close]',
    })
    await $.command.register({
      name: 'enable--close',
      description: 'Close the Kokoro voice completely (stops speech, ends its process, frees its RAM)',
      immediate: true,
    })
    await $.command.register({
      name: 'disable',
      description: 'Close the Kokoro voice completely (same as /enable --close)',
      immediate: true,
    })
    const started = await next(e)
    const current = await read($, settings)
    showStatus($, current)
    if (current.isOn && folder !== undefined) {
      // a reload restarts the voice it killed
      void ensureServer($, folder).then(device => showStatus($, current, device))
    }

    return started
  })

  on('command.run', { command: 'enable' }, async ($, e) => {
    const mode = parseRequest(e.args)
    if (mode === undefined) return { text: USAGE }
    if (mode === 'close') return closeCompletely($)
    if (folder === undefined) return { text: NEEDS_FOLDER }

    const device = await ensureServer($, folder)
    const next: VoiceSettings = { isOn: device !== undefined, mode }
    await update($, settings, () => next)
    showStatus($, next, device)
    if (device === undefined) {
      return {
        text: `The voice could not start from ${folder}. Check it holds speak_server.py, .venv (or .venv-gpu) and models (the debug log has details).`,
      }
    }
    const what = mode === 'last' ? 'the last paragraph of each final reply' : 'each final reply (no code)'
    return { text: `Voice on (${device.toUpperCase()}): reading ${what}. /enable--close to close it.` }
  })

  on('command.run', { command: 'enable--close' }, async $ => closeCompletely($))
  on('command.run', { command: 'disable' }, async $ => closeCompletely($))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || folder === undefined) return result

    const current = await read($, settings)
    if (!current.isOn) return result
    const text = toSpeech(e.answer, current.mode)
    if (text.length > 0) void speak($, folder, text)

    return result
  })

  // A new prompt means the person is back: stop talking over them.
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, settings)
    if (current.isOn) void silence($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await closeVoice($)
    return next(e)
  })
}
