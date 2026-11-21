import { TodoItem } from '../shared/types';

export interface BatchImportTask {
  text: string;
  completed: boolean;
}

export interface BatchImportCandidate extends BatchImportTask {
  duplicate: boolean;
  selected: boolean;
}

const CHECKBOX_LINE = /^(?:(?:[-*+] |\d+[.)、]\s*|\(\d+\)\s*))?\[([ xX])\]\s+(.+)$/;
const LIST_PREFIX = /^(?:[-*+]\s+|\d+[.)、]\s*|\(\d+\)\s*)/;

export function normalizeTaskText(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function parseBatchTaskText(input: string): BatchImportTask[] {
  const parsed: BatchImportTask[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === '```' || /^#{1,6}\s+/.test(line)) {
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX_LINE);
    const completed = checkboxMatch ? checkboxMatch[1].toLowerCase() === 'x' : false;
    const text = (checkboxMatch ? checkboxMatch[2] : line.replace(LIST_PREFIX, ''))
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      parsed.push({ text, completed });
    }
  }

  return parsed;
}

export function createBatchImportPreview(
  input: string,
  existingTasks: Pick<TodoItem, 'text'>[]
): BatchImportCandidate[] {
  const seen = new Set(existingTasks.map((task) => normalizeTaskText(task.text)));

  return parseBatchTaskText(input).map((task) => {
    const key = normalizeTaskText(task.text);
    const duplicate = seen.has(key);
    seen.add(key);
    return {
      ...task,
      duplicate,
      selected: !duplicate
    };
  });
}
