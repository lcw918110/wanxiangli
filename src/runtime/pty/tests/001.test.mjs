import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '../../../../dist/runtime/Runtime.js'

const base = { driver: () => { throw new Error('not reached') }, command: 'true', cwd: tmpdir(), cols: 80, rows: 24 }

test('SPEC[pty-001] invalid options are rejected before the driver is called', () => {
  let called = 0
  const driver = () => { called++; return null }
  const bad = [
    null, {}, { ...base, extra: 1 }, { ...base, driver: 'spawn' }, { ...base, command: '' },
    { ...base, command: 'a\0b' }, { ...base, command: '\uD800' }, { ...base, cwd: 'relative' },
    { ...base, cols: 0 }, { ...base, rows: 1001 }, { ...base, cols: 1.5 },
  ]
  for (const options of bad) {
    assert.throws(() => Terminal.open(options && { ...options, driver: options.driver === base.driver ? driver : options.driver }))
  }
  assert.equal(called, 0)
  assert.throws(() => Terminal())
})

test('SPEC[pty-001] a missing or non-directory cwd fails before spawning', t => {
  const directory = mkdtempSync(join(tmpdir(), 'wanxiangli-pty-cwd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'file')
  writeFileSync(filePath, '')
  let called = 0
  const driver = () => { called++ }
  const missing = Terminal.open({ ...base, driver, cwd: join(directory, 'missing') })
  assert.equal(missing.kind, 'Failed')
  assert.equal(missing.error.operation, 'cwd')
  assert.equal(missing.error.code, 'ENOENT')
  const file = Terminal.open({ ...base, driver, cwd: filePath })
  assert.equal(file.kind, 'Failed')
  assert.equal(file.error.code, 'ENOTDIR')
  assert.equal(called, 0)
})

test('SPEC[pty-001] a driver that throws or returns no live terminal is reported as a spawn failure', () => {
  const thrown = Terminal.open({ ...base, driver: () => { const e = new Error('no pty'); e.code = 'EAGAIN'; throw e } })
  assert.deepEqual(thrown, { kind: 'Failed', error: { operation: 'spawn', message: 'no pty', code: 'EAGAIN' } })
  const empty = Terminal.open({ ...base, driver: () => ({ pid: 0 }) })
  assert.equal(empty.kind, 'Failed')
  assert.equal(empty.error.operation, 'spawn')
})

test('SPEC[pty-001] the driver receives sh -lc and the declared geometry', () => {
  let seen
  const driver = (file, args, options) => { seen = { file, args, options }; throw new Error('stop') }
  Terminal.open({ ...base, driver, command: 'echo hi', cols: 120, rows: 40 })
  assert.deepEqual(seen, { file: 'sh', args: ['-lc', 'echo hi'], options: { name: 'xterm-256color', cols: 120, rows: 40, cwd: tmpdir() } })
})
