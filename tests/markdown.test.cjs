const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskFromText, parseMarkdownTasks, stringifyMarkdownTasks } = require('../dist-electron/markdown.js');

test('parses LF and CRLF tasks while ignoring other markdown', () => {
  const tasks = parseMarkdownTasks('# title\r\n- [ ] first (2026-09-27 10:20)\r\ntext\n- [X] second');
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map(({ text, completed }) => ({ text, completed })),
    [
      { text: 'first', completed: false },
      { text: 'second', completed: true }
    ]
  );
  assert.equal(tasks[0].createdAt, '2026-09-27 10:20');
});

test('stringify preserves task order and completion state', () => {
  const markdown = stringifyMarkdownTasks([
    { id: '1', text: 'alpha', completed: false, createdAt: '2026-09-27 10:20' },
    { id: '2', text: 'beta', completed: true, createdAt: '2026-09-27 10:21' }
  ]);
  assert.equal(markdown, '- [ ] alpha (2026-09-27 10:20)\n- [x] beta (2026-09-27 10:21)');
});

test('createTaskFromText collapses multiline whitespace', () => {
  const task = createTaskFromText('  one\n\t two  ');
  assert.equal(task.text, 'one two');
  assert.equal(task.completed, false);
  assert.match(task.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
