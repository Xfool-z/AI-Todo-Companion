import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CodexTaskRun } from '../shared/types';

export class CodexTaskService {
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private stops = new Map<string, () => void>();
  constructor(
    private changed: (run: CodexTaskRun) => void,
    private approve: (description: string) => Promise<boolean>
  ) {}

  start(binary: string, cwd: string, taskId: string, prompt: string): CodexTaskRun {
    if (this.processes.has(taskId)) throw new Error('此任务正在执行，请先停止或等待完成');
    const child = spawn(binary, ['app-server'], { cwd, windowsHide: true, stdio: 'pipe' });
    this.processes.set(taskId, child);
    const run: CodexTaskRun = { taskId, cwd, status: 'starting', output: '' };
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let sequence = 0;
    let finished = false;
    let turnId: string | undefined;
    const update = () => this.changed({ ...run });
    const finish = (status: CodexTaskRun['status'], message?: string) => {
      if (finished) return;
      finished = true; run.status = status;
      if (message) run.output += `\n${message}`;
      update(); this.processes.delete(taskId); this.stops.delete(taskId);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex 会话已结束')); }
      pending.clear(); child.stdin.end(); child.kill();
    };
    const send = (message: object) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
    };
    const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 连接超时，请确认已登录并重试')); }, 90_000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
    this.stops.set(taskId, () => {
      if (run.threadId && turnId) {
        void request('turn/interrupt', { threadId: run.threadId, turnId }).finally(() => finish('failed', '已请求停止。请检查已生成的文件。')).catch(() => undefined);
      } else { finish('failed', '已停止连接。'); }
    });
    child.stdin.on('error', () => finish('failed', 'Codex 连接已断开。'));
    // Never display raw stderr or account data: these can contain local configuration details.
    child.stderr.on('data', () => {});
    child.on('error', () => finish('failed', '无法启动 Codex，请检查安装路径。'));
    child.on('exit', () => { if (!finished) finish('failed', 'Codex 进程已结束，请检查登录或配置。'); });
    createInterface({ input: child.stdout }).on('line', async line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error('Codex 拒绝了请求，请检查登录状态与本地配置。'));
        else entry.resolve(message.result);
        return;
      }
      const params = message.params || {};
      if (message.method === 'turn/started') turnId = params.turn?.id;
      if (message.id !== undefined && message.method) {
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          run.status = 'approval'; update();
          const accepted = await this.approve(params.command || params.reason || `Codex 请求修改工作目录：${cwd}`).catch(() => false);
          if (!finished) { send({ id: message.id, result: { decision: accepted ? 'accept' : 'decline' } }); run.status = 'running'; update(); }
        } else {
          send({ id: message.id, error: { code: -32601, message: '此试用版暂不支持该交互，请在 Codex 中继续。' } });
        }
        return;
      }
      if (message.method === 'item/agentMessage/delta') {
        run.output = (run.output + String(params.delta || '')).slice(-100_000); update();
      }
      if (message.method === 'turn/completed') {
        finish(params.turn?.status === 'completed' ? 'review' : 'failed', params.turn?.status === 'completed' ? '执行结束，请验证结果后再勾选任务。' : '执行未完成，请在 Codex 中检查。');
      }
    });
    update();
    void (async () => {
      await request('initialize', { clientInfo: { name: 'just_do_it', title: 'Just Do It', version: '0.2.1' } });
      send({ method: 'initialized', params: {} });
      const account = await request('account/read', { refreshToken: false });
      if (account.requiresOpenaiAuth && !account.account) throw new Error('请先在 Codex 中登录，再发送任务。');
      const result = await request('thread/start', { cwd, ephemeral: false, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      run.threadId = result.thread.id; run.status = 'running'; update();
      const started = await request('turn/start', { threadId: run.threadId, input: [{ type: 'text', text: prompt }] });
      turnId = started.turn?.id;
    })().catch(error => { if (!finished) finish('failed', error.message); });
    return { ...run };
  }

  stop(taskId: string) { this.stops.get(taskId)?.(); }
  stopAll() { for (const child of this.processes.values()) child.kill(); }
}

