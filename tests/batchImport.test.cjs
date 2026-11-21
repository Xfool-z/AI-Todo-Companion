const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBatchImportPreview,
  normalizeTaskText,
  parseBatchTaskText
} = require('../dist-electron/batchImport.js');

test('parses numbered, markdown, checkbox, and plain task lines', () => {
  const tasks = parseBatchTaskText(
    '# plan\n1. first\n2、second\n- third\n* [ ] fourth\n- [x] finished\nplain task\n```'
  );

  assert.deepEqual(tasks, [
    { text: 'first', completed: false },
    { text: 'second', completed: false },
    { text: 'third', completed: false },
    { text: 'fourth', completed: false },
    { text: 'finished', completed: true },
    { text: 'plain task', completed: false }
  ]);
});

test('marks existing and pasted duplicates as skipped by default', () => {
  const preview = createBatchImportPreview(
    '- Existing task\n- new task\n- NEW   TASK',
    [{ text: 'existing TASK' }]
  );

  assert.deepEqual(
    preview.map(({ text, duplicate, selected }) => ({ text, duplicate, selected })),
    [
      { text: 'Existing task', duplicate: true, selected: false },
      { text: 'new task', duplicate: false, selected: true },
      { text: 'NEW TASK', duplicate: true, selected: false }
    ]
  );
});

test('normalizes case and repeated whitespace for duplicate checks', () => {
  assert.equal(normalizeTaskText('  Alpha   BETA '), normalizeTaskText('alpha beta'));
});
