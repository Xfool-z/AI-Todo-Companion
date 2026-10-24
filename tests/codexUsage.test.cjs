const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const usagePath = require.resolve('../dist-electron/codexUsage.js');
const usageSource = readFileSync(usagePath, 'utf8');
const usageRequire = createRequire(usagePath);
const resetAt = 1793425999;

function windowData(seconds, percent = 2) {
  return { used_percent: percent, limit_window_seconds: seconds, reset_at: resetAt };
}

// Exercise the public reader without accessing local credentials or the network.
async function readUsage(body, { status = 200, locale = 'zh-CN' } = {}) {
  const exports = {};
  const context = {
    module: { exports },
    exports,
    process: { env: { CODEX_HOME: 'mock-codex-home' } },
    AbortController,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id === 'electron') {
        return {
          app: { getVersion: () => 'test' },
          net: { fetch: async () => ({ status, ok: status === 200, json: async () => body }) }
        };
      }
      if (id === 'node:fs/promises') {
        return { readFile: async () => JSON.stringify({ tokens: { access_token: 'test-token' } }) };
      }
      return usageRequire(id);
    }
  };
  vm.runInNewContext(usageSource, context, { filename: usagePath });
  return context.module.exports.getCodexUsage(locale);
}

test('Pro weekly usage in the primary slot remains available without a five-hour window', async () => {
  const usage = await readUsage({
    plan_type: 'pro',
    rate_limit: { primary_window: windowData(604800), secondary_window: null }
  });
  assert.equal(usage.status, 'ready');
  assert.equal(usage.planType, 'pro');
  assert.equal(usage.fiveHour, undefined);
  assert.equal(usage.weekly.usedPercent, 2);
  assert.equal(usage.weekly.resetAt, new Date(resetAt * 1000).toISOString());
  assert.ok(Number.isFinite(Date.parse(usage.fetchedAt)));
  assert.equal(usage.message, undefined);
});

test('weekly-only usage is recognized in the secondary slot too', async () => {
  const usage = await readUsage({
    rate_limit: { primary_window: null, secondary_window: windowData(604800, 31) }
  });
  assert.equal(usage.status, 'ready');
  assert.equal(usage.fiveHour, undefined);
  assert.equal(usage.weekly.usedPercent, 31);
});

test('five-hour-only usage remains available', async () => {
  const usage = await readUsage({ rate_limit: { primary_window: windowData(18000, 10) } });
  assert.equal(usage.status, 'ready');
  assert.equal(usage.fiveHour.usedPercent, 10);
  assert.equal(usage.weekly, undefined);
});

test('Plus dual windows keep independent percentages and reset times', async () => {
  const usage = await readUsage({
    plan_type: 'plus',
    rate_limit: { primary_window: windowData(18000, 28), secondary_window: windowData(604800, 0) }
  });
  assert.equal(usage.status, 'ready');
  assert.equal(usage.planType, 'plus');
  assert.equal(usage.fiveHour.usedPercent, 28);
  assert.equal(usage.fiveHour.windowSeconds, 18000);
  assert.equal(usage.weekly.usedPercent, 0);
  assert.equal(usage.weekly.windowSeconds, 604800);
});

test('an absent or unrecognized window does not hide the other usable window', async () => {
  for (const primary of [{}, windowData(3600), { ...windowData(18000), used_percent: 'invalid' }]) {
    const usage = await readUsage({
      rate_limit: { primary_window: primary, secondary_window: windowData(604800) }
    });
    assert.equal(usage.status, 'ready');
    assert.equal(usage.fiveHour, undefined);
    assert.equal(usage.weekly.usedPercent, 2);
  }
});

test('no usable windows reports unavailability in both languages', async () => {
  for (const body of [{}, { rate_limit: null }, { rate_limit: {} }, { rate_limit: { primary_window: windowData(3600) } }]) {
    const usage = await readUsage(body);
    assert.equal(usage.status, 'unavailable');
    assert.equal(usage.message, '当前账户未返回可显示的用量窗口');
  }
  const usage = await readUsage({}, { locale: 'en-US' });
  assert.equal(usage.message, 'The account did not return any supported usage windows');
});

test('authorization and service errors still take precedence over window data', async () => {
  const body = { rate_limit: { primary_window: windowData(604800) } };
  for (const status of [401, 403]) {
    const usage = await readUsage(body, { status });
    assert.equal(usage.status, 'unavailable');
    assert.match(usage.message, /重新登录/);
  }
  const usage = await readUsage(body, { status: 503 });
  assert.equal(usage.status, 'error');
  assert.match(usage.message, /503/);
});
