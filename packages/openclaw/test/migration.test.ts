import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  chunkByHeadings,
  chunkFile,
  chunkJson,
  chunkYaml,
  chunkPlainText,
  discoverFiles,
  importMemoryFiles,
} from '../src/migration.js';

// ─── helpers ──────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keyoku-test-'));
}

function createMockClient() {
  return {
    search: vi.fn().mockResolvedValue([]),
    remember: vi.fn().mockResolvedValue({ memories_created: 1 }),
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

// ─── chunkByHeadings (existing tests, preserved) ─────────────────────

describe('chunkByHeadings', () => {
  it('splits content by ## headings', () => {
    const content = '## Section A\nContent A\n\n## Section B\nContent B';
    const chunks = chunkByHeadings(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('Section A');
    expect(chunks[0].section).toBe('Section A');
    expect(chunks[1].content).toContain('Section B');
  });

  it('handles ### headings', () => {
    const content = '### Sub A\nContent A\n\n### Sub B\nContent B';
    const chunks = chunkByHeadings(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('Sub A');
  });

  it('captures content before first heading', () => {
    const content = 'Preamble text with enough content to be kept.\n\n## Section A\nContent A';
    const chunks = chunkByHeadings(content);
    const preambleChunk = chunks.find((c) => c.content.includes('Preamble'));
    expect(preambleChunk).toBeDefined();
  });

  it('splits by --- separators when no headings', () => {
    const content = 'Block one with content.\n\n---\n\nBlock two with content.';
    const chunks = chunkByHeadings(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('splits by paragraphs when no structure', () => {
    const content = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
    const chunks = chunkByHeadings(content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('skips tiny sections (< 10 chars)', () => {
    const content = '## A\nHi\n\n## B\nThis section has enough content to be kept.';
    const chunks = chunkByHeadings(content);
    expect(chunks.every((c) => c.content.length >= 10)).toBe(true);
  });

  it('handles empty content', () => {
    expect(chunkByHeadings('')).toHaveLength(0);
  });

  it('splits large sections by paragraphs', () => {
    const longSection =
      '## Big Section\n\n' +
      Array(20).fill('This is a paragraph with some content in it.').join('\n\n');
    const chunks = chunkByHeadings(longSection, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.section === 'Big Section')).toBe(true);
  });
});

// ─── discoverFiles ───────────────────────────────────────────────────

describe('discoverFiles', () => {
  it('finds files at root level', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'readme.md'), 'hello');
      writeFileSync(join(dir, 'data.json'), '{}');
      writeFileSync(join(dir, 'notes.txt'), 'text');

      const files = discoverFiles(dir);
      expect(files).toHaveLength(3);
      expect(files.map((f) => f.name).sort()).toEqual(['data.json', 'notes.txt', 'readme.md']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('recurses into subdirectories', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'root.md'), 'root');
      writeFileSync(join(dir, 'sub', 'nested.md'), 'nested');

      const files = discoverFiles(dir);
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toContain(join('sub', 'nested.md'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('respects max depth', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'a'), { recursive: true });
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      writeFileSync(join(dir, 'root.md'), 'root');
      writeFileSync(join(dir, 'a', 'level1.md'), 'one');
      writeFileSync(join(dir, 'a', 'b', 'level2.md'), 'two');

      const files = discoverFiles(dir, { depth: 1 });
      const names = files.map((f) => f.name);
      expect(names).toContain('root.md');
      expect(names).toContain(join('a', 'level1.md'));
      expect(names).not.toContain(join('a', 'b', 'level2.md'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('depth=0 means no recursion', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'root.md'), 'root');
      writeFileSync(join(dir, 'sub', 'nested.md'), 'nested');

      const files = discoverFiles(dir, { depth: 0 });
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('root.md');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('depth=-1 means unlimited', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
      writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'deep.md'), 'deep');

      const files = discoverFiles(dir, { depth: -1 });
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe(join('a', 'b', 'c', 'd', 'deep.md'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips dotfiles and dotdirs', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, '.hidden'));
      writeFileSync(join(dir, '.env'), 'secret');
      writeFileSync(join(dir, '.hidden', 'file.md'), 'hidden');
      writeFileSync(join(dir, 'visible.md'), 'visible');

      const files = discoverFiles(dir);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('visible.md');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips node_modules', () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.json'), '{}');
      writeFileSync(join(dir, 'app.md'), 'app');

      const files = discoverFiles(dir);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('app.md');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips symlinks', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'real.md'), 'real');
      symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'));

      const files = discoverFiles(dir);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('real.md');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('filters by file type', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'data.json'), '{}');
      writeFileSync(join(dir, 'readme.md'), 'hello');
      writeFileSync(join(dir, 'notes.txt'), 'text');

      const files = discoverFiles(dir, { types: ['.json'] });
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('data.json');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns empty for nonexistent directory', () => {
    const files = discoverFiles('/nonexistent/path/that/does/not/exist');
    expect(files).toEqual([]);
  });
});

// ─── chunkFile dispatcher ────────────────────────────────────────────

describe('chunkFile', () => {
  it('routes .md to chunkByHeadings', () => {
    const content = '## Heading\nSome content under the heading here.';
    const chunks = chunkFile(content, 'test.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe('Heading');
  });

  it('routes .txt to plain text chunker', () => {
    const content = 'First paragraph here.\n\nSecond paragraph here.';
    const chunks = chunkFile(content, 'test.txt');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].section).toBeUndefined();
  });

  it('routes unknown extension to plain text fallback', () => {
    const content = 'Some content that should be chunked as plain text.';
    const chunks = chunkFile(content, 'test.xyz');
    expect(chunks).toHaveLength(1);
  });
});

// ─── chunkJson ───────────────────────────────────────────────────────

describe('chunkJson', () => {
  it('object → one chunk per top-level key', () => {
    const content = JSON.stringify({ name: 'Alice likes dark mode', prefs: 'TypeScript forever' });
    const chunks = chunkJson(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('name');
    expect(chunks[1].section).toBe('prefs');
  });

  it('array → one chunk per item', () => {
    const content = JSON.stringify([
      { name: 'Alice likes dark mode' },
      { name: 'Bob likes light mode' },
    ]);
    const chunks = chunkJson(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('[0]');
    expect(chunks[1].section).toBe('[1]');
  });

  it('nested objects stay as one chunk per top-level key', () => {
    const content = JSON.stringify({
      deep: { a: { b: { c: { d: 'value buried deep inside' } } } },
    });
    const chunks = chunkJson(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe('deep');
    expect(chunks[0].content).toContain('value buried deep inside');
  });

  it('large values are hard-split', () => {
    const bigValue = 'x'.repeat(2500);
    const content = JSON.stringify({ big: bigValue });
    const chunks = chunkJson(content, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.section === 'big')).toBe(true);
  });

  it('invalid JSON returns empty array without throwing', () => {
    const warn = vi.fn();
    const chunks = chunkJson('not valid json {{{', 1000, { warn });
    expect(chunks).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

// ─── chunkYaml ───────────────────────────────────────────────────────

describe('chunkYaml', () => {
  it('object → one chunk per top-level key', () => {
    const content = 'name: Alice likes dark mode\nprefs: TypeScript forever\n';
    const chunks = chunkYaml(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('name');
    expect(chunks[1].section).toBe('prefs');
  });

  it('multi-document YAML produces chunks from each doc', () => {
    const content = 'db:\n  host: localhost\n---\ncache:\n  host: redis\n';
    const chunks = chunkYaml(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('db');
    expect(chunks[1].section).toBe('cache');
  });

  it('anchors and aliases are resolved', () => {
    const content =
      'defaults: &defaults\n  adapter: postgres\n  host: localhost\n\nproduction:\n  <<: *defaults\n  database: myapp\n';
    const chunks = chunkYaml(content);
    const prodChunk = chunks.find((c) => c.section === 'production');
    expect(prodChunk).toBeDefined();
    expect(prodChunk!.content).toContain('postgres');
  });

  it('large values are hard-split', () => {
    const bigValue = 'x'.repeat(2500);
    const content = `big: "${bigValue}"\n`;
    const chunks = chunkYaml(content, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.section === 'big')).toBe(true);
  });

  it('invalid YAML returns empty array without throwing', () => {
    const warn = vi.fn();
    const chunks = chunkYaml('  :\n- :\n  :\n{{{invalid', 1000, { warn });
    expect(chunks).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

// ─── chunkPlainText ──────────────────────────────────────────────────

describe('chunkPlainText', () => {
  it('splits by paragraphs', () => {
    const content =
      'First paragraph with enough content.\n\nSecond paragraph with enough content.\n\nThird paragraph with enough content.';
    const chunks = chunkPlainText(content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('skips tiny chunks (< 10 chars)', () => {
    const content = 'Hi\n\nThis paragraph has enough content to be kept.';
    const chunks = chunkPlainText(content);
    expect(chunks.every((c) => c.content.length >= 10)).toBe(true);
  });

  it('handles single block of text', () => {
    const content = 'This is a single block of text without any paragraph breaks at all.';
    const chunks = chunkPlainText(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
  });
});

// ─── importMemoryFiles (updated) ─────────────────────────────────────

describe('importMemoryFiles', () => {
  it('returns zero counts when no files found', async () => {
    const client = createMockClient();
    const result = await importMemoryFiles({
      client: client as any,
      entityId: 'test',
      workspaceDir: '/nonexistent/path',
      logger: silentLogger,
    });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('respects dryRun mode', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      writeFileSync(join(dir, 'MEMORY.md'), '## Test\nSome test content for dry run verification.');

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        dryRun: true,
        logger: silentLogger,
      });

      expect(result.imported).toBeGreaterThan(0);
      expect(client.remember).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('skips duplicates based on similarity search', async () => {
    const client = createMockClient();
    client.search.mockResolvedValue([{ memory: { content: 'duplicate' }, similarity: 0.98 }]);

    const dir = tmpDir();

    try {
      writeFileSync(join(dir, 'MEMORY.md'), '## Test\nSome content that already exists in keyoku.');

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        logger: silentLogger,
      });

      expect(result.skipped).toBeGreaterThan(0);
      expect(client.remember).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('imports from nested directories', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      mkdirSync(join(dir, 'docs', 'api'), { recursive: true });
      writeFileSync(join(dir, 'root.md'), '## Root\nRoot level content for testing.');
      writeFileSync(join(dir, 'docs', 'guide.md'), '## Guide\nGuide content for testing.');
      writeFileSync(
        join(dir, 'docs', 'api', 'ref.md'),
        '## API Reference\nAPI reference content.',
      );

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        dryRun: true,
        logger: silentLogger,
      });

      expect(result.imported).toBe(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('respects depth limit', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      writeFileSync(join(dir, 'root.md'), '## Root\nRoot level content for testing.');
      writeFileSync(join(dir, 'a', 'one.md'), '## One\nLevel one content for testing.');
      writeFileSync(join(dir, 'a', 'b', 'two.md'), '## Two\nLevel two content for testing.');

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        depth: 1,
        dryRun: true,
        logger: silentLogger,
      });

      // depth=1: root + a/ but not a/b/
      expect(result.imported).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('filters by file type', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      writeFileSync(join(dir, 'readme.md'), '## Readme\nMarkdown content for testing.');
      writeFileSync(join(dir, 'data.json'), JSON.stringify({ key: 'JSON value for testing' }));
      writeFileSync(join(dir, 'notes.txt'), 'Plain text content for testing here.');

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        types: ['.json'],
        dryRun: true,
        logger: silentLogger,
      });

      expect(result.imported).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('handles mixed file formats', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      writeFileSync(join(dir, 'doc.md'), '## Doc\nMarkdown documentation content.');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ setting: 'value for config' }));
      writeFileSync(join(dir, 'notes.txt'), 'Plain text notes with enough content.');

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        dryRun: true,
        logger: silentLogger,
      });

      expect(result.imported).toBe(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('backward compat: finds MEMORY.md and memory/*.md', async () => {
    const client = createMockClient();
    const dir = tmpDir();

    try {
      mkdirSync(join(dir, 'memory'));
      writeFileSync(join(dir, 'MEMORY.md'), '## Memory\nMain memory file content here.');
      writeFileSync(
        join(dir, 'memory', '2024-01-01.md'),
        '## Jan\nJanuary memory file content.',
      );

      const result = await importMemoryFiles({
        client: client as any,
        entityId: 'test',
        workspaceDir: dir,
        dryRun: true,
        logger: silentLogger,
      });

      expect(result.imported).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
