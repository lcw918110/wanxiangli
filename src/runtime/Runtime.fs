module Wanxiangli.Runtime

open Fable.Core
open Fable.Core.JsInterop

let private childProcess: obj = importAll "node:child_process"
let private files: obj = importAll "node:fs"
let private paths: obj = importAll "node:path"
let private operatingSystem: obj = importAll "node:os"
let private nodeProcess: obj = importAll "node:process"

[<Emit("""(function (childProcess, fs, path, os, nodeProcess, workerSource) {
  const now = () => Number(nodeProcess.hrtime.bigint()) / 1000000;
  const errorWithCode = (code, reason) => Object.assign(new Error(reason), { code });
  function schedule(delay, callback) {
    if (!Number.isFinite(delay) || delay < 0) throw errorWithCode('INVALID_DELAY', 'The delay must be finite and nonnegative.');
    const deadline = now() + delay;
    let canceled = false, timer;
    function wake() {
      if (canceled) return;
      const remaining = deadline - now();
      if (remaining > 0) { timer = setTimeout(wake, Math.min(2147483647, Math.ceil(remaining))); return; }
      canceled = true; callback();
    }
    timer = setTimeout(wake, Math.min(2147483647, Math.ceil(delay)));
    return { cancel() { canceled = true; clearTimeout(timer); } };
  }
  function startUnit(spec, onMessage) {
    if (!spec || typeof spec.program !== 'string' || typeof spec.baseClass !== 'string' || !Array.isArray(spec.members)) {
      throw errorWithCode('INVALID_PROGRAM', 'A program, base class, and member list are required.');
    }
    if (!Number.isFinite(spec.executionBudgetMs) || spec.executionBudgetMs <= 0) throw errorWithCode('INVALID_EXECUTION_BUDGET', 'The execution budget must be positive and finite.');
    let executable = nodeProcess.execPath;
    let useBun = Boolean(nodeProcess.versions.bun);
    if (useBun) {
      executable = Bun.which('bun');
      if (!executable) { executable = Bun.which('node'); useBun = false; }
      if (!executable) throw errorWithCode('PROGRAM_RUNTIME_UNAVAILABLE', 'Standalone Bun hosts need bun or node on PATH to execute isolated programs.');
    }
    const args = useBun ? ['--eval', workerSource] : ['--input-type=module', '--eval', workerSource];
    const child = childProcess.spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: nodeProcess.env.PATH || '', LANG: 'C.UTF-8' }
    });
    const allowedMembers = new Set(spec.members);
    let lastRequestId = 0, remaining = spec.executionBudgetMs, runningSince, budgetTimer;
    let externalHold = false, workerRunning = false, terminalSeen = false, closed = false, forced = false, stopping = false;
    let stopTimer, output = '', diagnostics = '', resolveExit;
    const requests = new Set(), exited = new Promise(resolve => { resolveExit = resolve; });
    function stopClock() {
      if (runningSince !== undefined) { remaining = Math.max(0, remaining - (now() - runningSince)); runningSince = undefined; }
      if (budgetTimer) budgetTimer.cancel(); budgetTimer = undefined;
    }
    function forceStop() { if (!closed) { forced = true; child.kill('SIGKILL'); } }
    function reportFailure(code, reason) {
      if (!terminalSeen) { terminalSeen = true; try { onMessage({ type: 'failed', code, reason }); } catch (_) {} }
      stopClock(); forceStop();
    }
    function updateClock() {
      stopClock();
      if (closed || terminalSeen || stopping || externalHold || !workerRunning) return;
      if (remaining <= 0) { reportFailure('PROGRAM_EXECUTION_LIMIT', 'The program used its execution budget.'); return; }
      runningSince = now();
      budgetTimer = schedule(remaining, () => reportFailure('PROGRAM_EXECUTION_LIMIT', 'The program used its execution budget.'));
    }
    function write(message) {
      if (closed || child.stdin.destroyed) return false;
      child.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error && !closed && !stopping) reportFailure('PROGRAM_INPUT_FAILED', error.message);
      });
      return true;
    }
    function receive(message) {
      if (message.type === 'phase') { workerRunning = message.state === 'executing'; updateClock(); return; }
      if (message.type === 'request') {
        if (!Number.isSafeInteger(message.id) || message.id !== lastRequestId + 1 || !allowedMembers.has(message.member) || !Array.isArray(message.args)) {
          reportFailure('PROGRAM_PROTOCOL_FAILED', 'The program sent an invalid SDK request.'); return;
        }
        lastRequestId = message.id; requests.add(message.id);
        if (message.blocking) { workerRunning = false; updateClock(); }
      }
      if (message.type === 'completed' || message.type === 'failed') {
        if (terminalSeen) return; terminalSeen = true; stopClock();
      }
      try {
        const pending = onMessage(message);
        if (pending && typeof pending.then === 'function') pending.catch(error => reportFailure(error.code || 'PROGRAM_HOST_FAILED', error.message || String(error)));
      } catch (error) { reportFailure(error.code || 'PROGRAM_HOST_FAILED', error.message || String(error)); }
    }
    child.stdin.on('error', error => { if (!closed && !stopping) reportFailure('PROGRAM_INPUT_FAILED', error.message); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      output += text;
      for (;;) {
        const newline = output.indexOf('\n');
        if (newline < 0) break;
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try { receive(JSON.parse(line)); } catch (error) { reportFailure('PROGRAM_PROTOCOL_FAILED', error.message); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-(spec.outputBoundBytes || 131072)); });
    child.on('error', error => reportFailure('PROGRAM_START_FAILED', error.message));
    child.on('close', (exitCode, signal) => {
      closed = true; stopClock(); if (stopTimer) stopTimer.cancel(); requests.clear();
      if (!terminalSeen) {
        terminalSeen = true;
        try { onMessage({ type: 'failed', code: 'PROGRAM_EXITED', reason: 'The execution process exited before reporting a result.', exitCode: exitCode === null ? null : exitCode, signal: signal || null, diagnostics }); } catch (_) {}
      }
      resolveExit({ forced, exitCode: exitCode === null ? null : exitCode, signal: signal || null });
    });
    write(spec);
    return {
      pid: child.pid, exited,
      reply(id, envelope) {
        if (!requests.delete(id) || closed) return;
        try { write({ type: 'reply', id, envelope }); }
        catch (error) { write({ type: 'reply', id, envelope: { ok: false, code: 'PROGRAM_REPLY_NOT_SERIALIZABLE', reason: error.message } }); }
      },
      pause() {
        if (closed || terminalSeen || externalHold) return;
        if (nodeProcess.platform === 'win32') throw errorWithCode('PROGRAM_PAUSE_UNSUPPORTED', 'This platform cannot stop a program process without terminating it.');
        if (!child.kill('SIGSTOP')) throw errorWithCode('PROGRAM_PAUSE_FAILED', 'The program process did not accept SIGSTOP.');
        externalHold = true; updateClock();
      },
      resume() {
        if (closed || terminalSeen || !externalHold) return;
        if (!child.kill('SIGCONT')) throw errorWithCode('PROGRAM_RESUME_FAILED', 'The program process did not accept SIGCONT.');
        externalHold = false; updateClock();
      },
      stop(reason) {
        if (!closed && !stopping) {
          stopping = true; stopClock();
          if (externalHold) { child.kill('SIGCONT'); externalHold = false; }
          write({ type: 'cancel', reason: String(reason || 'The program was canceled.') });
          stopTimer = schedule(500, forceStop);
        }
        return exited;
      }
    };
  }
  function startCommand(spec) {
    if (!spec || typeof spec.root !== 'string' || typeof spec.command !== 'string') throw errorWithCode('INVALID_COMMAND', 'A root directory and command string are required.');
    const bound = spec.outputBoundBytes === undefined ? 131072 : spec.outputBoundBytes;
    if (!Number.isSafeInteger(bound) || bound <= 0) throw errorWithCode('INVALID_OUTPUT_BOUND', 'The output bound must be a positive integer.');
    const outputRoot = spec.outputRoot || os.tmpdir();
    fs.mkdirSync(outputRoot, { recursive: true });
    const outputDirectory = fs.mkdtempSync(path.join(outputRoot, 'program-command-'));
    const started = now(), lanes = {};
    try {
      for (const name of ['stdout', 'stderr']) {
        const file = path.join(outputDirectory, name + '.log');
        lanes[name] = { file, descriptor: fs.openSync(file, 'wx', 384), tail: Buffer.alloc(0), delta: Buffer.alloc(0), total: 0, deltaBytes: 0 };
      }
    } catch (error) {
      for (const lane of Object.values(lanes)) fs.closeSync(lane.descriptor);
      throw errorWithCode('COMMAND_OUTPUT_FAILED', error.message);
    }
    let closed = false, groupGone = false, forced = false, closeTimer, groupTimer, failure, inputFailure, resolveResult, rejectResult;
    let shellReceipt, cleanupPromise, cleanupResolve, cleanupReject, cleanupDeadline, delivered = false;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    result.catch(() => {});
    let child;
    try { child = childProcess.spawn(spec.command, { cwd: spec.root, shell: true, detached: nodeProcess.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) {
      for (const lane of Object.values(lanes)) fs.closeSync(lane.descriptor);
      throw errorWithCode('COMMAND_START_FAILED', error.message);
    }
    function sendSignal(signal) {
      if (!probeGroup()) return { sent: false, state: 'exited', pid: child.pid };
      if (typeof signal !== 'string' || !signal.trim()) throw errorWithCode('INVALID_SIGNAL', 'A signal name is required.');
      if (!child.pid) return { sent: false, state: 'not-started' };
      try {
        if (nodeProcess.platform === 'win32') child.kill(signal); else nodeProcess.kill(-child.pid, signal);
        return { sent: true, pid: child.pid, signal };
      } catch (error) {
        if (error.code === 'ESRCH') return { sent: false, state: 'exited', pid: child.pid };
        throw error;
      }
    }
    function probeGroup() {
      if (groupGone) return false;
      if (!child.pid) { groupGone = closed; return !groupGone; }
      if (nodeProcess.platform === 'win32') { groupGone = closed; return !groupGone; }
      try { nodeProcess.kill(-child.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') { groupGone = closed; return !groupGone; }
        throw error;
      }
      if (closed && nodeProcess.platform === 'linux') {
        let members = 0;
        for (const entry of fs.readdirSync('/proc')) {
          if (!/^\d+$/.test(entry)) continue;
          let stat;
          try { stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8'); }
          catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return true; }
          const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
          if (Number(fields[2]) !== child.pid) continue;
          members++;
          if (fields[0] !== 'Z' && fields[0] !== 'X' && fields[0] !== 'x') return true;
        }
        if (members > 0) { groupGone = true; return false; }
      }
      return true;
    }
    function cleanupFailed(error) {
      const reject = cleanupReject;
      if (closeTimer) closeTimer.cancel();
      if (groupTimer) groupTimer.cancel();
      closeTimer = undefined; groupTimer = undefined;
      cleanupDeadline = undefined; cleanupPromise = undefined;
      cleanupResolve = undefined; cleanupReject = undefined;
      if (reject) reject(error);
    }
    function observeGroup() {
      if (groupTimer) groupTimer.cancel();
      groupTimer = undefined;
      try {
        probeGroup();
        if (closed && groupGone) {
          if (closeTimer) closeTimer.cancel();
          if (!delivered) {
            delivered = true;
            if (failure) rejectResult(failure); else resolveResult(shellReceipt);
          }
          if (cleanupResolve) cleanupResolve({ forced, exitCode: shellReceipt.exitCode, signal: shellReceipt.signal });
          return;
        }
        if (cleanupDeadline !== undefined && now() >= cleanupDeadline) {
          cleanupFailed(errorWithCode('COMMAND_CLEANUP_UNCONFIRMED', 'The command process group has not been confirmed closed.'));
          return;
        }
        groupTimer = schedule(20, observeGroup);
      } catch (error) {
        failure = failure || error;
        if (cleanupReject) cleanupFailed(error);
        else rejectResult(error);
      }
    }
    function close() {
      if (closed && groupGone) return Promise.resolve({ forced, exitCode: shellReceipt.exitCode, signal: shellReceipt.signal });
      if (!cleanupPromise) {
        cleanupPromise = new Promise((resolve, reject) => { cleanupResolve = resolve; cleanupReject = reject; });
        cleanupPromise.catch(() => {});
        const attempt = cleanupPromise;
        try {
          sendSignal('SIGTERM');
          closeTimer = schedule(750, () => {
            try {
              if (probeGroup()) {
                forced = sendSignal('SIGKILL').sent;
                cleanupDeadline = now() + 1000;
              }
              observeGroup();
            } catch (error) { cleanupFailed(error); }
          });
          observeGroup();
        } catch (error) { cleanupFailed(error); }
        return attempt;
      }
      return cleanupPromise;
    }
    function tail(previous, bytes) {
      const combined = bytes.length >= bound ? bytes : Buffer.concat([previous, bytes]);
      let start = Math.max(0, combined.length - bound);
      while (start > 0 && start < combined.length && (combined[start] & 192) === 128) start++;
      return Buffer.from(combined.subarray(start));
    }
    function append(name, bytes) {
      const lane = lanes[name];
      lane.total += bytes.length; lane.deltaBytes += bytes.length;
      lane.tail = tail(lane.tail, bytes); lane.delta = tail(lane.delta, bytes);
      if (failure) return;
      try {
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(lane.descriptor, bytes, offset, bytes.length - offset);
      } catch (error) { failure = errorWithCode('COMMAND_OUTPUT_FAILED', error.message); try { close(); } catch (_) {} }
    }
    function snapshot(incremental) {
      const stdout = lanes.stdout, stderr = lanes.stderr;
      const stdoutBytes = incremental ? stdout.deltaBytes : stdout.total, stderrBytes = incremental ? stderr.deltaBytes : stderr.total;
      const stdoutText = incremental ? stdout.delta : stdout.tail, stderrText = incremental ? stderr.delta : stderr.tail;
      const receipt = {
        stdout: stdoutText.toString('utf8'), stderr: stderrText.toString('utf8'),
        bytes: { stdout: stdoutBytes, stderr: stderrBytes },
        truncatedBytes: { stdout: stdoutBytes - stdoutText.length, stderr: stderrBytes - stderrText.length },
        truncated: stdoutBytes > stdoutText.length || stderrBytes > stderrText.length,
        outputFiles: { stdout: stdout.file, stderr: stderr.file }
      };
      if (incremental) {
        stdout.delta = Buffer.alloc(0); stderr.delta = Buffer.alloc(0);
        stdout.deltaBytes = 0; stderr.deltaBytes = 0;
      }
      return receipt;
    }
    child.stdin.on('error', error => { inputFailure = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('error', error => {
      failure = errorWithCode('COMMAND_OUTPUT_FAILED', error.message);
      close().catch(() => {});
    });
    child.stdout.on('data', bytes => append('stdout', Buffer.from(bytes)));
    child.stderr.on('data', bytes => append('stderr', Buffer.from(bytes)));
    child.on('error', error => { failure = errorWithCode('COMMAND_START_FAILED', error.message); });
    child.on('close', (exitCode, signal) => {
      closed = true;
      for (const lane of Object.values(lanes)) {
        try { fs.closeSync(lane.descriptor); } catch (error) { failure = failure || errorWithCode('COMMAND_OUTPUT_FAILED', error.message); }
      }
      shellReceipt = { ...snapshot(false), pid: child.pid, durationMs: now() - started, exitCode: exitCode === null ? null : exitCode, signal: signal || null };
      observeGroup();
    });
    return {
      pid: child.pid, result,
      delta() { return snapshot(true); },
      signal(signal) { try { return Promise.resolve(sendSignal(signal)); } catch (error) { return Promise.reject(error); } },
      send(input) {
        if (typeof input !== 'string') return Promise.reject(errorWithCode('INVALID_INPUT', 'Command input must be a string.'));
        if (closed || child.stdin.destroyed || !child.stdin.writable) return Promise.resolve({ sent: false, state: 'exited', pid: child.pid });
        if (inputFailure) return Promise.reject(inputFailure);
        const text = input === '' || input.endsWith('\n') ? input : input + '\n';
        return new Promise((resolve, reject) => child.stdin.write(text, error => {
          if (error) reject(error); else resolve({ sent: true, pid: child.pid, bytes: Buffer.byteLength(text, 'utf8') });
        }));
      },
      close
    };
  }
  return { now, schedule, startUnit, startCommand };
})($0, $1, $2, $3, $4, $5)""")>]
let private makeRuntime
    (_childProcess: obj)
    (_files: obj)
    (_paths: obj)
    (_operatingSystem: obj)
    (_nodeProcess: obj)
    (_workerSource: string)
    : obj =
    jsNative

[<AttachMembers>]
type private RuntimeHost() =
    let core: obj =
        makeRuntime childProcess files paths operatingSystem nodeProcess RuntimeWorker.source

    member _.now() : float = core?now ()
    member _.schedule(delay: float, callback: unit -> unit) : obj = core?schedule (delay, callback)

    member _.startUnit(spec: obj, onMessage: obj -> unit) : obj =
        core?startUnit (spec, (fun (message: obj) -> onMessage message))

    member _.startCommand(spec: obj) : obj = core?startCommand spec

let Runtime () : obj = RuntimeHost() :> obj
