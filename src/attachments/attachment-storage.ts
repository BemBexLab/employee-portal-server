import * as path from 'path';
import { randomUUID } from 'crypto';

const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const ALLOWED_EXTENSIONS = new Set<string>([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.ppt',
  '.pptx',
]);

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 5;
export const ATTACHMENT_TTL_MS = 1000 * 60 * 60 * 24 * 2;

export type StoredAttachment = {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
};

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replaceAll(/[^\w.\- ]+/g, '_');
  return base.length > 0 ? base : 'file';
}

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return '';
  return name.slice(idx).toLowerCase();
}

export function isAllowedAttachment(
  originalName: string,
  mimeType: string,
): boolean {
  const ext = getExtension(originalName);
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) return false;
  return true;
}

export function saveAttachment(
  originalName: string,
  mimeType: string,
  data: Buffer,
): StoredAttachment {
  if (data.length > MAX_FILE_SIZE_BYTES) {
    throw new Error('File exceeds the 10 MB limit.');
  }
  if (!isAllowedAttachment(originalName, mimeType)) {
    throw new Error('File type is not supported.');
  }
  const safeName = sanitizeFilename(originalName);
  const storedName = `${randomUUID()}-${safeName}`;
  return {
    originalName: safeName,
    storedName,
    mimeType,
    sizeBytes: data.length,
    content: data,
  };
}

export function computeExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + ATTACHMENT_TTL_MS);
}
