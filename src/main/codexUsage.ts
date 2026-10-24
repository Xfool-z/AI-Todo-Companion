import { app, net } from 'electron';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexUsage, CodexUsageWindow } from '../shared/types';
import { SupportedLocale, translate } from './i18n';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 12_000;
const REQUEST_RETRY_DELAY_MS = 750;
const REQUEST_ATTEMPTS = 2;

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface RawUsageWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface RawUsageResponse {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: RawUsageWindow;
    secondary_window?: RawUsageWindow;
  };
}

function unavailable(message: string): CodexUsage {
  return {
    status: 'unavailable',
    message
  };
}

function normalizeWindow(raw: RawUsageWindow | undefined): CodexUsageWindow | undefined {
  if (!raw) {
    return undefined;
  }

  const usedPercent = Number(raw.used_percent);
  const windowSeconds = Number(raw.limit_window_seconds);
  const resetAtSeconds = Number(raw.reset_at);

  if (![usedPercent, windowSeconds, resetAtSeconds].every(Number.isFinite)) {
    return undefined;
  }

  return {
    usedPercent: Math.min(100, Math.max(0, Math.round(usedPercent))),
    windowSeconds,
    resetAt: new Date(resetAtSeconds * 1000).toISOString()
  };
}

function resolveWindows(raw: RawUsageResponse) {
  const windows = [
    normalizeWindow(raw.rate_limit?.primary_window),
    normalizeWindow(raw.rate_limit?.secondary_window)
  ].filter((window): window is CodexUsageWindow => Boolean(window));

  return {
    fiveHour: windows.find((window) => window.windowSeconds >= 4 * 60 * 60 && window.windowSeconds <= 6 * 60 * 60),
    weekly: windows.find(
      (window) => window.windowSeconds >= 6 * 24 * 60 * 60 && window.windowSeconds <= 8 * 24 * 60 * 60
    )
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchUsage(headers: Record<string, string>) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // Electron's Chromium network stack follows the Windows/system proxy.
      // Node's global fetch does not, which breaks common mihomo/Clash setups.
      return await net.fetch(CODEX_USAGE_URL, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal
      });
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_ATTEMPTS) {
        await delay(REQUEST_RETRY_DELAY_MS);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export async function getCodexUsage(locale: SupportedLocale): Promise<CodexUsage> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(translate(locale, code === 'ENOENT' ? 'usage.noAuth' : 'usage.readAuthFailed'));
  }

  const accessToken = auth.tokens?.access_token?.trim();
  if (!accessToken) {
    return unavailable(translate(locale, 'usage.unsupportedAuth'));
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `ApexTodo/${app.getVersion()}`
  };
  const accountId = auth.tokens?.account_id?.trim();
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  try {
    const response = await fetchUsage(headers);

    if (response.status === 401 || response.status === 403) {
      return unavailable(translate(locale, 'usage.authExpired'));
    }
    if (!response.ok) {
      return {
        status: 'error',
        message: translate(locale, 'usage.serviceUnavailable', { status: response.status })
      };
    }

    const raw = (await response.json()) as RawUsageResponse;
    const { fiveHour, weekly } = resolveWindows(raw);
    if (!fiveHour && !weekly) {
      return unavailable(translate(locale, 'usage.missingWindows'));
    }

    return {
      status: 'ready',
      planType: typeof raw.plan_type === 'string' ? raw.plan_type : undefined,
      fiveHour,
      weekly,
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      message:
        (error as Error).name === 'AbortError'
          ? translate(locale, 'usage.timeout')
          : translate(locale, 'usage.connectionFailed')
    };
  }
}
