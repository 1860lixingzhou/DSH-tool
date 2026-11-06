/**
 * dsh-safety-guard — harness wiring.
 *
 * Registers two tool-pipeline listeners plus one query tool:
 *  - `tools/pre-execute`: back up an existing file to `backupRoot` before a
 *    `write`/`edit`/mutating `str_replace_editor` (and snapshot the workspace
 *    before a destructive shell command), but only in the configured modes.
 *  - `tools/post-execute`: append the `[DSH-GENERATED]` footer marker to the
 *    file a successful file-tool call produced, then update the origin
 *    registry.
 *  - `dsh_file_origin`: report whether a file is DSH-authored.
 *
 * Only Node built-ins and `./core.js` are imported, so the module is testable
 * outside the harness.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync,
  renameSync, readdirSync, unlinkSync,
} from 'node:fs'
import { extname, join, basename, dirname } from 'node:path'
import {
  alreadyMarked, backupRelPath, dateStamp, fileStamp, isDestructiveCommand, isInside,
  markText, mutationPath, normalizeConfig, resolveAbsPath, sha256,
} from './core.js'

const ORIGIN_FILE = 'origin.json'
const ORIGIN_VERSION = 1

function loadOrigins(originPath) {
  try {
    const raw = JSON.parse(readFileSync(originPath, 'utf8'))
    if (raw && raw.version === ORIGIN_VERSION && raw.files && typeof raw.files === 'object') return raw
  } catch {
    // missing or unreadable registry: start empty
  }
  return { version: ORIGIN_VERSION, files: {} }
}

function boundedDirSize(root, cap) {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(p)
      } else if (entry.isFile()) {
        try {
          total += statSync(p).size
        } catch {
          // unreadable entries do not abort the estimate
        }
        if (total > cap) return total
      }
    }
  }
  return total
}

function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true })
  const stack = [{ src, dest }]
  while (stack.length > 0) {
    const { src: s, dest: d } = stack.pop()
    let entries
    try {
      entries = readdirSync(s, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const sp = join(s, entry.name)
      const dp = join(d, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        mkdirSync(dp, { recursive: true })
        stack.push({ src: sp, dest: dp })
      } else if (entry.isFile()) {
        try {
          copyFileSync(sp, dp)
        } catch {
          // a single unreadable file must not abort the snapshot
        }
      }
    }
  }
}

function renderOrigin(value) {
  const lines = [
    `path: ${value.path}`,
    `origin: ${value.origin}`,
    `registered: ${value.registered}`,
    `marked: ${value.marked}`,
  ]
  if (value.authoredAt !== undefined) lines.push(`authoredAt: ${value.authoredAt}`)
  if (value.tool !== undefined) lines.push(`tool: ${value.tool}`)
  if (value.sha256 !== undefined) lines.push(`sha256: ${value.sha256}`)
  return lines.join('\n')
}

/**
 * Build the guard for one plugin instance.
 * @param ctx - Cordis context.
 * @param config - raw plugin config row.
 * @returns plugin state plus an `install()` that registers the effects.
 */
export function createGuard(ctx, config) {
  const cfg = normalizeConfig(config)
  const backupRoot = cfg.backupRoot
  const originPath = join(backupRoot, ORIGIN_FILE)
  const state = {
    origins: loadOrigins(originPath),
    lastBackupHash: new Map(),
  }

  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(`dsh-safety-guard: ${message}`)
    } catch {
      // logging must never break a tool call
    }
  }

  try {
    mkdirSync(backupRoot, { recursive: true })
  } catch (error) {
    log('warn', `cannot create backup root ${backupRoot}: ${error?.message ?? error}`)
  }

  function saveOrigins() {
    try {
      const tmp = `${originPath}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(state.origins, null, 2), 'utf8')
      renameSync(tmp, originPath)
    } catch (error) {
      log('warn', `cannot persist origin registry: ${error?.message ?? error}`)
    }
  }

  const sessionOf = (exec) => exec?.agent?.session

  const cwdOf = (session) => session?.header?.cwd ?? session?.cwd ?? process.cwd()

  function modeOf(session) {
    const policy = ctx?.get?.('sandboxPolicy')
    if (policy && typeof policy.resolve === 'function') {
      try {
        return policy.resolve({ session })?.mode ?? 'danger-full-access'
      } catch {
        // fall through to the fail-safe assumption
      }
    }
    return 'danger-full-access'
  }

  function shouldBackup(mode) {
    return cfg.backupInModes.includes(mode)
  }

  function backupExisting(absPath, kind, session) {
    try {
      if (!existsSync(absPath)) return undefined
      const st = statSync(absPath)
      if (!st.isFile()) return undefined
      const bytes = readFileSync(absPath)
      const hash = sha256(bytes)
      if (state.lastBackupHash.get(absPath) === hash) return undefined
      const now = new Date()
      const rel = backupRelPath(absPath, cwdOf(session))
      const destDir = join(backupRoot, 'files', dateStamp(now), dirname(rel))
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, `${basename(absPath)}.${fileStamp(now)}.${kind}.bak`)
      copyFileSync(absPath, dest)
      state.lastBackupHash.set(absPath, hash)
      log('info', `backed up ${absPath} -> ${dest}`)
      return dest
    } catch (error) {
      log('warn', `backup failed for ${absPath}: ${error?.message ?? error}`)
      return undefined
    }
  }

  function snapshotWorkspace(session) {
    const cwd = cwdOf(session)
    try {
      if (!existsSync(cwd)) return { ok: false, reason: 'missing-workspace' }
      if (isInside(backupRoot, cwd) || isInside(cwd, backupRoot)) {
        log('warn', `skip snapshot: workspace ${cwd} overlaps backup root ${backupRoot}`)
        return { ok: true, skipped: 'overlap' }
      }
      const size = boundedDirSize(cwd, cfg.maxSnapshotBytes)
      if (size > cfg.maxSnapshotBytes) {
        log('warn', `workspace ${cwd} is ${size} bytes, above maxSnapshotBytes ${cfg.maxSnapshotBytes}`)
        return { ok: false, reason: 'too-large', size }
      }
      const dest = join(backupRoot, 'snap', fileStamp(new Date()))
      copyDirRecursive(cwd, dest)
      log('info', `snapshot of ${cwd} -> ${dest}`)
      return { ok: true, dest }
    } catch (error) {
      log('warn', `snapshot failed for ${cwd}: ${error?.message ?? error}`)
      return { ok: false, reason: 'error' }
    }
  }

  function markTarget(absPath) {
    try {
      if (!cfg.markEnabled) return { changed: false }
      if (!existsSync(absPath)) return { changed: false }
      const st = statSync(absPath)
      if (!st.isFile()) return { changed: false }
      if (st.size > cfg.markMaxFileBytes) return { changed: false, reason: 'too-large' }
      if (!extname(absPath) && basename(absPath).indexOf('.') === -1) {
        // extension-less files are only marked for known basenames
        const lower = basename(absPath).toLowerCase()
        if (!['makefile', 'dockerfile', 'cmakelists.txt'].includes(lower)) return { changed: false, reason: 'no-comment-style' }
      }
      const content = readFileSync(absPath, 'utf8')
      const result = markText(content, absPath, new Date().toISOString())
      if (!result.changed) return result
      writeFileSync(absPath, result.content, 'utf8')
      return result
    } catch (error) {
      log('warn', `mark failed for ${absPath}: ${error?.message ?? error}`)
      return { changed: false, reason: 'error' }
    }
  }

  function recordOrigin(absPath, toolName) {
    try {
      if (!existsSync(absPath)) return
      const st = statSync(absPath)
      if (!st.isFile()) return
      const bytes = readFileSync(absPath)
      let marked = false
      try {
        marked = alreadyMarked(bytes.toString('utf8'))
      } catch {
        marked = false
      }
      state.origins.files[absPath] = {
        origin: 'dsh',
        sha256: sha256(bytes),
        at: new Date().toISOString(),
        tool: toolName,
        size: st.size,
        marked,
      }
      saveOrigins()
    } catch (error) {
      log('warn', `origin record failed for ${absPath}: ${error?.message ?? error}`)
    }
  }

  function buildOriginTool() {
    const definition = {
      name: 'dsh_file_origin',
      description:
        'Report whether a file was generated by DSH (registered in the origin registry and/or carrying the [DSH-GENERATED] footer marker) or originated elsewhere, such as a file the user downloaded.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path to check; absolute, or relative to the session workspace.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            origin: { type: 'string', enum: ['dsh', 'unknown'] },
            marked: { type: 'boolean' },
            registered: { type: 'boolean' },
            sha256: { type: 'string' },
            authoredAt: { type: 'string' },
            tool: { type: 'string' },
          },
          required: ['path', 'origin', 'marked', 'registered'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: renderOrigin(value) }],
      },
      async execute(args, exec) {
        const absPath = resolveAbsPath(args.path, cwdOf(sessionOf(exec)))
        if (absPath === undefined) throw new Error('path is required')
        const record = state.origins.files[absPath]
        let marked = false
        try {
          if (existsSync(absPath)) marked = alreadyMarked(readFileSync(absPath, 'utf8'))
        } catch {
          marked = false
        }
        const result = {
          path: absPath,
          origin: record ? 'dsh' : 'unknown',
          marked,
          registered: record !== undefined,
        }
        if (record?.sha256 !== undefined) result.sha256 = record.sha256
        if (record?.at !== undefined) result.authoredAt = record.at
        if (record?.tool !== undefined) result.tool = record.tool
        return result
      },
    }
    return definition
  }

  function install() {
    const disposers = []

    // Back up an old file before any file-tool mutation; gate destructive
    // shell commands on a workspace snapshot in confined-mode terms.
    if (typeof ctx?.on === 'function') {
      disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          const session = sessionOf(exec)
          const mode = modeOf(session)
          if (shouldBackup(mode)) {
            const raw = mutationPath(exec.name, exec.arguments)
            if (raw !== undefined) {
              const absPath = resolveAbsPath(raw, cwdOf(session))
              if (absPath !== undefined) backupExisting(absPath, 'modify', session)
            }
            if (
              cfg.snapshotBeforeShellDelete &&
              (exec.name === 'bash' || exec.name === 'pwsh') &&
              isDestructiveCommand(exec.arguments?.command)
            ) {
              const snap = snapshotWorkspace(session)
              if (!snap.ok && snap.reason !== 'missing-workspace' && snap.reason !== 'overlap-skipped') {
                return {
                  kind: 'deny',
                  reason:
                    `dsh-safety-guard: refusing a destructive shell command in ${mode} because the workspace ` +
                    `could not be snapshotted (${snap.reason}). Back up the target to ${backupRoot} explicitly, ` +
                    `or raise maxSnapshotBytes / disable snapshotBeforeShellDelete in the plugin config.`,
                }
              }
            }
          }
        } catch (error) {
          log('warn', `pre-execute failed: ${error?.message ?? error}`)
        }
        return next()
      }))

      // Mark the produced file and record its DSH origin after a successful call.
      disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
        try {
          if (result?.isError !== true) {
            const session = sessionOf(exec)
            const raw = mutationPath(exec.name, exec.arguments)
            if (raw !== undefined) {
              const absPath = resolveAbsPath(raw, cwdOf(session))
              if (absPath !== undefined) {
                markTarget(absPath)
                recordOrigin(absPath, exec.name)
              }
            }
          }
        } catch (error) {
          log('warn', `post-execute failed: ${error?.message ?? error}`)
        }
        return next()
      }))
    }

    if (ctx?.tools && typeof ctx.tools.register === 'function') {
      try {
        disposers.push(ctx.tools.register(buildOriginTool()))
      } catch (error) {
        log('warn', `cannot register dsh_file_origin: ${error?.message ?? error}`)
      }
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // disposal is best-effort
        }
      }
    }
  }

  return { config: cfg, state, install, backupExisting, markTarget, recordOrigin, snapshotWorkspace }
}
