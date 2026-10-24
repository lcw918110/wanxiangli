import test from 'node:test'
import assert from 'node:assert/strict'
import { Rig } from './support.mjs'

test('SPEC[assembly-002] NotWritten discards the candidate without a half-retired durable work', t => {
  const rig = new Rig(t)
  rig.open()
  rig.review()
  const before = rig.work.inspect()
  const command = rig.delivery()
  const append = rig.journal.append.bind(rig.journal)
  rig.journal.append = () => ({ status: 'NotWritten', revision: 2, reason: 'Known rejection' })
  const result = rig.call(command)
  assert.equal(result.status, 'NotWritten')
  assert.equal(result.result, null)
  rig.journal.append = append
  assert.deepEqual(rig.work.inspect(), before)
  assert.equal(rig.commit(command).kind, 'Promoted')
})

for (const afterWrite of [false, true]) {
  test(`SPEC[assembly-002] lost acknowledgement ${afterWrite ? 'after' : 'before'} commit freezes only the composition`, t => {
    const rig = new Rig(t)
    rig.authorize()
    const command = rig.delivery({ draft: { digest: 'draft', path: '/plan' } })
    const append = rig.journal.append.bind(rig.journal)
    rig.journal.append = (...args) => {
      if (afterWrite) append(...args)
      throw new Error('Lost acknowledgement')
    }
    const reply = rig.call(command, 'reserve')
    assert.equal(reply.status, 'Unknown')
    assert.equal(reply.result, null)
    assert.equal(rig.work.recover().next, 'ObserveCommit')
    assert.throws(() => rig.work.inspect(), /unknown/)
    assert.throws(() => rig.call(command, 'retry'), /unknown/)
    const restored = rig.reopen()
    assert.equal(restored.recover().next, afterWrite ? 'ObserveExecution' : 'Continue')
    if (afterWrite) assert.equal(restored.execute('reserve', command).result.kind, 'ObserveExecution')
  })
}

for (const sameRequest of [false, true]) {
  test(`SPEC[assembly-001] interleaved ${sameRequest ? 'same' : 'different'} requests have only one commit winner`, t => {
    const rig = new Rig(t)
    rig.authorize()
    const other = rig.reopen()
    const command = rig.delivery({ draft: { digest: 'draft', path: '/plan' } })
    const append = rig.journal.append.bind(rig.journal)
    let winner
    rig.journal.append = (...args) => {
      winner = other.execute(sameRequest ? 'reserve' : 'other', sameRequest ? command : { ...command, toolCallId: 'other' })
      return append(...args)
    }
    const loser = rig.call(command, 'reserve')
    assert.equal(winner.status, 'Committed')
    assert.equal(winner.result.kind, 'DeliveryRequested')
    assert.equal(loser.status, sameRequest ? 'Replayed' : 'Conflict')
    if (sameRequest) assert.equal(loser.result.kind, 'ObserveExecution')
    else assert.equal(loser.result, null)
    assert.equal(rig.work.inspect().pendingDelivery.operationId, winner.result.operationId)
  })
}

for (const acknowledgement of [null, {}, { status: 'Committed', revision: -1, reason: null }, { status: 12, revision: 1, reason: null }, { status: 'Committed', revision: 999, reason: null }]) {
  test(`SPEC[assembly-002] malformed acknowledgement ${JSON.stringify(acknowledgement)} never publishes the candidate`, t => {
    const rig = new Rig(t)
    rig.open()
    const command = { type: 'Review', incumbencyId: rig.work.inspect().active.id, reviewerId: 'reviewer', updates: [] }
    const append = rig.journal.append.bind(rig.journal)
    rig.journal.append = (...args) => { append(...args); return acknowledgement }
    const reply = rig.call(command)
    assert.equal(reply.status, 'Unknown')
    assert.equal(reply.result, null)
    assert.equal(rig.work.recover().next, 'ObserveCommit')
    assert.equal(rig.reopen().inspect().stage, 'S1')
    assert.equal(rig.reopen().inspect().active.reviewOutcome, 'Promoted')
  })
}

test('SPEC[assembly-002] a false replay acknowledgement cannot substitute another record', t => {
  const rig = new Rig(t)
  rig.open()
  rig.journal.append = () => ({ status: 'Replayed', revision: 1, reason: null })
  const reply = rig.call({ type: 'Review', incumbencyId: rig.work.inspect().active.id, reviewerId: 'reviewer', updates: [] })
  assert.equal(reply.status, 'Unknown')
  assert.equal(reply.result, null)
  assert.equal(rig.reopen().inspect().active.reviewOutcome, null)
})

test('SPEC[assembly-002] valid storage bytes with invalid domain history are rejected without repair', t => {
  const rig = new Rig(t)
  rig.open()
  const body = JSON.stringify({ events: [{ type: 'UnknownEvent' }], requestHash: '0'.repeat(64), requestId: 'foreign' })
  assert.equal(rig.journal.append('work-a', 1, 'foreign', body).status, 'Committed')
  assert.throws(() => rig.work.inspect(), /Unknown/)
  assert.throws(() => rig.call({ type: 'Review' }), /Unknown/)
  assert.equal(rig.journal.read('work-a').length, 2)
})

test('SPEC[assembly-003] a synchronous append callback cannot reenter the same composition', t => {
  const rig = new Rig(t)
  rig.open()
  const command = { type: 'Review', incumbencyId: rig.work.inspect().active.id, reviewerId: 'reviewer', updates: [] }
  const append = rig.journal.append.bind(rig.journal)
  rig.journal.append = (...args) => {
    assert.throws(() => rig.call(command, 'nested'), /reentrant/)
    assert.throws(() => rig.work.inspect(), /reentrant/)
    assert.throws(() => rig.work.recover(), /reentrant/)
    return append(...args)
  }
  assert.equal(rig.call(command, 'outer').status, 'Committed')
  assert.equal(rig.work.inspect().stage, 'S1')
  assert.equal(rig.work.inspect().active.reviewOutcome, 'Promoted')
})

test('SPEC[assembly-003] request mutation during a race does not change the correlated replay', t => {
  const rig = new Rig(t)
  rig.authorize()
  const command = rig.delivery({ draft: { digest: 'draft', path: '/plan' } })
  const other = rig.reopen()
  const append = rig.journal.append.bind(rig.journal)
  rig.journal.append = (...args) => {
    assert.equal(other.execute('reserve', command).status, 'Committed')
    command.draft.path = '/changed-by-callback'
    return append(...args)
  }
  const reply = rig.call(command, 'reserve')
  assert.equal(reply.status, 'Replayed')
  assert.equal(reply.result.path, '/plan')
})
