import test from 'node:test'
import assert from 'node:assert/strict'
import { Work } from 'wanxiangli/work'
import { DurableWork } from 'wanxiangli/durable-work'
import { Rig } from './support.mjs'

test('SPEC[assembly-001] a real composition commits complete domain records and restores them', t => {
  const rig = new Rig(t)
  rig.authorize()
  const before = rig.journal.read('work-a')
  const restored = rig.reopen()
  assert.equal(restored.inspect().deliveryAuthorized, true)
  assert.deepEqual(restored.inspect(), rig.work.inspect())
  assert.deepEqual(restored.records(), before)
  assert.deepEqual(new Work('work-a', before).inspect(), restored.inspect())
  assert.deepEqual(rig.journal.read('work-a'), before)
})

test('SPEC[assembly-001] local-first recording and durable-first publication use unchanged Work and Journal', t => {
  const rig = new Rig(t, ['S4'])
  const local = new Work('work-a')
  const commands = [
    ['open', { type: 'Open', root: '组合验收', sequence: ['S4'], ownerId: 'manager', openingCursor: 0 }],
  ]
  const first = local.execute(...commands[0]).result.incumbencyId
  commands.push(
    ['review', { type: 'Review', incumbencyId: first, reviewerId: 'reviewer', updates: [] }],
    ['finish', { type: 'Deliver', incumbencyId: first, providerRunId: 'run', toolCallId: 'finish', cursor: 6, blockers: [] }],
  )
  for (const request of commands.slice(1)) assert.equal(local.execute(...request).status, 'Applied')
  assert.deepEqual(rig.journal.read('work-a'), [])
  assert.equal(local.recover().next, 'Done')

  // 离线记录的导入者选择先完成本地工作，再逐笔存档，不让 Work 调用存储。
  for (const [index, body] of local.records().entries()) {
    assert.equal(rig.journal.append('work-a', index, JSON.parse(body).requestId, body).status, 'Committed')
  }
  assert.deepEqual(rig.work.inspect(), local.inspect())
  const live = new DurableWork('live', rig.journal)
  const liveFirst = live.execute('open', commands[0][1]).result.incumbencyId
  for (const [id, command] of commands.slice(1)) {
    const reply = live.execute(id, { ...command, incumbencyId: liveFirst })
    assert.equal(reply.status, 'Committed')
  }
  assert.equal(live.recover().next, 'Done')
  assert.deepEqual(live.history().map(frame => frame.events.map(event => event.type)), local.history().map(frame => frame.events.map(event => event.type)))
})

test('SPEC[assembly-001] only a fresh durable reservation can be used by an external executor', t => {
  const rig = new Rig(t)
  rig.authorize()
  const command = rig.delivery({ draft: { digest: 'draft', path: '/plan' } })
  const first = rig.call(command, 'reserve')
  assert.equal(first.status, 'Committed')
  assert.equal(first.result.kind, 'DeliveryRequested')
  const operationId = first.result.operationId
  const again = rig.reopen().execute('reserve', command)
  assert.equal(again.status, 'Replayed')
  assert.equal(again.result.kind, 'ObserveExecution')
  assert.equal(again.result.operationId, operationId)
  const bound = { type: 'ResolveDelivery', operationId, outcome: 'SessionCreated', execSessionId: 'real-observed-session' }
  assert.equal(rig.commit(bound, 'bind-session').kind, 'ExecutionSessionBound')
  assert.equal(rig.reopen().execute('reserve', command).result.execSessionId, 'real-observed-session')
  const accepted = { type: 'ResolveDelivery', operationId, outcome: 'Accepted', execSessionId: 'real-observed-session', digest: 'draft', path: '/plan', blockers: [] }
  assert.equal(rig.commit(accepted, 'accepted').kind, 'Delivered')
  assert.equal(rig.work.execute('accepted', accepted).status, 'Replayed')
  assert.equal(rig.reopen().recover().next, 'Done')
})

test('SPEC[assembly-001] malformed domain messages cause no physical append', t => {
  const rig = new Rig(t)
  const before = rig.journal.read('work-a')
  assert.throws(() => rig.call({ type: 'Open', root: 'root', sequence: ['S4'], ownerId: 'manager', openingCursor: Infinity }))
  assert.throws(() => rig.call({ type: 'unknown' }))
  assert.deepEqual(rig.journal.read('work-a'), before)
  rig.open()
})
