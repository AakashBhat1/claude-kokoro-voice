import { expect, test } from 'claude-code/testing'

import { parseFolder } from '../hooks/register'
import { MAX_SPOKEN_CHARS, toSpeech } from '../hooks/speech-text'

const OPTIONS = { options: { voiceFolder: 'D:/voice' } } as const

const REPLY = [
  "I've **added** the `/enable` command in [the mod](https://example.com/x).",
  '',
  '```ts',
  'const secret = doNotRead()',
  '```',
  '',
  '| file | change |',
  '|------|--------|',
  '| a.ts | new |',
  '',
  '- Edited C:\\dev\\kokoro-voice\\speak_server.py',
  '- Run `pnpm dlx tsc -p ./tsconfig.json`',
  '',
  'Try it now and tell me how it sounds',
].join('\n')

test('code, tables, links and paths are not read', () => {
  const spoken = toSpeech(REPLY, 'reply')
  expect(spoken).toBe(
    "I've added the enable command in the mod. Edited speak_server.py. Run. Try it now and tell me how it sounds.",
  )
})

test('last mode reads only the final paragraph', () => {
  expect(toSpeech(REPLY, 'last')).toBe('Try it now and tell me how it sounds.')
})

test('a reply of only code says nothing', () => {
  expect(toSpeech('```py\nprint(1)\n```', 'reply')).toBe('')
})

test('a very long reply is cut at a sentence end', () => {
  const spoken = toSpeech('This is one sentence. '.repeat(1000), 'reply')
  expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS)
  expect(spoken.endsWith('sentence.')).toBe(true)
})

test('/enable then a final reply sends the cleaned text to the voice', OPTIONS, async ($, on) => {
  const said: string[] = []
  on('command.register', () => ({ value: { command: 'enable' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/say')) said.push(String(e.init?.body ?? ''))
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('command.run', () => ({ text: 'core' }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const enabled = await $.command.run({ command: 'enable', args: '' })
  expect(enabled.text).toContain('Voice on')

  await $.turn.complete({
    answer: 'Done.\n\n```js\nx()\n```\n\nAll **tests** pass',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  // Speaking is sent in the background so the turn never waits on the voice.
  for (let tries = 0; tries < 50 && said.length === 0; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(said).toEqual(['Done. All tests pass.'])

  // A subagent's answer is never read.
  await $.turn.complete({
    answer: 'subagent report',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    agentId: 'a1',
    reason: 'answer',
  })
  expect(said.length).toBe(1)
})

test('/enable --close and /enable--close tell the voice process to exit', async ($, on) => {
  const posted: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    posted.push(e.url.replace(/^https?:\/\/[^/]+/, ''))
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('command.run', () => ({ text: 'core' }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const closed = await $.command.run({ command: 'enable', args: '--close' })
  expect(closed.text).toContain('Voice closed')
  expect(posted).toContain('/quit')

  const again = await $.command.run({ command: 'enable--close' })
  expect(again.text).toContain('Voice closed')
  expect(posted.filter(path => path === '/quit').length).toBe(2)
})

test('the folder setting must be an absolute path', () => {
  expect(parseFolder({ voiceFolder: 'D:\\voice' })).toBe('D:\\voice')
  expect(parseFolder({ voiceFolder: ' /home/me/voice ' })).toBe('/home/me/voice')
  expect(parseFolder({})).toBeUndefined()
  expect(parseFolder({ voiceFolder: 'voice' })).toBeUndefined()
  expect(parseFolder({ voiceFolder: '~/voice' })).toBeUndefined()
  expect(parseFolder({ voiceFolder: 'D:\\a"b' })).toBeUndefined()
})

test('/enable without a voice folder asks for one and starts nothing', async ($, on) => {
  const fetched: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('command.run', () => ({ text: 'core' }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run({ command: 'enable', args: '' })
  expect(answer.text).toContain('/config')
  expect(fetched).toEqual([])
})

test('/enable with a bad word explains the usage and stays off', async ($, on) => {
  on('command.register', () => ({ value: { command: 'enable' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: 'core' }))
  on('ui.status', () => ({ value: undefined }))
  const answer = await $.command.run({ command: 'enable', args: 'loud' })
  expect(answer.text).toContain('Usage')
})
