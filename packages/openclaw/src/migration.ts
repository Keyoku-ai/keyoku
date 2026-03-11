/**
 * Migration utility — imports OpenClaw's file-based memories into Keyoku.
 *
 * Reads MEMORY.md and memory/*.md files, chunks them by heading sections,
 * deduplicates against existing Keyoku memories, and stores each chunk.
 *
 * Usage: `openclaw memory import --dir /path/to/workspace`
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { KeyokuClient } from '@keyoku/memory';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

interface MemoryChunk {
  content: string;
  source: string; // original filename
  section?: string; // heading text
}

/**
 * Split markdown content by ## or ### headings.
 * Each heading section becomes one chunk.
 * If no headings, split by --- separators or paragraphs.
 */
function chunkByHeadings(content: string, maxChunkChars = 1000): MemoryChunk[] {
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
function splitByParagraphs(text: string, maxChars = 1000): string[] {
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
 * Small delay helper for rate limiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Import OpenClaw memory files into Keyoku.
 */
export async function importMemoryFiles(params: {
  client: KeyokuClient;
  entityId: string;
  workspaceDir: string;
  agentId?: string;
  dryRun?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<ImportResult> {
  const { client, entityId, workspaceDir, agentId, dryRun = false, logger = console } = params;
  const result: ImportResult = { imported: 0, skipped: 0, errors: 0 };

  // Discover memory files
  const files: { path: string; name: string }[] = [];

  // Check for MEMORY.md
  const memoryMdPath = join(workspaceDir, 'MEMORY.md');
  if (existsSync(memoryMdPath)) {
    files.push({ path: memoryMdPath, name: 'MEMORY.md' });
  }

  // Check for memory/ directory
  const memoryDir = join(workspaceDir, 'memory');
  if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
    const entries = readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md'))
      .sort(); // chronological for dated files

    for (const entry of entries) {
      files.push({ path: join(memoryDir, entry), name: `memory/${entry}` });
    }
  }

  if (files.length === 0) {
    logger.info('No memory files found in workspace.');
    return result;
  }

  logger.info(`Found ${files.length} memory file(s) to import.`);

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

    const chunks = chunkByHeadings(content);

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
          source: 'migration',
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
