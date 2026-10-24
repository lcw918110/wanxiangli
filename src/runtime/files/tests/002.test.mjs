import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { workspace, fs, write } from './support.mjs'

function gitRoot(t) {
  const root = workspace(t)
  mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  return root
}

test('SPEC[fs-002] glob respects nested .gitignore rules and negation', async t => {
  const root = gitRoot(t)
  write(root, 'keep.txt', 'x')
  write(root, 'drop.log', 'x')
  write(root, 'src/keep.ts', 'x')
  write(root, 'src/drop.tmp', 'x')
  write(root, 'src/.gitignore', '*.tmp\n')
  const result = await fs(root).glob('**/*')
  assert.equal(result.ok, true)
  // 主仓既有语义：.git 永不进入结果；drop.log 无任何忽略规则，保留。
  assert.deepEqual(result.value.paths, ['drop.log', 'keep.txt', 'src/.gitignore', 'src/keep.ts'])
})

test('SPEC[fs-002] git info exclude participates at the root only', async t => {
  const root = gitRoot(t)
  writeFileSync(path.join(root, '.git/info/exclude'), '*.log\n')
  write(root, 'a.log', 'x')
  write(root, 'b.txt', 'x')
  const result = await fs(root).glob('**/*')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.paths, ['b.txt'])
})

test('SPEC[fs-002] symlinks are not followed and .git is never entered', async t => {
  const root = gitRoot(t)
  write(root, '.git/internal.txt', 'x')
  write(root, 'real.txt', 'x')
  symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'))
  const result = await fs(root).glob('**/*')
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.paths, ['real.txt'])
})

test('SPEC[fs-002] slash-less patterns match at any depth, double-star crosses directories', async t => {
  const root = gitRoot(t)
  write(root, 'top.md', 'x')
  write(root, 'a/nested.md', 'x')
  write(root, 'a/b/deep.md', 'x')
  const api = fs(root)
  // 主仓既有 wildmatch 语义：不含 `/` 的模式按 gitignore 惯例任意深度匹配。
  const single = await api.glob('*.md')
  assert.deepEqual(single.value.paths, ['a/b/deep.md', 'a/nested.md', 'top.md'])
  const deep = await api.glob('a/**/*.md')
  assert.deepEqual(deep.value.paths, ['a/b/deep.md', 'a/nested.md'])
  const segment = await api.glob('a/*.md')
  assert.deepEqual(segment.value.paths, ['a/nested.md'])
})

test('SPEC[fs-002] brace alternation expands top-level commas', async t => {
  const root = gitRoot(t)
  write(root, 'one.txt', 'x')
  write(root, 'two.md', 'x')
  const result = await fs(root).glob('{one.txt,two.md}')
  assert.deepEqual(result.value.paths, ['one.txt', 'two.md'])
})

test('SPEC[fs-002] directory-only ignore rules do not hide plain files of the same shape', async t => {
  const root = gitRoot(t)
  write(root, 'build/out.js', 'x')
  write(root, 'build.txt', 'x')
  write(root, '.gitignore', 'build/\n')
  const result = await fs(root).glob('**/*')
  assert.deepEqual(result.value.paths, ['.gitignore', 'build.txt'])
})

test('SPEC[fs-002] empty pattern is refused with the stable invalid-pattern code', async t => {
  const root = gitRoot(t)
  const result = await fs(root).glob('')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INVALID_ANCHOR_PATTERN')
})

test('SPEC[fs-002] 符号链接根目录内的枚举合法，根外符号链接仍拒绝', t => {
  const container = workspace(t)
  const target = path.join(container, 'target')
  const alias = path.join(container, 'alias')
  mkdirSync(target)
  symlinkSync(target, alias, 'dir')
  write(target, 'keep.txt', 'x')
  const api = fs(alias)
  const listed = api.visibleEntries('.')
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.deepEqual(listed.entries, [{ name: 'keep.txt', isDir: false }])
  const outside = path.join(container, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, path.join(target, 'escape'), 'dir')
  assert.equal(api.visibleEntries('escape').code, 'PATH_DENIED')
  assert.equal(api.visibleEntries('../outside').code, 'PATH_DENIED')
})

test('SPEC[fs-002] visibleEntries lists one directory sorted with isDir, respecting .gitignore, negation, nested rules, and .git/info/exclude', t => {
  const root = gitRoot(t)
  writeFileSync(path.join(root, '.git/info/exclude'), 'excluded.txt\n')
  write(root, '.gitignore', '*.log\n!keep.log\nignored-dir/\n')
  write(root, 'a.txt', 'x')
  write(root, 'drop.log', 'x')
  write(root, 'keep.log', 'x')
  write(root, 'excluded.txt', 'x')
  write(root, 'ignored-dir/file.txt', 'x')
  write(root, 'src/.gitignore', '*.tmp\n!important.tmp\n')
  write(root, 'src/index.ts', 'x')
  write(root, 'src/scratch.tmp', 'x')
  write(root, 'src/important.tmp', 'x')
  write(root, 'src/nested/deep.txt', 'x')
  symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'))

  const api = fs(root)

  const top = api.visibleEntries(root, '.')
  assert.equal(top.ok, true)
  assert.deepEqual(top.entries, [
    { name: '.gitignore', isDir: false },
    { name: 'a.txt', isDir: false },
    { name: 'keep.log', isDir: false },
    { name: 'src', isDir: true },
  ])
  assert.deepEqual(top.value.entries, top.entries)
  assert.deepEqual(api.visibleEntries('.').entries, top.entries)

  const sub = api.visibleEntries(root, 'src')
  assert.equal(sub.ok, true)
  assert.deepEqual(sub.entries, [
    { name: '.gitignore', isDir: false },
    { name: 'important.tmp', isDir: false },
    { name: 'index.ts', isDir: false },
    { name: 'nested', isDir: true },
  ])

  const missing = api.visibleEntries(root, 'no-such-dir')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'FILE_NOT_FOUND')

  const escaped = api.visibleEntries(root, '../outside')
  assert.equal(escaped.ok, false)
  assert.equal(escaped.code, 'PATH_DENIED')
})
