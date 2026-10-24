import { readFile, stat, writeFile } from 'node:fs/promises';
import { createClient } from 'webdav';
import { AppSettings } from '../shared/types';
import { LocalizedError, LocalizedMessage, SupportedLocale, localizedErrorMessage } from './i18n';

interface SyncStatus {
  time?: string;
  message: LocalizedMessage;
}

type RemoteFileContents = string | Buffer | Uint8Array | { data?: string | Buffer | Uint8Array };

export function decodeRemoteFileContents(value: RemoteFileContents): string {
  const payload = typeof value === 'object' && value !== null && 'data' in value ? value.data : value;

  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    return Buffer.from(payload).toString('utf-8');
  }

  throw new LocalizedError('sync.invalidRemoteContent');
}

export function parseRemoteModifiedTime(value: {
  lastmod?: string;
  lastModified?: string;
  mtime?: string | number | Date;
  data?: { lastmod?: string; lastModified?: string; mtime?: string | number | Date };
}): number | null {
  const payload = value?.data ?? value;
  const raw = payload?.lastmod ?? payload?.lastModified ?? payload?.mtime;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }

  const timestamp = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export class WebDavSyncService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private getSettings: () => AppSettings,
    private onStatus: (status: SyncStatus) => void,
    private getLocale: () => SupportedLocale
  ) {}

  start() {
    this.restartTimer();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  restartTimer() {
    this.stop();
    const settings = this.getSettings();
    if (!settings.webdav.enabled) {
      return;
    }

    const intervalMinutes = Math.max(1, settings.webdav.intervalMinutes || 60);
    this.timer = setInterval(() => {
      const currentSettings = this.getSettings();
      this.sync(currentSettings.todoFilePath).catch((error) => {
        console.error('WebDAV 定时同步失败:', error);
        this.onStatus({
          message: { key: 'sync.scheduledFailed', params: { message: localizedErrorMessage(this.getLocale(), error) } }
        });
      });
    }, intervalMinutes * 60 * 1000);
  }

  async sync(todoFilePath: string) {
    const settings = this.getSettings();
    const webdav = settings.webdav;
    if (!webdav.enabled || !webdav.url || !webdav.username) {
      this.onStatus({ message: { key: 'sync.notConfigured' } });
      return;
    }

    const client = createClient(webdav.url, {
      username: webdav.username,
      password: webdav.password
    });

    const remotePath = webdav.remotePath || '/todo.md';
    const localContent = await readFile(todoFilePath, 'utf-8');
    const localStat = await stat(todoFilePath);

    const remoteExists = await client.exists(remotePath);

    if (!remoteExists) {
      await client.putFileContents(remotePath, localContent, { overwrite: true });
      this.onStatus({
        time: new Date().toISOString(),
        message: { key: 'sync.initialPush' }
      });
      return;
    }

    const remoteBuffer = (await client.getFileContents(remotePath)) as unknown as RemoteFileContents;
    // webdav 不同版本可能返回 string / Buffer / 带 details 包装，统一按字节处理
    const remoteContent = decodeRemoteFileContents(remoteBuffer);

    if (remoteContent === localContent) {
      this.onStatus({
        time: new Date().toISOString(),
        message: { key: 'sync.upToDate' }
      });
      return;
    }

    // 兼容 details 包装（.data）与不同版本字段名 lastmod / lastModified
    const statRaw = (await client.stat(remotePath)) as unknown as {
      lastmod?: string;
      lastModified?: string;
      mtime?: string | number | Date;
      data?: { lastmod?: string; lastModified?: string; mtime?: string | number | Date };
    };
    const remoteMtime = parseRemoteModifiedTime(statRaw);
    if (remoteMtime === null) {
      throw new LocalizedError('sync.missingRemoteTime');
    }

    if (remoteMtime > localStat.mtimeMs + 1000) {
      await writeFile(todoFilePath, remoteContent, 'utf-8');
      this.onStatus({
        time: new Date().toISOString(),
        message: { key: 'sync.remotePulled' }
      });
      return;
    }

    await client.putFileContents(remotePath, localContent, { overwrite: true });
    this.onStatus({
      time: new Date().toISOString(),
      message: { key: 'sync.localPushed' }
    });
  }
}
