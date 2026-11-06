/**
 * Standalone simulation of dsh-safety-guard.
 *
 * The plugin only imports Node built-ins, so this script exercises the real
 * `createGuard()` wiring against a mock Cordis context: no Harness needed.
 *
 *   node test/simulate.js
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGuard } from '../lib/wiring.js'
import { isDestructiveCommand, markText, mutationPath } from '../lib/core.js'

const root = join(tmpdir(), `dsh-safety-guard-test-${Date.now()}`)
const workspace = join(root, 'ws')
const backupRoot = join(root, 'backup')
mkdirSync(workspace, { recursive: true })

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}: ${error?.message ?? error}`)
  }
}

function mockCtx(mode = 'danger-full-access') {
  const listeners = new Map()
  const registered = []
  return {
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    _listeners: listeners,
    _registered: registered,
  }
}

function execFor(name, args, cwd) {
  return { name, arguments: args, agent: { session: { header: { cwd } } } }
}

async function runPre(ctx, exec) {
  const list = ctx._listeners.get('tools/pre-execute') ?? []
  assert.ok(list.length > 0, 'pre-execute listener registered')
  // The harness chains listeners; with one listener `next()` is the allow fallback.
  return await list[0](exec, async () => ({ kind: 'allow' }))
}

async function runPost(ctx, exec, result) {
  const list = ctx._listeners.get('tools/post-execute') ?? []
  assert.ok(list.length > 0, 'post-execute listener registered')
  return await list[0](exec, result, async () => ({ kind: 'accept' }))
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

await check('mutationPath extracts write/edit/str_replace_editor', () => {
  assert.equal(mutationPath('write', { file_path: 'a.js', content: 'x' }), 'a.js')
  assert.equal(mutationPath('edit', { file_path: 'b.js', old_string: 'x', new_string: 'y' }), 'b.js')
  assert.equal(mutationPath('str_replace_editor', { command: 'create', path: 'c.py' }), 'c.py')
  assert.equal(mutationPath('str_replace_editor', { command: 'view', path: 'c.py' }), undefined)
  assert.equal(mutationPath('read', { file_path: 'd.js' }), undefined)
  assert.equal(mutationPath('write', { file_path: '', content: 'x' }), undefined)
})

await check('markText uses the right comment syntax per extension', () => {
  const py = markText('print(1)\n', 'x.py', '2026-01-01T00:00:00.000Z')
  assert.equal(py.changed, true)
  assert.match(py.content, /^print\(1\)\n# \[DSH-GENERATED\]/m)
  const js = markText('const a = 1', 'x.js', '2026-01-01T00:00:00.000Z')
  assert.match(js.content, /\/\/ \[DSH-GENERATED\]/)
  const md = markText('# title\n', 'x.md', '2026-01-01T00:00:00.000Z')
  assert.match(md.content, /<!-- \[DSH-GENERATED\].* -->/)
  const css = markText('a{}', 'x.css', '2026-01-01T00:00:00.000Z')
  assert.match(css.content, /\/\* \[DSH-GENERATED\].* \*\//)
})

await check('markText skips JSON and binary-like content', () => {
  assert.equal(markText('{"a":1}', 'x.json', '2026-01-01T00:00:00.000Z').changed, false)
  assert.equal(markText('a\u0000b', 'x.js', '2026-01-01T00:00:00.000Z').changed, false)
})

await check('markText is idempotent', () => {
  const first = markText('x\n', 'x.py', '2026-01-01T00:00:00.000Z')
  const second = markText(first.content, 'x.py', '2026-01-02T00:00:00.000Z')
  assert.equal(second.changed, false)
  assert.equal(second.content, first.content)
})

await check('isDestructiveCommand recognizes deletes only', () => {
  assert.equal(isDestructiveCommand('Remove-Item .\\x.txt'), true)
  assert.equal(isDestructiveCommand('rm -rf build'), true)
  assert.equal(isDestructiveCommand('del x.txt'), true)
  assert.equal(isDestructiveCommand('Get-ChildItem'), false)
  assert.equal(isDestructiveCommand('echo hello'), false)
})

// ---------------------------------------------------------------------------
// modify backup + marker + registry + origin tool (danger-full-access)
// ---------------------------------------------------------------------------

await check('danger-full-access: modifies back up, mark, register, and answer origin', async () => {
  writeFileSync(join(workspace, 'a.js'), 'const a = 1\n')
  const ctx = mockCtx('danger-full-access')
  const guard = createGuard(ctx, { backupRoot, backupInModes: ['danger-full-access'] })
  guard.install()

  const writeExec = execFor('write', { file_path: 'a.js', content: 'const a = 2\n' }, workspace)
  const pre = await runPre(ctx, writeExec)
  assert.deepEqual(pre, { kind: 'allow' })

  const backupDir = join(backupRoot, 'files')
  assert.ok(existsSync(backupDir), 'backup dir exists')

  function collectFiles(dir) {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...collectFiles(p))
      else out.push(p)
    }
    return out
  }
  const filesInDay = collectFiles(backupDir)
  assert.ok(filesInDay.some((f) => f.endsWith('.bak')), 'a .bak file was created')

  // Simulate the write body landing on disk, then post-execute marks + records.
  writeFileSync(join(workspace, 'a.js'), 'const a = 2\n')
  const post = await runPost(ctx, writeExec, { isError: false })
  assert.deepEqual(post, { kind: 'accept' })

  const marked = readFileSync(join(workspace, 'a.js'), 'utf8')
  assert.match(marked, /\[DSH-GENERATED\]/)
  assert.ok(existsSync(join(backupRoot, 'origin.json')), 'origin registry written')

  const tool = ctx._registered[0]
  assert.equal(tool.name, 'dsh_file_origin')
  const origin = await tool.execute({ path: 'a.js' }, writeExec)
  assert.equal(origin.origin, 'dsh')
  assert.equal(origin.registered, true)
  assert.equal(origin.marked, true)
})

// ---------------------------------------------------------------------------
// mode gating: no backup outside the configured modes
// ---------------------------------------------------------------------------

await check('workspace-write: no backup outside configured modes', async () => {
  const ws2 = join(root, 'ws2')
  mkdirSync(ws2, { recursive: true })
  writeFileSync(join(ws2, 'b.js'), 'b\n')
  const ctx = mockCtx('workspace-write')
  const guard = createGuard(ctx, { backupRoot: join(root, 'backup2'), backupInModes: ['danger-full-access'] })
  guard.install()
  await runPre(ctx, execFor('write', { file_path: 'b.js', content: 'b2\n' }, ws2))
  const backupDir = join(root, 'backup2', 'files')
  assert.equal(existsSync(backupDir), false, 'no backup directory created outside mode')
})

// ---------------------------------------------------------------------------
// destructive shell command snapshot
// ---------------------------------------------------------------------------

await check('danger-full-access: destructive shell command snapshots the workspace', async () => {
  const ws3 = join(root, 'ws3')
  mkdirSync(ws3, { recursive: true })
  writeFileSync(join(ws3, 'keep.txt'), 'keep me\n')
  const ctx = mockCtx('danger-full-access')
  const guard = createGuard(ctx, { backupRoot: join(root, 'backup3'), backupInModes: ['danger-full-access'] })
  guard.install()
  const decision = await runPre(ctx, execFor('pwsh', { command: 'Remove-Item .\\keep.txt' }, ws3))
  assert.deepEqual(decision, { kind: 'allow' })
  const snapDir = join(root, 'backup3', 'snap')
  assert.ok(existsSync(snapDir), 'snapshot dir exists')
  const snaps = readdirSync(snapDir)
  assert.ok(snaps.length > 0, 'a snapshot was taken')
})

await check('non-destructive shell command does not snapshot', async () => {
  const ws4 = join(root, 'ws4')
  mkdirSync(ws4, { recursive: true })
  const ctx = mockCtx('danger-full-access')
  const guard = createGuard(ctx, { backupRoot: join(root, 'backup4'), backupInModes: ['danger-full-access'] })
  guard.install()
  await runPre(ctx, execFor('pwsh', { command: 'Get-ChildItem' }, ws4))
  assert.equal(existsSync(join(root, 'backup4', 'snap')), false)
})

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // temp cleanup is best-effort
}
process.exitCode = failed === 0 ? 0 : 1
