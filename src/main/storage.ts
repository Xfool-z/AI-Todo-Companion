import { app, safeStorage } from 'electron';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { AppSettings, TodoItem } from '../shared/types';
import { normalizeLocalePreference } from './i18n';
import { parseMarkdownTasks, stringifyMarkdownTasks } from './markdown';

const SETTINGS_FILE = 'settings.json';
const TODO_FILE_NAME = 'todo.md';
const ENCRYPTED_PASSWORD_PREFIX = 'safeStorage:';

async function writeFileAtomic(targetPath: string, content: string) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, 'utf-8');
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function getDefaultTodoPath() {
  const baseDir = path.join(app.getPath('documents'), 'Just Do It');
  return path.join(baseDir, TODO_FILE_NAME);
}

function defaultSettings(): AppSettings {
  return {
    todoFilePath: getDefaultTodoPath(),
    globalShortcut: 'CommandOrControl+Shift+A',
    alwaysOnTop: true,
    desktopPinned: false,
    desktopLockPosition: true,
    desktopMouseThrough: false,
    showCodexUsage: false,
    windowOpacity: 0.96,
    theme: 'light',
    language: 'system',
    windowBounds: undefined,
    projects: [],
    activeProjectId: '',
    workspaceView: 'focus',
    webdav: {
      enabled: false,
      url: '',
      username: '',
      password: '',
      remotePath: '/todo.md',
      intervalMinutes: 60
    }
  };
}

function decryptWebDavPassword(password: unknown) {
  if (typeof password !== 'string') {
    return '';
  }

  if (!password.startsWith(ENCRYPTED_PASSWORD_PREFIX)) {
    return password;
  }

  try {
    const encoded = password.slice(ENCRYPTED_PASSWORD_PREFIX.length);
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

function settingsForDisk(settings: AppSettings): AppSettings {
  const password = settings.webdav.password;
  if (!password || !safeStorage.isEncryptionAvailable()) {
    return settings;
  }

  const encrypted = safeStorage.encryptString(password).toString('base64');
  return {
    ...settings,
    webdav: {
      ...settings.webdav,
      password: `${ENCRYPTED_PASSWORD_PREFIX}${encrypted}`
    }
  };
}

function parseSettingsContent(raw: string): AppSettings {
  const parsed = JSON.parse(raw) as Partial<AppSettings> & { launchAtStartup?: unknown };
  const { launchAtStartup: _legacyLaunchAtStartup, ...currentSettings } = parsed;
  const webdav = {
    ...defaultSettings().webdav,
    ...currentSettings.webdav
  };
  return {
    ...defaultSettings(),
    ...currentSettings,
    language: normalizeLocalePreference(currentSettings.language),
    webdav: {
      ...webdav,
      password: decryptWebDavPassword(webdav.password)
    }
  };
}

export class StorageService {
  private settingsPath: string;
  private watcher: FSWatcher | null = null;
  private writeInProgress = false;

  constructor(private onExternalTasksChange: (tasks: TodoItem[]) => void) {
    this.settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  async initFiles() {
    const settings = await this.loadSettings();
    await this.ensureTodoFile(settings.todoFilePath);
    return settings;
  }

  async loadSettings(): Promise<AppSettings> {
    let raw: string;

    try {
      raw = await readFile(this.settingsPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      const next = defaultSettings();
      await this.saveSettings(next);
      return next;
    }

    try {
      return parseSettingsContent(raw);
    } catch (error) {
      const backupPath = `${this.settingsPath}.corrupt-${Date.now()}.bak`;
      await copyFile(this.settingsPath, backupPath);
      console.error(`设置文件损坏，已备份到 ${backupPath}:`, error);

      try {
        const recovered = parseSettingsContent(await readFile(`${this.settingsPath}.bak`, 'utf-8'));
        await this.saveSettings(recovered);
        return recovered;
      } catch {
        // No usable last-known-good settings backup is available.
      }

      const next = defaultSettings();
      await this.saveSettings(next);
      return next;
    }
  }

  async saveSettings(settings: AppSettings) {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    try {
      parseSettingsContent(await readFile(this.settingsPath, 'utf-8'));
      await copyFile(this.settingsPath, `${this.settingsPath}.bak`);
    } catch {
      // Only preserve a valid previous settings file.
    }
    await writeFileAtomic(this.settingsPath, JSON.stringify(settingsForDisk(settings), null, 2));
  }

  async ensureTodoFile(todoPath: string) {
    await mkdir(path.dirname(todoPath), { recursive: true });
    try {
      await readFile(todoPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await writeFile(todoPath, '', 'utf-8');
    }
  }

  async readTasks(todoPath: string): Promise<TodoItem[]> {
    await this.ensureTodoFile(todoPath);
    const content = await readFile(todoPath, 'utf-8');
    return parseMarkdownTasks(content);
  }

  async writeTasks(todoPath: string, tasks: TodoItem[]) {
    this.writeInProgress = true;
    try {
      const markdown = stringifyMarkdownTasks(tasks);
      try {
        const previous = await readFile(todoPath, 'utf-8');
        if (parseMarkdownTasks(previous).length > 0 || tasks.length === 0) {
          await copyFile(todoPath, `${todoPath}.bak`);
        }
      } catch {
        // A missing or unreadable previous file must not block the new save.
      }
      await writeFileAtomic(todoPath, `${markdown}${markdown ? '\n' : ''}`);
    } finally {
      setTimeout(() => {
        this.writeInProgress = false;
      }, 120);
    }
  }

  watchTodoFile(todoPath: string) {
    this.unwatchTodoFile();

    let debounceTimer: NodeJS.Timeout | null = null;

    const directory = path.dirname(todoPath);
    const fileName = path.basename(todoPath);
    this.watcher = watch(directory, (_eventType, changedFileName) => {
      if (changedFileName && changedFileName.toString() !== fileName) {
        return;
      }
      if (this.writeInProgress) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(async () => {
        try {
          const tasks = await this.readTasks(todoPath);
          this.onExternalTasksChange(tasks);
        } catch (error) {
          console.error('外部变更读取失败:', error);
        }
      }, 150);
    });
  }

  unwatchTodoFile() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

