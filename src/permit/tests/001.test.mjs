import test from 'node:test'
import assert from 'node:assert/strict'

import { ExecutionPermits } from 'wanxiangli/permit'

const identity = (fields = {}) => ({
  sessionId: 'ses-a',
  physicalUserMessageId: 'msg-1',
  role: 'engineer',
  participant: 'alice',
  target: { model: 'provider/model', reasoning: 'none' },
  ...fields,
})

const fresh = (fields, credit = 1) => {
  const permits = new ExecutionPermits()
  const permit = permits.issue(identity(fields), credit)
  return { permits, permit }
}

test('SPEC[permit-1] a repeated issue with the same identity and credit returns the same permit', () => {
  const { permits, permit } = fresh()
  assert.ok(Object.isFrozen(permit))
  assert.ok(Object.isFrozen(permit.identity))
  assert.equal(permits.issue(identity(), 1), permit)
  assert.equal(permits.commit(permit, permit.fence, identity()), 'Applied')
  assert.equal(permits.issue(identity(), 1), permit, 'any state, including committed')
})

test('SPEC[permit-1] a changed identity or credit issues a new permit and the old one becomes stale', () => {
  const { permits, permit } = fresh()
  const other = permits.issue(identity({ physicalUserMessageId: 'msg-2' }), 1)
  assert.notEqual(other, permit)
  assert.ok(other.leaseId > permit.leaseId && other.fence > permit.fence)
  assert.equal(permits.commit(permit, permit.fence, identity()), 'StaleFence')
  assert.equal(permits.releasePhysical('ses-a', 'msg-1'), 'StaleFence', 'the old physical no longer releases anything')
  const recredited = permits.issue(identity({ physicalUserMessageId: 'msg-2' }), 2)
  assert.notEqual(recredited, other)
  assert.equal(permits.lifecycle(other, other.fence).rejection, 'StaleLease')
})

test('SPEC[permit-1] sessions are independent', () => {
  const permits = new ExecutionPermits()
  const a = permits.issue(identity(), 1)
  const b = permits.issue(identity({ sessionId: 'ses-b' }), 2)
  assert.equal(permits.commit(a, a.fence, identity()), 'Applied')
  assert.equal(permits.releaseBeforeProvider(b, b.fence, identity({ sessionId: 'ses-b' })), 'Applied')
  assert.deepEqual(permits.lifecycle(a, a.fence), { ok: true, value: 'Committed' })
  assert.deepEqual(permits.lifecycle(b, b.fence), { ok: true, value: 'Released' })
})

test('SPEC[permit-2] counterexample: forged, foreign, null and wrong-fence permits are refused without effect', () => {
  const { permits, permit } = fresh()
  const forged = Object.freeze({ ...permit })
  const foreign = new ExecutionPermits().issue(identity(), 1)
  assert.equal(permits.commit(forged, permit.fence, identity()), 'StaleFence')
  assert.equal(permits.target(forged, permit.fence).rejection, 'WrongFence')
  assert.equal(permits.commit(foreign, foreign.fence, identity()), 'StaleFence')
  assert.equal(permits.target(null, 1).rejection, 'UnknownLease')
  assert.equal(permits.commit(null, 1, identity()), 'StaleFence')
  assert.equal(permits.target(permit, permit.fence + 1).rejection, 'WrongFence')
  assert.equal(permits.releaseBeforeProvider(permit, permit.fence + 1, identity()), 'StaleFence')
  assert.deepEqual(permits.lifecycle(permit, permit.fence), { ok: true, value: 'Pending' }, 'no state changed')
  assert.deepEqual(permits.target(permit, permit.fence), { ok: true, value: { model: 'provider/model', reasoning: 'none' } })
})

test('SPEC[permit-3] pending → committed → released by physical completion', () => {
  const { permits, permit } = fresh()
  assert.equal(permits.committed('ses-a', 'msg-1'), null, 'pending is not executable')
  assert.equal(permits.commit(permit, permit.fence, identity()), 'Applied')
  assert.equal(permits.commit(permit, permit.fence, identity()), 'AlreadyApplied')
  assert.equal(permits.committed('ses-a', 'msg-1'), permit)
  assert.equal(permits.committed('ses-a', 'msg-2'), null)
  assert.equal(permits.releaseBeforeProvider(permit, permit.fence, identity()), 'Conflict', 'a provider-started execution cannot be released before provider')
  assert.equal(permits.releasePhysical('ses-a', 'msg-2'), 'StaleFence', 'another physical message releases nothing')
  assert.equal(permits.releasePhysical('ses-a', 'msg-1'), 'Applied')
  assert.equal(permits.releasePhysical('ses-a', 'msg-1'), 'AlreadyApplied')
  assert.equal(permits.commit(permit, permit.fence, identity()), 'Conflict')
  assert.equal(permits.committed('ses-a', 'msg-1'), null)
  assert.deepEqual(permits.lifecycle(permit, permit.fence), { ok: true, value: 'Released' })
})

test('SPEC[permit-3] pending → released before provider excludes physical completion', () => {
  const { permits, permit } = fresh()
  assert.equal(permits.releaseBeforeProvider(permit, permit.fence, identity()), 'Applied')
  assert.equal(permits.releaseBeforeProvider(permit, permit.fence, identity()), 'AlreadyApplied')
  assert.equal(permits.releasePhysical('ses-a', 'msg-1'), 'Conflict', 'opposite terminal')
  assert.equal(permits.commit(permit, permit.fence, identity()), 'Conflict')
})

test('SPEC[permit-3] pending cannot release by physical completion without a commit', () => {
  const { permits, permit } = fresh()
  assert.equal(permits.releasePhysical('ses-a', 'msg-1'), 'Conflict', 'physical completion requires a prior commit')
  assert.equal(permits.releaseBeforeProvider(permit, permit.fence, identity()), 'Applied', 'before-provider release is still legal from pending')
  assert.equal(permits.releasePhysical('nobody', 'msg-1'), 'StaleFence', 'unknown session')
})

test('SPEC[permit-4] observed identity must match field by field', () => {
  const cases = [
    [{ sessionId: 'ses-x' }, 'Conflict'],
    [{ physicalUserMessageId: 'msg-x' }, 'Conflict'],
    [{ role: 'coder' }, 'Conflict'],
    [{ participant: 'bob' }, 'Conflict'],
    [{ target: { model: 'provider/model', reasoning: 'high' } }, 'Conflict'],
    [{ target: { model: 'provider/other', reasoning: 'none' } }, 'Conflict'],
  ]
  for (const [fields, expected] of cases) {
    const { permits, permit } = fresh()
    assert.equal(permits.commit(permit, permit.fence, identity(fields)), expected, JSON.stringify(fields))
    assert.equal(permits.releaseBeforeProvider(permit, permit.fence, identity(fields)), expected, JSON.stringify(fields))
    assert.deepEqual(permits.lifecycle(permit, permit.fence), { ok: true, value: 'Pending' })
  }
})

test('SPEC[permit-1] malformed input is a caller error', () => {
  const permits = new ExecutionPermits()
  assert.throws(() => permits.issue(null, 1), /^execution-model-routing: /)
  assert.throws(() => permits.issue(identity({ role: 1 }), 1), /role/)
  assert.throws(() => permits.issue(identity({ target: null }), 1), /target/)
  for (const credit of [0, -1, 1.5, '1', NaN, undefined]) {
    assert.throws(() => permits.issue(identity(), credit), /credit/, String(credit))
  }
  assert.throws(() => permits.releasePhysical(1, 'msg'), /string/)
  assert.equal(permits.committed(1, 'msg'), null)
})
