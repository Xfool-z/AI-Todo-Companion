import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.join(root, 'release', 'win-unpacked', 'ApexTodo.exe');
const storeAssetRoot = path.join(root, 'release', 'store-assets');

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending(new Error('CDP connection closed')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP connection failed')));

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  });

  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); }, { once: true });
  });

  return {
    async command(method, params = {}) {
      await opened;
      if (socket.readyState !== WebSocket.OPEN) throw new Error('CDP connection is not open');
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); }
        });
      });
      socket.send(JSON.stringify({
        id,
        method,
        params
      }));
      return response;
    },
    async evaluate(expression) {
      const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed'
        );
      }
      return result.result.value;
    },
    close() {
      socket.close();
    }
  };
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'apextodo-system-'));
const todoPath = path.join(testRoot, 'todo.md');
const settingsPath = path.join(testRoot, 'settings.json');
const port = await getFreePort();
const taskText = '整理今天的重点任务';
await mkdir(testRoot, { recursive: true });
await mkdir(path.join(storeAssetRoot, 'zh-CN'), { recursive: true });
await mkdir(path.join(storeAssetRoot, 'en-US'), { recursive: true });
await writeFile(settingsPath, JSON.stringify({ todoFilePath: todoPath, language: 'zh-CN' }, null, 2), 'utf8');

const args = ['--hidden', `--user-data-dir=${testRoot}`, `--remote-debugging-port=${port}`];
const app = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
app.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

let cdp;
try {
  const page = await waitFor(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  }, '无法连接 ApexTodo 渲染进程');
  cdp = connectCdp(page.webSocketDebuggerUrl);

  const initialText = await waitFor(
    async () => {
      const text = await cdp.evaluate("document.body?.innerText || ''");
      return text.includes('ApexTodo') ? text : '';
    },
    'ApexTodo 界面未完成加载'
  );
  assert.match(initialText, /ApexTodo/);
  assert.equal(await cdp.evaluate("document.querySelector('[data-theme]')?.getAttribute('data-theme')"), 'light');

  assert.equal(await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.title === '切换到深色模式');
    button?.click();
    return Boolean(button);
  })()`), true);
  await waitFor(
    () => cdp.evaluate("document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark'"),
    '主题切换失败'
  );

  assert.equal(await cdp.evaluate(`(() => {
    const input = document.querySelector('input[placeholder^="添加任务"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(taskText)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`), true);
  await waitFor(() => cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(taskText)})`), '新增任务未显示');
  await waitFor(async () => (await readFile(todoPath, 'utf8')).includes(taskText), '新增任务未写入 Markdown');

  // A second instance should reveal the hidden primary window before screenshots.
  const second = spawn(executable, args, { stdio: 'ignore' });
  const secondExitCode = await waitForExit(second, 5_000);
  assert.notEqual(secondExitCode, null, '第二实例未按预期退出');
  assert.equal(app.exitCode, null, '主实例意外退出');

  await cdp.command('Emulation.setDeviceMetricsOverride', {
    width: 768,
    height: 1366,
    deviceScaleFactor: 1,
    mobile: false
  });
  const chineseScreenshotPath = path.join(storeAssetRoot, 'zh-CN', 'apextodo-main.png');
  const chineseScreenshot = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(chineseScreenshotPath, Buffer.from(chineseScreenshot.data, 'base64'));

  assert.equal(await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.title === '设置');
    button?.click();
    return Boolean(button);
  })()`), true);
  await waitFor(() => cdp.evaluate("document.body.innerText.includes('WebDAV 同步')"), '设置面板未打开');

  assert.equal(await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.theme-seg button')].find((item) => item.textContent?.trim() === 'English');
    button?.click();
    return Boolean(button);
  })()`), true);
  await waitFor(
    () => cdp.evaluate("document.body.innerText.includes('Window & desktop') && document.body.innerText.includes('WebDAV sync')"),
    '切换英文界面失败'
  );
  assert.equal(
    await cdp.evaluate("document.querySelector('input[placeholder^=\"Add a task\"]') !== null"),
    true,
    '新增待办输入框未切换为英文'
  );
  await waitFor(async () => JSON.parse(await readFile(settingsPath, 'utf8')).language === 'en-US', '语言设置未持久化');

  assert.equal(await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.title === 'Close');
    button?.click();
    return Boolean(button);
  })()`), true);
  await waitFor(() => cdp.evaluate("!document.body.innerText.includes('Window & desktop')"), '英文设置面板未关闭');
  assert.equal(await cdp.evaluate(`(() => {
    const task = [...document.querySelectorAll('p')].find((item) => item.textContent?.trim() === ${JSON.stringify(taskText)});
    task?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Boolean(task);
  })()`), true);
  await waitFor(() => cdp.evaluate("document.querySelector('textarea') !== null"), '待办编辑框未打开');
  const englishTaskText = 'Plan today’s most important tasks';
  assert.equal(await cdp.evaluate(`(() => {
    const input = document.querySelector('textarea');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify('Plan today’s most important tasks')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`), true);
  await waitFor(() => cdp.evaluate(`document.body.innerText.includes(${JSON.stringify('Plan today’s most important tasks')})`), '英文待办未保存');
  const englishScreenshotPath = path.join(storeAssetRoot, 'en-US', 'apextodo-main.png');
  const englishScreenshot = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(englishScreenshotPath, Buffer.from(englishScreenshot.data, 'base64'));

  console.log(JSON.stringify({
    passed: true,
    checks: ['renderer-loaded', 'theme-toggle', 'task-add-and-persist', 'settings-open', 'language-switch-and-persist', 'single-instance'],
    testRoot,
    screenshots: [chineseScreenshotPath, englishScreenshotPath]
  }, null, 2));

  void cdp.evaluate('window.todoApi.closeWindow()').catch(() => undefined);
  await waitForExit(app, 3_000);
} finally {
  cdp?.close();
  if (app.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}
