const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function workspace() {
  const handlers = new Map();
  const filename = path.resolve(__dirname, '../dist-electron/main.js');
  const realRequire = createRequire(filename);
  class Storage {
    async saveSettings() {}
    async writeTasks(_path, tasks) { this.saved = JSON.parse(JSON.stringify(tasks)); }
  }
  const electron = {
    app: { setName() {}, setPath() {}, getPath() { return '/test'; }, requestSingleInstanceLock() { return false; }, quit() {}, on() {}, isReady() { return false; } },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    clipboard: { writeText() {} }
  };
  const context = {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './storage') return { StorageService: Storage };
      if (name === './codexUsage') return { getCodexUsage() {} };
      if (name === './sync') return { WebDavSyncService: class {} };
      return realRequire(name);
    },
    exports: {}, __dirname: path.dirname(filename), process, console, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + `
    settings = { projects: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], activeProjectId: 'a', todoFilePath: '/test/todo.md', language: 'zh-CN' };
    tasks = [
      { id: 'a1', text: 'first', projectId: 'a', comment: 'verify', completed: false },
      { id: 'b1', text: 'other', projectId: 'b', completed: false },
      { id: 'a2', text: 'second', projectId: 'a', completed: false },
      { id: 'done', text: 'done', projectId: 'a', completed: true }
    ];
    broadcastState = () => {};
    setupIpcHandlers();
    globalThis.snapshot = () => JSON.parse(JSON.stringify(currentState()));
  `, context);
  return { invoke: (name, ...args) => handlers.get(name)({}, ...args), snapshot: () => JSON.parse(JSON.stringify(context.snapshot())) };
}

test('deleting a project preserves tasks and comments by default', async () => {
  const app = workspace();
  await app.invoke('project:delete', 'a');
  const state = app.snapshot();
  assert.equal(state.tasks.length, 4);
  assert.equal(state.tasks.find(t => t.id === 'a1').comment, 'verify');
  assert.equal(state.tasks.find(t => t.id === 'a1').projectId, undefined);
  assert.deepEqual(state.settings.projects.map(p => p.id), ['b']);
  assert.equal(state.settings.activeProjectId, '');
});

test('explicit project deletion removes only that project tasks', async () => {
  const app = workspace();
  await app.invoke('project:delete', 'a', true);
  assert.deepEqual(app.snapshot().tasks.map(t => t.id), ['b1']);
});

test('moving completed tasks preserves status and moving back to independent works', async () => {
  const app = workspace();
  await app.invoke('task:move', 'done', 'b');
  assert.equal(app.snapshot().tasks.find(t => t.id === 'done').completed, true);
  await app.invoke('task:move', 'a1', 'b');
  assert.equal(app.snapshot().tasks.find(t => t.id === 'a1').comment, 'verify');
  await app.invoke('task:move', 'a1', '');
  assert.equal(app.snapshot().tasks.find(t => t.id === 'a1').projectId, undefined);
  await assert.rejects(app.invoke('task:move', 'a1', 'missing'));
});

test('project sorting preserves other project slots and completed tasks', async () => {
  const app = workspace();
  await app.invoke('task:reorder-open', ['a2', 'a1']);
  assert.deepEqual(app.snapshot().tasks.map(t => t.id), ['a2', 'b1', 'a1', 'done']);
});

