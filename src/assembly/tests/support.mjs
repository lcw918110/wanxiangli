import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteJournal } from 'wanxiangli/eventstore'
import { DurableWork } from 'wanxiangli/durable-work'

export class Rig {
  serial = 0
  constructor(t, sequence = ['S1', 'S2', 'S3']) {
    const directory = mkdtempSync(path.join(tmpdir(), 'wanxiangli-composition-'))
    this.path = path.join(directory, 'work.sqlite')
    this.journals = []
    this.sequence = sequence
    t.after(() => {
      for (const journal of this.journals) journal.close()
      rmSync(directory, { recursive: true, force: true })
    })
    this.journal = this.connect()
    this.work = new DurableWork('work-a', this.journal)
  }
  connect() {
    const journal = new SqliteJournal(new DatabaseSync(this.path))
    this.journals.push(journal)
    return journal
  }
  reopen() { return new DurableWork('work-a', this.connect()) }
  call(command, requestId = `request-${++this.serial}`) { return this.work.execute(requestId, command) }
  commit(command, requestId) {
    const reply = this.call(command, requestId)
    assert.equal(reply.status, 'Committed', JSON.stringify(reply))
    return reply.result
  }
  open() {
    return this.commit({ type: 'Open', root: '组合验收', sequence: this.sequence, ownerId: 'manager', openingCursor: 0 }, 'open')
  }
  review(updates = []) {
    return this.commit({ type: 'Review', incumbencyId: this.work.inspect().active.id, reviewerId: 'reviewer', updates })
  }
  delivery(overrides = {}) {
    const state = this.work.inspect()
    return { type: 'Deliver', incumbencyId: state.active.id, providerRunId: 'run', toolCallId: `call-${++this.serial}`,
      cursor: state.revision + 1, blockers: [], nextOwnerId: 'manager', ...overrides }
  }
  authorize() {
    this.open()
    for (let stage = 0; stage < 3; stage++) {
      this.review()
      this.commit(this.delivery())
    }
  }
}
