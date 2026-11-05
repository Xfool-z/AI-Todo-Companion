import dayjs from 'dayjs';
import { randomUUID } from 'node:crypto';
import { TodoItem } from '../shared/types';

const TASK_LINE_REGEX = /^- \[( |x|X)\]\s+(.*)$/;
const TIMESTAMP_SUFFIX_REGEX = /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)\s*$/;
const METADATA_LINE_REGEX = /^\s*<!--\s*just-do-it:([A-Za-z0-9+/=]+)\s*-->\s*$/;

export function parseMarkdownTasks(content: string): TodoItem[] {
  const lines = content.split(/\r?\n/);
  const tasks: TodoItem[] = [];

  for (const line of lines) {
    const metadataMatch = line.match(METADATA_LINE_REGEX);
    if (metadataMatch && tasks.length > 0) {
      try {
        const metadata = JSON.parse(Buffer.from(metadataMatch[1], 'base64').toString('utf8')) as {
          projectId?: unknown;
          comment?: unknown;
        };
        const task = tasks[tasks.length - 1];
        if (typeof metadata.projectId === 'string' && metadata.projectId) task.projectId = metadata.projectId;
        if (typeof metadata.comment === 'string' && metadata.comment) task.comment = metadata.comment;
      } catch {
        // Ignore malformed metadata while keeping the readable Markdown task.
      }
      continue;
    }

    const match = line.match(TASK_LINE_REGEX);
    if (!match) {
      continue;
    }

    const completed = match[1].toLowerCase() === 'x';
    const rawText = match[2].trim();
    const timestampMatch = rawText.match(TIMESTAMP_SUFFIX_REGEX);

    let createdAt = dayjs().format('YYYY-MM-DD HH:mm');
    let text = rawText;

    if (timestampMatch) {
      createdAt = timestampMatch[1];
      text = rawText.replace(TIMESTAMP_SUFFIX_REGEX, '').trim();
    }

    tasks.push({
      id: randomUUID(),
      text,
      completed,
      createdAt
    });
  }

  return tasks;
}

export function stringifyMarkdownTasks(tasks: TodoItem[]): string {
  return tasks
    .map((task) => {
      const checked = task.completed ? 'x' : ' ';
      const line = `- [${checked}] ${task.text} (${task.createdAt})`;
      const metadata = {
        ...(task.projectId ? { projectId: task.projectId } : {}),
        ...(task.comment ? { comment: task.comment } : {})
      };
      if (Object.keys(metadata).length === 0) return line;
      return `${line}\n<!-- just-do-it:${Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64')} -->`;
    })
    .join('\n')
    .trim();
}

export function createTaskFromText(text: string): TodoItem {
  return {
    id: randomUUID(),
    text: text.replace(/\s+/g, ' ').trim(),
    completed: false,
    createdAt: dayjs().format('YYYY-MM-DD HH:mm')
  };
}
