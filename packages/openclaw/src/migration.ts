/**
 * Migration utility — imports files into Keyoku.
 *
 * Recursively discovers files (md, txt, json, yaml), chunks them by format,
 * deduplicates against existing Keyoku memories, and stores each chunk.
 *
 * Usage: `openclaw memory import --dir /path/to/workspace`
 */

import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from 'fs';
import { join, extname, relative } from 'path';
import yaml from 'js-yaml';
import type { KeyokuClient } from '@keyoku/memory';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

export interface MemoryChunk {
  content: string;
  source: string; // original filename
  section?: string; // heading text or key name
}

export interface DiscoverOptions {
  depth?: number; // max recursion depth (default: 5, 0 = no recursion, -1 = unlimited)
  types?: string[]; // file extensions to include (default: ['.md', '.txt', '.json', '.yaml', '.yml'])
}

const DEFAULT_TYPES = ['.md', '.txt', '.json', '.yaml', '.yml'];
const DEFAULT_DEPTH = 5;

/** Directories to always skip during recursive discovery. */
const SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
]);

/**
 * Recursively discover files matching the given extensions.
 * Skips dotfiles/dotdirs, node_modules, symlinks, and other non-content dirs.
 */
export function discoverFiles(
  dir: string,
  options: DiscoverOptions = {},
): { path: string; name: string }[] {
  const maxDepth = options.depth ?? DEFAULT_DEPTH;
  const types = options.types ?? DEFAULT_TYPES;
  const results: { path: string; name: string }[] = [];

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return results;
  }

  function walk(currentDir: string, currentDepth: number): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip dotfiles and dotdirs
      if (entry.startsWith('.')) continue;

      const fullPath = join(currentDir, entry);

      // Skip symlinks
      try {
        if (lstatSync(fullPath).isSymbolicLink()) continue;
      } catch {
        continue;
      }

      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip denied directories
        if (SKIP_DIRS.has(entry)) continue;

        // Recurse if within depth limit
        if (maxDepth === -1 || currentDepth < maxDepth) {
          walk(fullPath, currentDepth + 1);
        }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (types.includes(ext)) {
          results.push({
            path: fullPath,
            name: relative(dir, fullPath),
          });
        }
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Split markdown content by ## or ### headings.
 * Each heading section becomes one chunk.
 * If no headings, split by --- separators or paragraphs.
 */
export function chunkByHeadings(content: string, maxChunkChars = 1000): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];

  // Try splitting by headings first
  const headingPattern = /^#{2,3}\s+(.+)$/gm;
  const headings: { index: number; title: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(content)) !== null) {
    headings.push({ index: match.index, title: match[1].trim() });
  }

  if (headings.length > 0) {
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
      const sectionText = content.slice(start, end).trim();

      if (sectionText.length < 10) continue;

      // If section is too long, split by paragraphs
      if (sectionText.length > maxChunkChars) {
        const paragraphs = splitByParagraphs(sectionText, maxChunkChars);
        for (const p of paragraphs) {
          chunks.push({ content: p, source: '', section: headings[i].title });
        }
      } else {
        chunks.push({ content: sectionText, source: '', section: headings[i].title });
      }
    }

    // Content before the first heading
    const preamble = content.slice(0, headings[0].index).trim();
    if (preamble.length >= 10) {
      const paragraphs = splitByParagraphs(preamble, maxChunkChars);
      for (const p of paragraphs) {
        chunks.push({ content: p, source: '' });
      }
    }
  } else {
    // No headings — try --- separators
    const sections = content.split(/^---+$/m);
    if (sections.length > 1) {
      for (const section of sections) {
        const trimmed = section.trim();
        if (trimmed.length < 10) continue;
        const paragraphs = splitByParagraphs(trimmed, maxChunkChars);
        for (const p of paragraphs) {
          chunks.push({ content: p, source: '' });
        }
      }
    } else {
      // No structure — split by paragraphs
      const paragraphs = splitByParagraphs(content, maxChunkChars);
      for (const p of paragraphs) {
        chunks.push({ content: p, source: '' });
      }
    }
  }

  return chunks;
}

/**
 * Split text by double-newline (paragraphs), merging small paragraphs
 * and splitting oversized ones.
 */
export function splitByParagraphs(text: string, maxChars = 1000): string[] {
  const rawParagraphs = text.split(/\n\n+/);
  const results: string[] = [];
  let buffer = '';

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (buffer.length + trimmed.length + 2 <= maxChars) {
      buffer = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    } else {
      if (buffer) results.push(buffer);
      if (trimmed.length > maxChars) {
        // Hard split at maxChars boundary
        for (let i = 0; i < trimmed.length; i += maxChars) {
          results.push(trimmed.slice(i, i + maxChars));
        }
        buffer = '';
      } else {
        buffer = trimmed;
      }
    }
  }

  if (buffer && buffer.length >= 10) results.push(buffer);
  return results;
}

/**
 * Chunk plain text by paragraphs.
 */
export function chunkPlainText(content: string, maxChunkChars = 1000): MemoryChunk[] {
  const paragraphs = splitByParagraphs(content, maxChunkChars);
  return paragraphs.map((p) => ({ content: p, source: '' }));
}

/**
 * Chunk JSON content by top-level keys (object) or items (array).
 * Returns empty array on parse failure.
 */
export function chunkJson(
  content: string,
  maxChunkChars = 1000,
  logger?: { warn: (msg: string) => void },
): MemoryChunk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger?.warn(`Invalid JSON: ${String(err)}`);
    return [];
  }

  return chunkStructuredData(parsed, maxChunkChars);
}

/**
 * Chunk YAML content by top-level keys. Supports multi-document YAML.
 * Returns empty array on parse failure.
 */
export function chunkYaml(
  content: string,
  maxChunkChars = 1000,
  logger?: { warn: (msg: string) => void },
): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];

  try {
    const docs: unknown[] = [];
    yaml.loadAll(content, (doc) => docs.push(doc));

    for (const doc of docs) {
      chunks.push(...chunkStructuredData(doc, maxChunkChars));
    }
  } catch (err) {
    logger?.warn(`Invalid YAML: ${String(err)}`);
    return [];
  }

  return chunks;
}

/**
 * Chunk a parsed structured value (object or array) into MemoryChunks.
 */
function chunkStructuredData(data: unknown, maxChunkChars: number): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const value = typeof data[i] === 'string' ? data[i] : JSON.stringify(data[i], null, 2);
      const parts = hardSplit(value, maxChunkChars);
      for (const part of parts) {
        chunks.push({ content: part, source: '', section: `[${i}]` });
      }
    }
  } else if (data !== null && typeof data === 'object') {
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      const value = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      const parts = hardSplit(value, maxChunkChars);
      for (const part of parts) {
        chunks.push({ content: part, source: '', section: key });
      }
    }
  } else if (data !== null && data !== undefined) {
    const value = String(data);
    if (value.length >= 10) {
      chunks.push({ content: value, source: '' });
    }
  }

  return chunks;
}

/**
 * Split a string into parts of at most maxChars each.
 * Returns the original string in a single-element array if it fits.
 */
function hardSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}

/**
 * Chunk a file's content based on its extension.
 */
export function chunkFile(
  content: string,
  filePath: string,
  maxChunkChars = 1000,
  logger?: { warn: (msg: string) => void },
): MemoryChunk[] {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.md':
      return chunkByHeadings(content, maxChunkChars);
    case '.json':
      return chunkJson(content, maxChunkChars, logger);
    case '.yaml':
    case '.yml':
      return chunkYaml(content, maxChunkChars, logger);
    case '.txt':
    default:
      return chunkPlainText(content, maxChunkChars);
  }
}

/**
 * Small delay helper for rate limiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Import files into Keyoku with recursive discovery and multi-format support.
 */
export async function importMemoryFiles(params: {
  client: KeyokuClient;
  entityId: string;
  workspaceDir: string;
  agentId?: string;
  dryRun?: boolean;
  depth?: number;
  types?: string[];
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<ImportResult> {
  const {
    client,
    entityId,
    workspaceDir,
    agentId,
    dryRun = false,
    depth,
    types,
    logger = console,
  } = params;
  const result: ImportResult = { imported: 0, skipped: 0, errors: 0 };

  // Discover files recursively
  const files = discoverFiles(workspaceDir, { depth, types });

  if (files.length === 0) {
    logger.info('No memory files found in workspace.');
    return result;
  }

  logger.info(`Found ${files.length} file(s) to import.`);

  // Process each file
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.path, 'utf-8');
    } catch (err) {
      logger.warn(`Failed to read ${file.name}: ${String(err)}`);
      result.errors++;
      continue;
    }

    if (content.trim().length < 10) {
      logger.info(`Skipping ${file.name} (too short)`);
      result.skipped++;
      continue;
    }

    const chunks = chunkFile(content, file.path, 1000, logger);

    for (const chunk of chunks) {
      chunk.source = file.name;

      // Build the content to store — include source context
      const taggedContent = chunk.section
        ? `[Imported from ${file.name} — ${chunk.section}]\n${chunk.content}`
        : `[Imported from ${file.name}]\n${chunk.content}`;

      if (dryRun) {
        logger.info(`[dry-run] Would import: ${taggedContent.slice(0, 80)}...`);
        result.imported++;
        continue;
      }

      // Dedup check: search for similar content
      try {
        const queryText = chunk.content.slice(0, 100);
        const existing = await client.search(entityId, queryText, { limit: 1, min_score: 0.95 });

        if (existing.length > 0) {
          result.skipped++;
          continue;
        }
      } catch {
        // Search failed — proceed with import anyway
      }

      // Store the memory
      try {
        await client.remember(entityId, taggedContent, {
          agent_id: agentId,
          source: 'import',
        });
        result.imported++;
        logger.info(`Imported: ${chunk.content.slice(0, 60)}...`);
      } catch (err) {
        logger.warn(`Failed to store chunk from ${file.name}: ${String(err)}`);
        result.errors++;
      }

      // Rate limit
      await delay(50);
    }
  }

  return result;
}
