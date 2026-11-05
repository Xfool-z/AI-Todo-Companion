/// <reference types="vite/client" />

import { AppSettings, AppState, CaptureResult, CodexUsage, SaveToastPayload } from '../shared/types';

declare global {
  interface Window {
    todoApi: {
      getState: () => Promise<AppState>;
      getCodexUsage: () => Promise<CodexUsage>;
      addTask: (text: string) => Promise<AppState>;
      addTaskToProject: (text: string, projectId?: string) => Promise<AppState>;
      batchAddTasks: (entries: Array<{ text: string; completed: boolean }>, projectId?: string) => Promise<AppState>;
      toggleTask: (taskId: string, completed: boolean) => Promise<AppState>;
      deleteTask: (taskId: string) => Promise<AppState>;
      updateTaskText: (taskId: string, text: string) => Promise<AppState>;
      updateTaskComment: (taskId: string, comment: string) => Promise<AppState>;
      addProject: (title: string) => Promise<AppState>;
      updateProject: (projectId: string, title: string) => Promise<AppState>;
      deleteProject: (projectId: string) => Promise<AppState>;
      reorderOpenTasks: (orderedOpenIds: string[]) => Promise<AppState>;
      captureTask: () => Promise<CaptureResult>;
      updateSettings: (partial: Partial<AppSettings>) => Promise<AppState>;
      pickTodoFolder: () => Promise<string | null>;
      togglePinMode: () => Promise<AppSettings>;
      setAlwaysOnTop: (value: boolean) => Promise<AppSettings>;
      runSync: () => Promise<{ ok: boolean; message: string }>;
      minimizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      onStateUpdated: (handler: (state: AppState) => void) => () => void;
      onSavedToast: (handler: (payload: SaveToastPayload) => void) => () => void;
      onOpenSettingsPanel: (handler: () => void) => () => void;
    };
  }
}

export {};
