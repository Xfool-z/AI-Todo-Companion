const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

function harness(loggedIn = true) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  const calls = [];
  const notify = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const message = JSON.parse(chunk.toString()); calls.push(message);
    if (message.method) setImmediate(() => {
      const results = {
        initialize: {},
        'account/read': { requiresOpenaiAuth: true, account: loggedIn ? { type: 'chatgpt' } : null },
        'thread/start': { thread: { id: 'thread-test' } },
        'turn/start': { turn: { id: 'turn-test' } }
      };
      if (message.id && Object.hasOwn(results, message.method)) notify({ id: message.id, result: results[message.method] });
    });
    done();
  }});
  const context = { module: { exports: {} }, exports: {}, require(name) { return name === 'node:child_process' ? { spawn: () => child } : require(name); }, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../dist-electron/codexTasks.js'), 'utf8'), context);
  return { Service: context.module.exports.CodexTaskService, calls, notify };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Protocol test timed out');
}
test('Codex starts a persistent task with scoped permissions and streams results without completing the todo', async () => {
  const h = harness(), updates = [];
  const service = new h.Service(run => updates.push(run), async () => false);
  service.start('codex.exe', 'C:/project', 'task-1', 'Task with comment');
  await until(() => h.calls.some(c => c.method === 'turn/start'));
  const thread = h.calls.find(c => c.method === 'thread/start');
  assert.equal(thread.params.ephemeral, false);
  assert.equal(thread.params.sandbox, 'workspace-write');
  assert.equal(thread.params.approvalPolicy, 'on-request');
  assert.equal(thread.params.cwd, 'C:/project');
  h.notify({ method: 'item/agentMessage/delta', params: { delta: 'Verified output' } });
  h.notify({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await until(() => updates.at(-1)?.status === 'review');
  assert.match(updates.at(-1).output, /Verified output/);
  service.stopAll();
});
test('Missing Codex login fails before sending any task', async () => {
  const h = harness(false), updates = [];
  const service = new h.Service(run => updates.push(run), async () => false);
  service.start('codex.exe', 'C:/project', 'task-2', 'Do not send');
  await until(() => updates.at(-1)?.status === 'failed');
  assert.equal(h.calls.some(c => c.method === 'turn/start'), false);
  assert.match(updates.at(-1).output, /登录/);
});

