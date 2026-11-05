import { contextBridge, ipcRenderer } from 'electron';
import { AppSettings, AppState, CaptureResult, CodexUsage, SaveToastPayload } from '../shared/types';

const api = {
  getState: () => ipcRenderer.invoke('app:get-state') as Promise<AppState>,
  getCodexUsage: () => ipcRenderer.invoke('codex:get-usage') as Promise<CodexUsage>,
  addTask: (text: string) => ipcRenderer.invoke('task:add', text) as Promise<AppState>,
  addTaskToProject: (text: string, projectId?: string) => ipcRenderer.invoke('task:add-to-project', text, projectId) as Promise<AppState>,
  batchAddTasks: (entries: Array<{ text: string; completed: boolean }>, projectId?: string) =>
    ipcRenderer.invoke('tasks:batch-add', entries, projectId) as Promise<AppState>,
  toggleTask: (taskId: string, completed: boolean) => ipcRenderer.invoke('task:toggle', taskId, completed) as Promise<AppState>,
  deleteTask: (taskId: string) => ipcRenderer.invoke('task:delete', taskId) as Promise<AppState>,
  updateTaskText: (taskId: string, text: string) =>
    ipcRenderer.invoke('task:update-text', taskId, text) as Promise<AppState>,
  updateTaskComment: (taskId: string, comment: string) =>
    ipcRenderer.invoke('task:update-comment', taskId, comment) as Promise<AppState>,
  addProject: (title: string) => ipcRenderer.invoke('project:add', title) as Promise<AppState>,
  updateProject: (projectId: string, title: string) => ipcRenderer.invoke('project:update', projectId, title) as Promise<AppState>,
  deleteProject: (projectId: string) => ipcRenderer.invoke('project:delete', projectId) as Promise<AppState>,
  reorderOpenTasks: (orderedOpenIds: string[]) =>
    ipcRenderer.invoke('task:reorder-open', orderedOpenIds) as Promise<AppState>,
  captureTask: () => ipcRenderer.invoke('task:capture') as Promise<CaptureResult>,
  updateSettings: (partial: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', partial) as Promise<AppState>,
  pickTodoFolder: () => ipcRenderer.invoke('settings:pick-todo-folder') as Promise<string | null>,
  togglePinMode: () => ipcRenderer.invoke('window:toggle-pin-mode') as Promise<AppSettings>,
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:set-always-on-top', value) as Promise<AppSettings>,
  runSync: () => ipcRenderer.invoke('sync:run') as Promise<{ ok: boolean; message: string }>,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onStateUpdated: (handler: (state: AppState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => handler(state);
    ipcRenderer.on('state:updated', wrapped);
    return () => ipcRenderer.removeListener('state:updated', wrapped);
  },
  onSavedToast: (handler: (payload: SaveToastPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: SaveToastPayload) => handler(payload);
    ipcRenderer.on('task:saved-toast', wrapped);
    return () => ipcRenderer.removeListener('task:saved-toast', wrapped);
  },
  onOpenSettingsPanel: (handler: () => void) => {
    const wrapped = () => handler();
    ipcRenderer.on('window:open-settings-panel', wrapped);
    return () => ipcRenderer.removeListener('window:open-settings-panel', wrapped);
  }
};

contextBridge.exposeInMainWorld('todoApi', api);
