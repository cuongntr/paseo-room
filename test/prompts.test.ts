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

    expect(loadPromptAsset('contract', 'challengeSignals')).toBe(
      '## Human Authority\n- First statement.',
    );
    expect(loadPromptAsset('contract', 'challengeSignals')).toBe(
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
      loadPromptAsset('contract', 'challengeSignals');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PromptAssetError);
    expect((failure as Error).message).toMatch(
      /contract\.challengeSignals.*ENOENT fixture.*Reinstall paseo-room/,
    );
    expect(loadPromptAsset('contract', 'challengeSignals')).toBe(
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

    expect(() => loadPromptAsset('contract', 'challengeSignals')).toThrow(PromptAssetError);
    expect(() => loadPromptAsset('contract', 'challengeSignals')).toThrow(message);
  });

  it.each([
    ['', /is empty/],
    ['Loose prose without a heading.\n', /at least one H2 section/],
    ['Preface above the first heading.\n\n## First\n\nStatement.\n', /must not contain content above its first H2 heading/],
    ['## First\n\n# Nested heading\n', /must not contain additional Markdown headings/],
    ['## First\n', /at least one non-empty statement/],
  ])('rejects a malformed role body without rendering it: %j', async (source, message) => {
    fsState.read = () => source;
    const { loadPromptAsset, PromptAssetError } = await freshPrompts();

    expect(() => loadPromptAsset('contract', 'lead')).toThrow(PromptAssetError);
    expect(() => loadPromptAsset('contract', 'lead')).toThrow(message);
  });

  it('renders a multi-section role body as consecutive normalized sections', async () => {
    fsState.read = () => '## First\n\nOne\nwrapped statement.\n\nSecond statement.\n\n## Last\n\nOnly statement.\n';
    const { loadPromptAsset } = await freshPrompts();

    expect(loadPromptAsset('contract', 'peer')).toBe(
      '## First\n- One wrapped statement.\n- Second statement.\n\n## Last\n- Only statement.',
    );
  });

  it.each([
    ['', /is empty/],
    ['## Missing title\n\nStatement.\n', /exactly one H1 heading/],
    ['# Title\n\nPreface only.\n', /at least one H2 section/],
    ['# Title\n\n## Section\n', /at least one non-empty statement/],
  ])('rejects a malformed workspace document without rendering it: %j', async (source, message) => {
    fsState.read = () => source;
    const { loadPromptAsset, PromptAssetError } = await freshPrompts();

    expect(() => loadPromptAsset('workspace', 'default')).toThrow(PromptAssetError);
    expect(() => loadPromptAsset('workspace', 'default')).toThrow(message);
  });

  // The document's H1 and preface are read as a document, so their authored line breaks
  // survive; every section below them normalizes like any other section.
  it('keeps the workspace document preface hard-wrapped and normalizes its sections', async () => {
    fsState.read = () => '# Workspace protocol\n\nA preface line\nwith a hard break.\n\n## Section\n\nOne\nwrapped statement.\n';
    const { loadPromptAsset } = await freshPrompts();

    expect(loadPromptAsset('workspace', 'default')).toBe(
      '# Workspace protocol\n\nA preface line\nwith a hard break.\n\n## Section\n- One wrapped statement.',
    );
  });
});
