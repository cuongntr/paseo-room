import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  read: undefined as undefined | ((url: URL) => string),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: (url: URL): string => fsState.read?.(url) ?? actual.readFileSync(url, 'utf8'),
  };
});

async function freshPrompts(): Promise<typeof import('../src/room/prompts.js')> {
  vi.resetModules();
  return import('../src/room/prompts.js');
}

describe('prompt asset loader', () => {
  beforeEach(() => {
    fsState.read = undefined;
  });

  it('caches only successfully validated reads', async () => {
    let reads = 0;
    fsState.read = () => {
      reads += 1;
      if (reads > 1) throw new Error('unexpected second read');
      return '## Human Authority\n\nFirst statement.\n';
    };
    const { loadPromptAsset } = await freshPrompts();

    expect(loadPromptAsset('contract', 'humanAuthority')).toBe(
      '## Human Authority\n- First statement.',
    );
    expect(loadPromptAsset('contract', 'humanAuthority')).toBe(
      '## Human Authority\n- First statement.',
    );
    expect(reads).toBe(1);
  });

  it('does not cache failures and retries the same logical asset', async () => {
    let reads = 0;
    fsState.read = () => {
      reads += 1;
      if (reads === 1) throw new Error('ENOENT fixture');
      return '## Human Authority\n\nRecovered statement.\n';
    };
    const { loadPromptAsset, PromptAssetError } = await freshPrompts();

    let failure: unknown;
    try {
      loadPromptAsset('contract', 'humanAuthority');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PromptAssetError);
    expect((failure as Error).message).toMatch(
      /contract\.humanAuthority.*ENOENT fixture.*Reinstall paseo-room/,
    );
    expect(loadPromptAsset('contract', 'humanAuthority')).toBe(
      '## Human Authority\n- Recovered statement.',
    );
    expect(reads).toBe(2);
  });

  it.each([
    ['', /is empty/],
    ['# Wrong level\n\nStatement.\n', /exactly one H2/],
    ['## Heading only\n', /at least one non-empty statement/],
    ['## Heading\n\n# Nested heading\n', /must not contain additional Markdown headings/],
    ['## First\n\nStatement.\n\n## Second\n\nStatement.\n', /exactly one H2/],
  ])('rejects a malformed section without rendering it: %j', async (source, message) => {
    fsState.read = () => source;
    const { loadPromptAsset, PromptAssetError } = await freshPrompts();

    expect(() => loadPromptAsset('workspace', 'topology')).toThrow(PromptAssetError);
    expect(() => loadPromptAsset('workspace', 'topology')).toThrow(message);
  });
});
