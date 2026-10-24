const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LocalizedError,
  localizedErrorMessage,
  normalizeLocalePreference,
  resolveLocale,
  translate
} = require('../dist-electron/i18n.js');

test('resolves supported locales and falls back to English for other system languages', () => {
  assert.equal(resolveLocale('system', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveLocale('system', 'en-GB'), 'en-US');
  assert.equal(resolveLocale('system', 'fr-FR'), 'en-US');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('normalizes invalid saved language preferences to system', () => {
  assert.equal(normalizeLocalePreference('en-US'), 'en-US');
  assert.equal(normalizeLocalePreference('unsupported'), 'system');
  assert.equal(normalizeLocalePreference(undefined), 'system');
});

test('translates text with interpolation in Chinese and English', () => {
  assert.equal(translate('zh-CN', 'task.count', { count: 3 }), '3 项待办');
  assert.equal(translate('en-US', 'task.count', { count: 3 }), '3 to do');
  assert.equal(
    localizedErrorMessage('en-US', new LocalizedError('sync.missingRemoteTime')),
    'The remote modified time is unavailable; sync stopped to avoid overwriting data'
  );
});
