import type { VoiceMode } from '../types'

/** Longest text sent to the voice; longer replies are cut at a sentence end. */
export const MAX_SPOKEN_CHARS = 6000
/** Inline code this short and path-free is read as a word; anything else is dropped. */
const MAX_SPOKEN_CODE_CHARS = 30

const FENCED_CODE = /^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm
const UNCLOSED_FENCE = /^\s*(```|~~~)[\s\S]*$/m
const INLINE_CODE = /`([^`\n]*)`/g
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g
const LINK = /\[([^\]]+)\]\([^)]*\)/g
const URL_TEXT = /\bhttps?:\/\/\S+/g
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s,;)]+/g
const UNIX_PATH = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+/g
const EMPHASIS = /(\*\*|__|\*|~~)(?=\S)([^*~\n]+?)(?<=\S)\1/g
const LINE_MARKER = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/
const TABLE_OR_RULE = /^\s*(?:\|.*|[-*_=]{3,}\s*)$/
const ENDS_SENTENCE = /[.!?:;]["')\]]?$/

function lastPathPart(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part.length > 0)
  return ` ${parts.at(-1) ?? ''}`
}

function speakInlineCode(_match: string, code: string): string {
  const trimmed = code.trim()
  if (/^\/[\w-]+$/.test(trimmed)) return trimmed.slice(1) // a slash command: read its name
  const isWordLike = trimmed.length <= MAX_SPOKEN_CODE_CHARS && !/[\\/{}<>=;]/.test(trimmed)
  return isWordLike ? trimmed : ''
}

function cleanLine(line: string): string {
  const text = line
    .replace(LINE_MARKER, '')
    .replace(EMPHASIS, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return ''
  return ENDS_SENTENCE.test(text) ? text : `${text}.`
}

function cutAtSentence(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  return end > 0 ? head.slice(0, end + 1) : head
}

/** Paragraphs of plain, speakable prose: code, tables, links' targets and paths removed. */
export function toParagraphs(markdown: string): string[] {
  const prose = markdown
    .replace(/\r\n?/g, '\n')
    .replace(FENCED_CODE, '\n')
    .replace(UNCLOSED_FENCE, '\n')
    .replace(INLINE_CODE, speakInlineCode)
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(URL_TEXT, '')
    .replace(WINDOWS_PATH, lastPathPart)
    .replace(UNIX_PATH, lastPathPart)

  return prose
    .split(/\n\s*\n/)
    .map(block =>
      block
        .split('\n')
        .filter(line => !TABLE_OR_RULE.test(line))
        .map(cleanLine)
        .filter(line => line.length > 0)
        .join(' '),
    )
    .filter(paragraph => /[A-Za-z]/.test(paragraph))
}

/** What the voice reads for one final reply: all of it, or its last paragraph alone. */
export function toSpeech(answer: string, mode: VoiceMode): string {
  const paragraphs = toParagraphs(answer)
  const chosen = mode === 'last' ? paragraphs.slice(-1) : paragraphs
  return cutAtSentence(chosen.join(' '), MAX_SPOKEN_CHARS)
}
