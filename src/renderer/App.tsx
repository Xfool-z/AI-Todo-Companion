import { CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import dayjs from 'dayjs';
import { AppSettings, AppState, CodexUsage, CodexUsageWindow, ThemeMode, TodoItem } from '../shared/types';
import {
  LocalePreference,
  SupportedLocale,
  TranslationKey,
  TranslationParams,
  resolveLocale,
  translate
} from '../main/i18n';
import { SortableTaskItem } from './components/SortableTaskItem';
import {
  ApexLogo,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CloudIcon,
  FolderIcon,
  KeyboardIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SunIcon,
  TrashIcon
} from './components/icons';

const defaultSettings: AppSettings = {
  todoFilePath: '',
  globalShortcut: 'CommandOrControl+Shift+A',
  alwaysOnTop: true,
  desktopPinned: false,
  desktopLockPosition: true,
  desktopMouseThrough: false,
  showCodexUsage: false,
  windowOpacity: 0.96,
  theme: 'light',
  language: 'system',
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

const INDEPENDENT_TARGET = '__independent__';
type BatchCandidate = { id: string; text: string; completed: boolean; duplicate: boolean; selected: boolean };

function formatShortcutForDisplay(shortcut: string, locale: SupportedLocale) {
  if (!shortcut) {
    return translate(locale, 'shortcut.record');
  }

  return shortcut
    .split('+')
    .map((part) => {
      const token = part.trim();
      if (token === 'CommandOrControl') {
        return 'Ctrl';
      }
      if (token === 'Command') {
        return 'Cmd';
      }
      return token;
    })
    .join(' + ');
}

function normalizeShortcutText(shortcutText: string) {
  return shortcutText.replace(/\s+/g, '').toLowerCase();
}

function buildShortcutFromKeyEvent(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }

  if (modifiers.length === 0) {
    return null;
  }

  let mainKey = '';
  if (/^F\d{1,2}$/i.test(event.key)) {
    mainKey = event.key.toUpperCase();
  } else if (event.key === ' ') {
    mainKey = 'Space';
  } else if (event.key.startsWith('Arrow')) {
    mainKey = event.key.replace('Arrow', '');
  } else if (event.key.length === 1) {
    mainKey = event.key.toUpperCase();
  } else {
    mainKey = event.key.charAt(0).toUpperCase() + event.key.slice(1);
  }

  return [...modifiers, mainKey].join('+');
}

function getTodoFolderPath(todoFilePath: string) {
  if (!todoFilePath) {
    return '';
  }
  return todoFilePath.replace(/[\\/][^\\/]+$/, '');
}

function formatUsageReset(resetAt: string, locale: SupportedLocale) {
  return translate(locale, 'usage.reset', { time: dayjs(resetAt).format('MM-DD HH:mm') });
}

function TopUsageMetric({ label, usage, locale }: { label: string; usage: CodexUsageWindow; locale: SupportedLocale }) {
  const tone =
    usage.usedPercent >= 90 ? 'var(--danger)' : usage.usedPercent >= 70 ? '#f0a020' : 'var(--accent)';

  const resetText = dayjs(usage.resetAt).format(usage.windowSeconds >= 24 * 60 * 60 ? 'MM-DD' : 'HH:mm');

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1.5"
      role="progressbar"
      aria-label={translate(locale, 'usage.used', { label })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usage.usedPercent}
      title={translate(locale, 'usage.usedDetail', {
        label,
        percent: usage.usedPercent,
        reset: formatUsageReset(usage.resetAt, locale)
      })}
    >
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: tone }} />
      <span className="flex-shrink-0 text-[11px] font-medium text-[var(--text-2)]">{label}</span>
      <span className="h-1 w-9 flex-shrink-0 overflow-hidden rounded-full bg-[var(--line-strong)]">
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{ width: `${usage.usedPercent}%`, background: tone }}
        />
      </span>
      <span className="flex-shrink-0 text-[11px] font-semibold tabular-nums text-[var(--text)]">
        {usage.usedPercent}%
      </span>
      <span className="flex-shrink-0 text-[10px] font-medium tabular-nums text-[var(--text-2)]">{resetText}</span>
    </div>
  );
}

function useSystemDark() {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
  );

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent) => setDark(event.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return dark;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  const [completedOpen, setCompletedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(defaultSettings);
  const [isCapturingShortcut, setIsCapturingShortcut] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [toastText, setToastText] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
  const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

  const systemDark = useSystemDark();
  const locale = state?.resolvedLocale ?? resolveLocale(defaultSettings.language, navigator.language);
  const t = (key: TranslationKey, params?: TranslationParams) => translate(locale, key, params);
  const themeMode: ThemeMode = state?.settings.theme ?? 'light';
  const effectiveTheme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    void window.todoApi.getState().then((appState) => {
      setState(appState);
      setSettingsDraft(appState.settings);
    });
    const offState = window.todoApi.onStateUpdated((next) => {
      setState(next);
      if (!settingsOpen) {
        setSettingsDraft(next.settings);
      }
    });

    const offToast = window.todoApi.onSavedToast((payload) => {
      setToastText(`${payload.text} · ${dayjs(payload.at).format('HH:mm:ss')}`);
      setTimeout(() => setToastText(''), 1300);
    });

    const offOpenSettings = window.todoApi.onOpenSettingsPanel(() => {
      setSettingsOpen(true);
    });

    return () => {
      offState();
      offToast();
      offOpenSettings();
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!state?.settings.showCodexUsage) {
      setCodexUsage(null);
      setUsageRefreshing(false);
      return;
    }

    void refreshCodexUsage();
    const timer = window.setInterval(() => {
      void refreshCodexUsage();
    }, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [state?.settings.showCodexUsage]);

  useEffect(() => {
    if (!isCapturingShortcut) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setIsCapturingShortcut(false);
        return;
      }

      const nextShortcut = buildShortcutFromKeyEvent(event);
      if (!nextShortcut) {
        setToastText(t('shortcut.comboRequired'));
        setTimeout(() => setToastText(''), 1200);
        return;
      }

      setIsCapturingShortcut(false);
      void applyShortcutImmediately(nextShortcut);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isCapturingShortcut]);

  const activeTarget = state?.settings.activeProjectId || INDEPENDENT_TARGET;
  const workspaceView = state?.settings.workspaceView || 'focus';
  const visibleTasks = useMemo(() => {
    const all = state?.tasks ?? [];
    if (workspaceView === 'all') return all;
    return all.filter((task) => activeTarget === INDEPENDENT_TARGET ? !task.projectId : task.projectId === activeTarget);
  }, [state, workspaceView, activeTarget]);
  const openTasks = useMemo(() => visibleTasks.filter((task) => !task.completed), [visibleTasks]);
  const completedTasks = useMemo(() => visibleTasks.filter((task) => task.completed), [visibleTasks]);

  async function refreshCodexUsage() {
    setUsageRefreshing(true);
    try {
      setCodexUsage(await window.todoApi.getCodexUsage());
    } catch {
      setCodexUsage({
        status: 'error',
        message: t('error.codexUsage')
      });
    } finally {
      setUsageRefreshing(false);
    }
  }

  async function refreshState() {
    const next = await window.todoApi.getState();
    setState(next);
    setSettingsDraft(next.settings);
  }

  async function applyShortcutImmediately(nextShortcut: string) {
    try {
      const next = await window.todoApi.updateSettings({
        globalShortcut: nextShortcut
      });
      setState(next);
      setSettingsDraft((prev) => ({
        ...prev,
        globalShortcut: next.settings.globalShortcut
      }));

      const wanted = normalizeShortcutText(formatShortcutForDisplay(nextShortcut, locale));
      const applied = normalizeShortcutText(formatShortcutForDisplay(next.settings.globalShortcut, locale));

      if (wanted === applied) {
        setToastText(t('shortcut.set', { shortcut: formatShortcutForDisplay(next.settings.globalShortcut, locale) }));
      } else {
        setToastText(t('shortcut.fallback', { shortcut: formatShortcutForDisplay(next.settings.globalShortcut, locale) }));
      }
      setTimeout(() => setToastText(''), 1600);
    } catch {
      notifyError(t('shortcut.saveFailed'));
      void refreshState();
    }
  }

  function notifyError(message: string) {
    setToastText(message);
    setTimeout(() => setToastText(''), 1800);
  }

  async function addTask() {
    const text = newTaskText.trim();
    if (!text) {
      return;
    }

    try {
      const next = await window.todoApi.addTaskToProject(text, activeTarget === INDEPENDENT_TARGET ? undefined : activeTarget);
      setState(next);
      setNewTaskText('');
    } catch {
      notifyError(t('error.addTask'));
      void refreshState();
    }
  }

  async function toggleTask(taskId: string, completed: boolean) {
    try {
      setState(await window.todoApi.toggleTask(taskId, completed));
    } catch {
      notifyError(t('error.operation'));
      void refreshState();
    }
  }

  async function deleteTask(taskId: string) {
    try {
      setState(await window.todoApi.deleteTask(taskId));
    } catch {
      notifyError(t('error.deleteTask'));
      void refreshState();
    }
  }

  async function updateTaskText(taskId: string, text: string) {
    try {
      setState(await window.todoApi.updateTaskText(taskId, text));
    } catch {
      notifyError(t('error.saveTask'));
      void refreshState();
    }
  }

  async function updateTaskComment(taskId: string, comment: string) {
    try {
      setState(await window.todoApi.updateTaskComment(taskId, comment));
    } catch {
      notifyError('评语保存失败');
      void refreshState();
    }
  }

  async function updateWorkspace(partial: Partial<Pick<AppSettings, 'activeProjectId' | 'workspaceView'>>) {
    try {
      const next = await window.todoApi.updateSettings(partial);
      setState(next);
      setSettingsDraft(next.settings);
    } catch {
      notifyError('视图设置保存失败');
    }
  }

  async function addProject() {
    const title = window.prompt('项目名称');
    if (!title?.trim()) return;
    setState(await window.todoApi.addProject(title));
  }

  async function renameProject() {
    const project = state?.settings.projects.find((item) => item.id === activeTarget);
    if (!project) return;
    const title = window.prompt('修改项目名称', project.title);
    if (!title?.trim()) return;
    setState(await window.todoApi.updateProject(project.id, title));
  }

  function parseBatch() {
    const existing = new Set(visibleTasks.map((task) => task.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()));
    const seen = new Set<string>();
    const candidates = batchText.split(/\r?\n/).map((line) => {
      const checkbox = line.match(/^\s*[-*+]?\s*\[([ xX])\]\s*(.+)$/);
      const completed = checkbox?.[1].toLowerCase() === 'x';
      const raw = checkbox?.[2] ?? line;
      const text = raw.trim().replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+]\s+|\d+[.)、]\s*|\(\d+\)\s*)/, '').trim();
      if (!text) return null;
      const key = text.replace(/\s+/g, ' ').toLocaleLowerCase();
      const duplicate = existing.has(key) || seen.has(key);
      seen.add(key);
      return { id: crypto.randomUUID(), text, completed, duplicate, selected: !duplicate };
    }).filter((item): item is BatchCandidate => Boolean(item));
    setBatchCandidates(candidates);
  }

  async function importBatch() {
    const entries = batchCandidates.filter((item) => item.selected).map(({ text, completed }) => ({ text, completed }));
    if (!entries.length) return;
    const next = await window.todoApi.batchAddTasks(entries, activeTarget === INDEPENDENT_TARGET ? undefined : activeTarget);
    setState(next);
    setBatchOpen(false);
    setBatchText('');
    setBatchCandidates([]);
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = openTasks.findIndex((task) => task.id === active.id);
    const newIndex = openTasks.findIndex((task) => task.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const reordered = arrayMove(openTasks, oldIndex, newIndex);

    setState((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        tasks: [...reordered, ...completedTasks]
      };
    });

    try {
      const next = await window.todoApi.reorderOpenTasks(reordered.map((task) => task.id));
      setState(next);
    } catch {
      notifyError(t('error.saveOrder'));
      void refreshState();
    }
  }

  async function saveSettings() {
    try {
      const next = await window.todoApi.updateSettings({
        todoFilePath: settingsDraft.todoFilePath,
        globalShortcut: settingsDraft.globalShortcut,
        desktopLockPosition: settingsDraft.desktopLockPosition,
        desktopMouseThrough: settingsDraft.desktopMouseThrough,
        showCodexUsage: settingsDraft.showCodexUsage,
        windowOpacity: settingsDraft.windowOpacity,
        theme: settingsDraft.theme,
        language: settingsDraft.language,
        webdav: settingsDraft.webdav
      });

      setState(next);
      setSettingsDraft(next.settings);
      setSettingsOpen(false);
      setToastText(t('settings.saved'));
      setTimeout(() => setToastText(''), 1200);
    } catch {
      notifyError(t('error.saveSettings'));
    }
  }

  async function selectTodoFolder() {
    setSelectingFolder(true);
    try {
      const pickedTodoPath = await window.todoApi.pickTodoFolder();
      if (pickedTodoPath) {
        setSettingsDraft((prev) => ({
          ...prev,
          todoFilePath: pickedTodoPath
        }));
      }
    } catch {
      notifyError(t('error.pickFolder'));
    } finally {
      setSelectingFolder(false);
    }
  }

  async function toggleAlwaysOnTop(value: boolean) {
    try {
      await window.todoApi.setAlwaysOnTop(value);
      await refreshState();
    } catch {
      notifyError(t('error.windowSettings'));
    }
  }

  async function toggleDesktopPin() {
    try {
      await window.todoApi.togglePinMode();
      await refreshState();
    } catch {
      notifyError(t('error.desktopMode'));
    }
  }

  async function changeTheme(theme: ThemeMode) {
    try {
      const next = await window.todoApi.updateSettings({ theme });
      setState(next);
      setSettingsDraft((prev) => ({ ...prev, theme: next.settings.theme }));
    } catch {
      notifyError(t('error.theme'));
    }
  }

  async function changeLanguage(language: LocalePreference) {
    try {
      const next = await window.todoApi.updateSettings({ language });
      setState(next);
      setSettingsDraft((prev) => ({ ...prev, language: next.settings.language }));
    } catch {
      notifyError(t('error.language'));
    }
  }

  async function runSync() {
    setSyncing(true);
    try {
      const result = await window.todoApi.runSync();
      setToastText(result.message);
      setTimeout(() => setToastText(''), 1500);
    } catch {
      notifyError(t('error.sync'));
    } finally {
      setSyncing(false);
    }
  }

  function updateWebdav<K extends keyof AppSettings['webdav']>(key: K, value: AppSettings['webdav'][K]) {    setSettingsDraft((prev) => ({
      ...prev,
      webdav: {
        ...prev.webdav,
        [key]: value
      }
    }));
  }

  return (
    <div
      data-theme={effectiveTheme}
      style={{ colorScheme: effectiveTheme }}
      className="relative h-screen w-screen overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--bg)] text-[var(--text)]"
    >
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        {/* 顶部品牌栏（可拖拽） */}
        <header className="flex h-10 flex-shrink-0 items-center justify-between px-3" style={dragStyle}>
          <div className="flex items-center gap-2">
            <ApexLogo size={20} />
            <span className="text-[13px] font-semibold tracking-wide">Just Do It</span>
            {state?.settings.desktopPinned && (
              <span className="h-2 w-2 rounded-full bg-[var(--success)]" title={t('window.pinned')} />
            )}
          </div>
          <div className="flex items-center gap-0.5" style={noDragStyle}>
            <button
              className="ghost-icon"
              onClick={() => void changeTheme(effectiveTheme === 'dark' ? 'light' : 'dark')}
              title={t(effectiveTheme === 'dark' ? 'window.switchLight' : 'window.switchDark')}
            >
              {effectiveTheme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </button>
            <button className="ghost-icon" onClick={() => setSettingsOpen((v) => !v)} title={t('common.settings')}>
              <SettingsIcon size={15} />
            </button>
            <button className="ghost-icon" onClick={() => void window.todoApi.minimizeWindow()} title={t('common.minimize')}>
              <MinusIcon size={15} />
            </button>
            <button className="ghost-icon danger" onClick={() => void window.todoApi.closeWindow()} title={t('common.exit')}>
              <CloseIcon size={15} />
            </button>
          </div>
        </header>

        {state?.settings.showCodexUsage && (
          <div className="mx-3 mb-1.5 flex items-center gap-2">
            {codexUsage?.status === 'ready' && (codexUsage.fiveHour || codexUsage.weekly) ? (
              <>
                {codexUsage.fiveHour && (
                  <TopUsageMetric label={t('usage.fiveHours')} usage={codexUsage.fiveHour} locale={locale} />
                )}
                {codexUsage.weekly && (
                  <TopUsageMetric label={t('usage.week')} usage={codexUsage.weekly} locale={locale} />
                )}
              </>
            ) : (
              <p
                className={`min-w-0 flex-1 truncate text-[11px] ${codexUsage?.status === 'error' ? 'text-rose-500' : 'text-[var(--text-2)]'}`}
                title={codexUsage?.message || t('usage.loadingTitle')}
              >
                {usageRefreshing ? t('usage.loading') : codexUsage?.message || t('usage.unavailable')}
              </p>
            )}
            <button
              type="button"
              className="ghost-icon !h-6 !w-6 flex-shrink-0"
              onClick={() => void refreshCodexUsage()}
              disabled={usageRefreshing}
              title={codexUsage?.fetchedAt
                ? t('usage.updatedAt', { time: dayjs(codexUsage.fetchedAt).format('HH:mm:ss') })
                : t('usage.refresh')}
              aria-label={t('usage.refresh')}
            >
              <RefreshIcon size={12} className={usageRefreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* 副标题 */}
        <div className="flex items-center justify-between px-3 pb-1 text-[11px] text-[var(--text-3)]">
          <span className="tabular-nums">{dayjs().format('MM-DD HH:mm')}</span>
          <span>{t('task.count', { count: openTasks.length })}</span>
        </div>

        <div className="mx-3 mb-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2" style={noDragStyle}>
          <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-[var(--surface-2)] p-1">
            <button className={`rounded px-2 py-1 text-[11px] ${workspaceView === 'focus' ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-2)]'}`} onClick={() => void updateWorkspace({ workspaceView: 'focus' })}>专注视图</button>
            <button className={`rounded px-2 py-1 text-[11px] ${workspaceView === 'all' ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-2)]'}`} onClick={() => void updateWorkspace({ workspaceView: 'all' })}>全部视图</button>
          </div>
          <div className="flex items-center gap-1.5">
            <select className="field min-w-0 flex-1 !py-1.5 text-[12px]" value={activeTarget} onChange={(event) => void updateWorkspace({ activeProjectId: event.target.value === INDEPENDENT_TARGET ? '' : event.target.value })}>
              {state?.settings.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
              <option value={INDEPENDENT_TARGET}>独立任务</option>
            </select>
            <button className="ghost-text !px-2 !py-1 text-[11px]" onClick={() => void addProject()}>+ 项目</button>
            {activeTarget !== INDEPENDENT_TARGET && <button className="ghost-text !px-1 !py-1 text-[11px]" onClick={() => void renameProject()}>改名</button>}
          </div>
        </div>

        {/* 命令式输入 */}
        <div className="flex-shrink-0 px-3 pb-3 pt-1">
          <div className="group/input flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 transition-all duration-200 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <PlusIcon size={15} className="flex-shrink-0 text-[var(--text-3)] transition-colors group-focus-within/input:text-[var(--accent)]" />
            <input
              value={newTaskText}
              onChange={(event) => setNewTaskText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void addTask();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)]"
              placeholder={t('task.addPlaceholder')}
            />
            <kbd className="hidden flex-shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[9px] text-[var(--text-3)] sm:block">
              Enter
            </kbd>
          </div>
        </div>

        {/* 任务列表 */}
        <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void onDragEnd(event)}>
            <SortableContext items={openTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-2.5">
                {openTasks.map((task) => (
                  <SortableTaskItem
                    key={task.id}
                    task={task}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                    onUpdateText={updateTaskText}
                    onUpdateComment={updateTaskComment}
                    projectTitle={workspaceView === 'all' ? state?.settings.projects.find((project) => project.id === task.projectId)?.title || '独立任务' : undefined}
                    locale={locale}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {openTasks.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-2)] text-[var(--text-3)]">
                <CheckIcon size={18} />
              </span>
              <p className="text-xs text-[var(--text-3)]">{t('task.empty')}</p>
            </div>
          )}

          {completedTasks.length > 0 && (
            <div className="mt-1">
              <button
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]"
                onClick={() => setCompletedOpen((v) => !v)}
              >
                <ChevronDownIcon
                  size={13}
                  className={`transition-transform duration-300 ${completedOpen ? 'rotate-180' : ''}`}
                />
                <span>{t('task.completed', { count: completedTasks.length })}</span>
              </button>

              <div
                className={`overflow-hidden transition-all duration-300 ${
                  completedOpen ? 'max-h-[40vh] opacity-100' : 'max-h-0 opacity-0'
                }`}
              >
                <div className="flex max-h-[40vh] flex-col gap-2.5 overflow-auto">
                  {completedTasks.map((task: TodoItem) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-2)]"
                    >
                      <button
                        type="button"
                        onClick={() => void toggleTask(task.id, false)}
                        title={t('task.markIncomplete')}
                        className="grid h-[18px] w-[18px] flex-shrink-0 place-items-center self-center rounded-full border border-[var(--success)] bg-[var(--success)] text-[var(--bg)]"
                      >
                        <CheckIcon size={11} strokeWidth={3} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] leading-[18px] text-[var(--text-3)] line-through">{task.text}</p>
                        {task.comment && <p className="mt-1 line-clamp-2 text-[11px] text-[var(--text-3)]">{task.comment}</p>}
                      </div>
                      <span
                        className="flex-shrink-0 text-[10px] tabular-nums text-[var(--text-3)]"
                        title={dayjs(task.createdAt).isValid() ? dayjs(task.createdAt).format('YYYY-MM-DD HH:mm') : task.createdAt}
                      >
                        {dayjs(task.createdAt).isValid()
                          ? dayjs(task.createdAt).isSame(dayjs(), 'day')
                            ? dayjs(task.createdAt).format('HH:mm')
                            : dayjs(task.createdAt).format('MM-DD')
                          : task.createdAt}
                      </span>
                      <button
                        className="ghost-icon danger !h-7 !w-7 flex-shrink-0 text-[var(--text-3)]"
                        onClick={() => void deleteTask(task.id)}
                        title={t('task.delete')}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>

        <div className="flex-shrink-0 border-t border-[var(--line)] p-3">
          <button className="btn-primary w-full" onClick={() => setBatchOpen(true)}>批量粘贴 + 解析</button>
        </div>

        {batchOpen && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-3" style={noDragStyle}>
            <section className="flex max-h-[88vh] w-full flex-col rounded-xl border border-[var(--line)] bg-[var(--bg)] p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <div><p className="text-sm font-semibold">批量导入</p><p className="text-[11px] text-[var(--text-3)]">支持编号、Markdown 和复选框；重复项默认跳过</p></div>
                <button className="ghost-icon" onClick={() => setBatchOpen(false)}><CloseIcon size={15} /></button>
              </div>
              <textarea className="field min-h-[120px] resize-y text-[12px]" value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'1. 完成需求梳理\n- [ ] 完成界面开发\n- [x] 建立测试清单'} />
              <button className="btn-primary mt-2" onClick={parseBatch}>解析预览</button>
              {batchCandidates.length > 0 && (
                <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {batchCandidates.map((item) => (
                    <label key={item.id} className="flex items-start gap-2 rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[12px]">
                      <input type="checkbox" checked={item.selected} onChange={(event) => setBatchCandidates((prev) => prev.map((candidate) => candidate.id === item.id ? { ...candidate, selected: event.target.checked } : candidate))} />
                      <span className="min-w-0 flex-1">{item.text}{item.duplicate && <small className="ml-2 text-[var(--text-3)]">重复，默认跳过</small>}</span>
                    </label>
                  ))}
                </div>
              )}
              <button className="btn-primary mt-3" disabled={!batchCandidates.some((item) => item.selected)} onClick={() => void importBatch()}>导入已选择任务</button>
            </section>
          </div>
        )}

        {/* 设置面板 */}
        {settingsOpen && (
          <section className="settings-panel">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-sm font-semibold">{t('common.settings')}</p>
              <button className="ghost-icon" onClick={() => setSettingsOpen(false)} title={t('common.close')}>
                <CloseIcon size={15} />
              </button>
            </div>

            <p className="setting-group-label">{t('settings.windowDesktop')}</p>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.alwaysOnTop')}</div>
              </div>
              <input
                type="checkbox"
                className="toggle"
                checked={state?.settings.alwaysOnTop ?? true}
                disabled={state?.settings.desktopPinned ?? false}
                onChange={(event) => void toggleAlwaysOnTop(event.target.checked)}
              />
            </div>
            <div className="setting-row">
              <div className="setting-label">{t('settings.desktopEmbed')}</div>
              <input
                type="checkbox"
                className="toggle"
                checked={state?.settings.desktopPinned ?? false}
                onChange={() => void toggleDesktopPin()}
              />
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.lockPosition')}</div>
                <div className="setting-hint">{t('settings.desktopOnly')}</div>
              </div>
              <input
                type="checkbox"
                className="toggle"
                checked={settingsDraft.desktopLockPosition}
                disabled={!(state?.settings.desktopPinned ?? false)}
                onChange={(event) => setSettingsDraft((prev) => ({ ...prev, desktopLockPosition: event.target.checked }))}
              />
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.mouseThrough')}</div>
                <div className="setting-hint">{t('settings.mouseThroughHint')}</div>
              </div>
              <input
                type="checkbox"
                className="toggle"
                checked={settingsDraft.desktopMouseThrough}
                disabled={!(state?.settings.desktopPinned ?? false)}
                onChange={(event) => setSettingsDraft((prev) => ({ ...prev, desktopMouseThrough: event.target.checked }))}
              />
            </div>
            <p className="setting-group-label">{t('settings.codexUsage')}</p>
            <div className="setting-row">
              <div>
                <div className="setting-label">{t('settings.showCodexUsage')}</div>
                <div className="setting-hint">{t('settings.showCodexUsageHint')}</div>
              </div>
              <input
                type="checkbox"
                className="toggle"
                checked={settingsDraft.showCodexUsage}
                onChange={(event) => setSettingsDraft((prev) => ({ ...prev, showCodexUsage: event.target.checked }))}
              />
            </div>

            <p className="setting-group-label">{t('settings.appearance')}</p>
            <div className="setting-row">
              <div className="setting-label">{t('settings.themeMode')}</div>
              <div className="theme-seg">
                {(
                  [
                    { value: 'light', label: t('settings.themeLight') },
                    { value: 'dark', label: t('settings.themeDark') },
                    { value: 'system', label: t('settings.followSystem') }
                  ] as { value: ThemeMode; label: string }[]
                ).map((option) => (
                  <button
                    key={option.value}
                    className={themeMode === option.value ? 'active' : ''}
                    onClick={() => void changeTheme(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label">{t('settings.language')}</div>
              <div className="theme-seg">
                {(
                  [
                    { value: 'system', label: t('settings.followSystem') },
                    { value: 'zh-CN', label: t('settings.languageChinese') },
                    { value: 'en-US', label: t('settings.languageEnglish') }
                  ] as { value: LocalePreference; label: string }[]
                ).map((option) => (
                  <button
                    key={option.value}
                    className={settingsDraft.language === option.value ? 'active' : ''}
                    onClick={() => void changeLanguage(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-label">{t('settings.opacity')}</div>
              <div className="flex w-1/2 items-center gap-2">
                <input
                  type="range"
                  className="slider"
                  min={35}
                  max={100}
                  value={Math.round((settingsDraft.windowOpacity ?? 0.96) * 100)}
                  onChange={(event) =>
                    setSettingsDraft((prev) => ({
                      ...prev,
                      windowOpacity: Number(event.target.value) / 100
                    }))
                  }
                />
                <span className="w-9 text-right text-[11px] tabular-nums text-[var(--text-2)]">
                  {Math.round((settingsDraft.windowOpacity ?? 0.96) * 100)}%
                </span>
              </div>
            </div>

            <p className="setting-group-label">{t('settings.shortcuts')}</p>
            <div className="setting-row">
              <div className="flex items-center gap-2 setting-label">
                <KeyboardIcon size={14} className="text-[var(--text-2)]" />
                {t('settings.captureHotkey')}
              </div>
              <button className="ghost-text" onClick={() => setIsCapturingShortcut(true)}>
                {isCapturingShortcut
                  ? t('shortcut.pressCombo')
                  : formatShortcutForDisplay(settingsDraft.globalShortcut, locale)}
              </button>
            </div>

            <p className="setting-group-label">{t('settings.storage')}</p>
            <div className="setting-row">
              <div className="flex items-center gap-2 setting-label">
                <FolderIcon size={14} className="text-[var(--text-2)]" />
                {t('settings.todoFolder')}
              </div>
              <button className="ghost-text" onClick={() => void selectTodoFolder()} disabled={selectingFolder}>
                {selectingFolder ? t('settings.selecting') : t('settings.selectFolder')}
              </button>
            </div>
            <p className="break-all px-1 pb-1 text-[11px] text-[var(--text-3)]">
              {getTodoFolderPath(settingsDraft.todoFilePath) || t('settings.defaultPath')}
            </p>

            <p className="setting-group-label flex items-center gap-1.5">
              <CloudIcon size={12} /> {t('settings.webdavSync')}
            </p>
            <div className="setting-row">
              <div className="setting-label">{t('settings.enableWebdav')}</div>
              <input
                type="checkbox"
                className="toggle"
                checked={settingsDraft.webdav.enabled}
                onChange={(event) => updateWebdav('enabled', event.target.checked)}
              />
            </div>
            <div className="mt-2 space-y-2">
              <input value={settingsDraft.webdav.url} onChange={(event) => updateWebdav('url', event.target.value)} className="field" placeholder={t('settings.webdavUrl')} />
              <div className="grid grid-cols-2 gap-2">
                <input value={settingsDraft.webdav.username} onChange={(event) => updateWebdav('username', event.target.value)} className="field" placeholder={t('settings.username')} />
                <input value={settingsDraft.webdav.password} onChange={(event) => updateWebdav('password', event.target.value)} className="field" placeholder={t('settings.password')} type="password" />
              </div>
              <input value={settingsDraft.webdav.remotePath} onChange={(event) => updateWebdav('remotePath', event.target.value)} className="field" placeholder={t('settings.remotePath')} />
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 text-[var(--text-2)]">{t('settings.syncInterval')}</span>
                <input
                  value={String(settingsDraft.webdav.intervalMinutes || 60)}
                  onChange={(event) => updateWebdav('intervalMinutes', Math.max(1, Number(event.target.value) || 60))}
                  className="field !w-24"
                  type="number"
                  min={1}
                />
                <span className="text-[var(--text-3)]">{t('settings.minutes')}</span>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <button className="btn-primary flex-1" onClick={() => void saveSettings()}>
                {t('settings.save')}
              </button>
              <button className="ghost-text flex-1 justify-center" onClick={() => void runSync()} disabled={syncing}>
                <RefreshIcon size={13} className={syncing ? 'animate-spin' : ''} />
                {syncing ? t('settings.syncing') : t('settings.syncNow')}
              </button>
            </div>

            <p className="mt-2.5 text-[11px] text-[var(--text-3)]">
              {t('settings.lastSync', {
                time: state?.lastSyncTime ? dayjs(state.lastSyncTime).format('MM-DD HH:mm:ss') : t('common.none'),
                message: state?.syncMessage ?? t('common.notStarted')
              })}
            </p>
          </section>
        )}

        {toastText && <div className="toast-chip">{toastText}</div>}
      </div>
    </div>
  );
}
