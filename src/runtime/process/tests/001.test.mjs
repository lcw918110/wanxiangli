import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { ProcessSession } from 'wanxiangli/runtime'
import { options, session, ready, closed, output, temporary } from './support.mjs'

const baselineEnv = JSON.parse(childProcess.execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env: {}, encoding: 'utf8' }))

function noSpawn(action) {
  const original = childProcess.spawn
  let calls = 0
  childProcess.spawn = (...args) => { calls++; return original(...args) }
  syncBuiltinESMExports()
  try { assert.throws(action); assert.equal(calls, 0) }
  finally { childProcess.spawn = original; syncBuiltinESMExports() }
}

test('SPEC[process-001] direct argv, explicit cwd and environment reach a real process unchanged', async t => {
  const cwd = temporary(t)
  const args = ['hello world', ';touch never', '$(not-a-command)', '', '用户🧭']
  const run = session(t, 'report', args, { cwd, env: { ONLY_THIS: '确切值' } })
  await ready(run)
  const state = await closed(run)
  assert.deepEqual(state.exit, { code: 0, signal: null })
  assert.equal(state.failure, null)
  const report = JSON.parse(output(run).text)
  assert.deepEqual(report.args, args)
  assert.equal(report.cwd, realpathSync(cwd))
  assert.deepEqual(report.env, { ...baselineEnv, ONLY_THIS: '确切值' })
  assert.equal(output(run, 'stderr').text, 'diagnostic\n')
})

test('SPEC[process-001] nonzero exit remains a real exit, not a spawn failure', async t => {
  const run = session(t, 'exit', ['19'])
  await ready(run)
  assert.deepEqual((await closed(run)).exit, { code: 19, signal: null })
  assert.equal(run.inspect().failure, null)
})

test('SPEC[process-001] environment property names are literal data, not prototype mutation', async t => {
  const env = Object.fromEntries([['__proto__', 'literal-value'], ['constructor', 'another-value'], ['EMPTY', '']])
  const run = session(t, 'report', [], { env })
  await closed(run)
  assert.deepEqual(JSON.parse(output(run).text).env, { ...baselineEnv, ...env })
})

test('SPEC[process-001] absent executable produces one failed start and no invented zero exit', async t => {
  const run = session(t, 'report', [], { executable: path.join(temporary(t), 'missing') })
  const start = await run.started()
  assert.equal(start.kind, 'Failed')
  assert.equal(start.error.code, 'ENOENT')
  assert.deepEqual(await run.started(), start)
  const state = await closed(run)
  assert.equal(state.exit, null)
  assert.equal(state.phase, 'Closed')
  assert.equal(run.signal('SIGKILL').kind, 'NotRunning')
})

const invalid = [
  ['relative executable', { executable: 'node' }],
  ['relative cwd', { cwd: '.' }],
  ['NUL argument', { args: ['a\0b'] }],
  ['bad Unicode argument', { args: ['\ud800'] }],
  ['negative capacity', { tailBytes: -1 }],
  ['fractional capacity', { tailBytes: 0.5 }],
  ['NaN capacity', { tailBytes: NaN }],
  ['unbounded capacity', { tailBytes: Infinity }],
  ['excessive capacity', { tailBytes: 16777217 }],
  ['zero write capacity', { maxWriteBytes: 0 }],
  ['fractional write capacity', { maxWriteBytes: 0.5 }],
  ['undefined env value', { env: { A: undefined } }],
  ['bad env key', { env: { 'A=B': 'value' } }],
  ['hidden shell option', { shell: true }],
  ['argument hole', { args: Array(1) }],
]
for (const [label, change] of invalid) {
  test(`SPEC[process-001] ${label} is refused before external effect`, t => {
    const effect = path.join(temporary(t), 'effect')
    noSpawn(() => new ProcessSession(options('stamp', [effect], change)))
    assert.equal(existsSync(effect), false)
  })
}

test('SPEC[process-001] accessors are rejected without evaluating them', t => {
  const effect = path.join(temporary(t), 'effect')
  const input = options('stamp', [effect])
  let reads = 0
  Object.defineProperty(input, 'tailBytes', { get() { reads++; return 64 } })
  noSpawn(() => new ProcessSession(input))
  assert.equal(reads, 0)
  assert.equal(existsSync(effect), false)
})
