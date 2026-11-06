/**
 * dsh-safety-guard — pure helpers.
 *
 * No `@deepseek-ai/*` imports here: this module is unit-testable with plain
 * Node, and the Cordis entry (`index.js`) wires it into the harness.
 */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, relative, dirname, basename } from 'node:path'

/** Token that identifies a DSH-generated file; greppable and stable. */
export const MARKER_TOKEN = 'DSH-GENERATED'

/** Where old files are backed up before the agent may modify or delete them. */
export const DEFAULT_BACKUP_ROOT = 'D:\\DSH备份'

/** A non-blank string, or undefined. */
export function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The path a first-party file-tool call is about to mutate:
 * `write`, `edit`, and the mutating `str_replace_editor` commands.
 * Mirrors `@deepseek-ai/dsh-workspace-changes`' mutationPath.
 */
export function mutationPath(name, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args
  switch (name) {
    case 'write':
      return typeof record.content === 'string' ? text(record.file_path) : undefined
    case 'edit':
      return typeof record.old_string === 'string' && typeof record.new_string === 'string'
        ? text(record.file_path)
        : undefined
    case 'str_replace_editor':
      return record.command === 'create' || record.command === 'str_replace' || record.command === 'insert'
        ? text(record.path)
        : undefined
    default:
      return undefined
  }
}

const HASH_EXT = new Set([
  '.py', '.pyw', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.psd1',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.rb', '.pl', '.pm',
  '.r', '.mk', '.env', '.txt', '.gitignore', '.dockerignore', '.npmrc',
])
const SLASH_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx',
  '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.go', '.rs',
  '.php', '.swift', '.kt', '.kts', '.scala', '.dart', '.groovy', '.gradle',
  '.m', '.mm', '.proto', '.solidity',
])
const DASH_EXT = new Set(['.sql', '.lua', '.hs', '.ada'])
const SEMI_EXT = new Set(['.clj', '.cljs', '.lisp', '.el', '.scm'])
const BLOCK_EXT = new Set(['.css', '.scss', '.sass', '.less'])
const HTML_EXT = new Set([
  '.html', '.htm', '.xhtml', '.xml', '.svg', '.vue', '.svelte', '.md', '.markdown',
])

/**
 * Choose the comment syntax for a file, or undefined when appending a footer
 * would corrupt it (JSON has no comments; binary formats must not be touched).
 */
export function commentStyleFor(filePath) {
  const path = String(filePath ?? '')
  const lower = path.toLowerCase()
  const base = basename(lower)
  if (base === 'makefile' || base === 'dockerfile' || base === 'cmakelists.txt') return { kind: 'line', prefix: '#' }
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  if (HTML_EXT.has(ext)) return { kind: 'html' }
  if (BLOCK_EXT.has(ext)) return { kind: 'block', open: '/*', close: '*/' }
  if (HASH_EXT.has(ext)) return { kind: 'line', prefix: '#' }
  if (SLASH_EXT.has(ext)) return { kind: 'line', prefix: '//' }
  if (DASH_EXT.has(ext)) return { kind: 'line', prefix: '--' }
  if (SEMI_EXT.has(ext)) return { kind: 'line', prefix: ';' }
  return undefined
}

/** The marker line for one comment style and timestamp. */
export function markLine(style, iso) {
  const body = `[${MARKER_TOKEN}] written by DeepSeek Harness at ${iso}; do not remove`
  if (style.kind === 'html') return `<!-- ${body} -->`
  if (style.kind === 'block') return `${style.open} ${body} ${style.close}`
  return `${style.prefix} ${body}`
}

/** Whether the tail of the content already carries a marker. */
export function alreadyMarked(content) {
  return typeof content === 'string' && content.slice(-1600).includes(`[${MARKER_TOKEN}]`)
}

/**
 * Append the footer marker to text content when the file format tolerates a
 * trailing comment. Returns the (possibly unchanged) content plus a reason.
 */
export function markText(content, filePath, iso) {
  const body = typeof content === 'string' ? content : String(content ?? '')
  if (body.includes('\u0000')) return { changed: false, content: body, reason: 'binary' }
  const style = commentStyleFor(filePath)
  if (!style) return { changed: false, content: body, reason: 'no-comment-style' }
  if (alreadyMarked(body)) return { changed: false, content: body, reason: 'already-marked' }
  const line = markLine(style, iso)
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n'
  return { changed: true, content: `${body}${sep}${line}\n`, marker: line }
}

/** Lowercase hex SHA-256 of a string or Buffer. */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Whether a shell command looks destructive (delete / recursive remove).
 * Deliberately conservative: false negatives are safer than blocking a
 * legitimate read.
 */
export function isDestructiveCommand(command) {
  if (typeof command !== 'string' || command === '') return false
  const c = command
  return (
    /(^|[\s;&|(`"'])(rm|del|erase|rmdir|rd)\s/i.test(c) ||
    /\bRemove-Item\b/i.test(c) ||
    /\[System\.IO\.File\]::Delete/i.test(c) ||
    /\[System\.IO\.Directory\]::Delete/i.test(c) ||
    /\/bin\/rm\s/i.test(c)
  )
}

/** Resolve a model-supplied path against the session workspace. */
export function resolveAbsPath(raw, cwd) {
  const value = text(raw)
  if (value === undefined) return undefined
  const base = text(cwd) ?? process.cwd()
  return isAbsolute(value) ? value : resolve(base, value)
}

/** Local calendar date (YYYY-MM-DD) for backup directory grouping. */
export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Filesystem-safe timestamp (YYYY-MM-DDTHH-mm-ss-SSS). */
export function fileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Relative path used under the backup root; external paths are isolated. */
export function backupRelPath(absPath, cwd) {
  const base = text(cwd) ?? process.cwd()
  let rel = relative(base, absPath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(absPath)
    rel = match ? `__external__/${match[1]}/${match[2]}` : `__external__/${absPath}`
  }
  return rel.replace(/\\/g, '/')
}

/** Default plugin config. */
export function defaultConfig() {
  return {
    backupRoot: DEFAULT_BACKUP_ROOT,
    backupInModes: ['danger-full-access'],
    markEnabled: true,
    snapshotBeforeShellDelete: true,
    maxSnapshotBytes: 268435456, // 256 MiB
    markMaxFileBytes: 8388608, // 8 MiB
  }
}

/** Merge a raw config row over the defaults without trusting its shapes. */
export function normalizeConfig(raw) {
  const d = defaultConfig()
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    backupRoot: text(c.backupRoot) ?? d.backupRoot,
    backupInModes:
      Array.isArray(c.backupInModes) && c.backupInModes.length > 0
        ? c.backupInModes.filter((m) => typeof m === 'string')
        : d.backupInModes,
    markEnabled: typeof c.markEnabled === 'boolean' ? c.markEnabled : d.markEnabled,
    snapshotBeforeShellDelete:
      typeof c.snapshotBeforeShellDelete === 'boolean' ? c.snapshotBeforeShellDelete : d.snapshotBeforeShellDelete,
    maxSnapshotBytes:
      Number.isFinite(c.maxSnapshotBytes) && c.maxSnapshotBytes > 0 ? Math.floor(c.maxSnapshotBytes) : d.maxSnapshotBytes,
    markMaxFileBytes:
      Number.isFinite(c.markMaxFileBytes) && c.markMaxFileBytes > 0 ? Math.floor(c.markMaxFileBytes) : d.markMaxFileBytes,
  }
}

/** Whether `child` resolves inside `parent` (case-insensitive on Windows). */
export function isInside(parent, child) {
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase()
  const a = norm(parent)
  const b = norm(child)
  if (a === b) return true
  return b.startsWith(a.endsWith('/') ? a : a + '/')
}
