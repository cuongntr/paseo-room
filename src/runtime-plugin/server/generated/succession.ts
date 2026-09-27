/**
 * The messages of Lead succession (docs/design/runtime-coordination-seat-context.md §6). Setup
 * rewrites this file from the Markdown prompt assets under src/room/prompts/runtime/; the
 * checked-in copy is a placeholder, and without the generated text no succession starts.
 */
export interface SuccessionText {
  readonly request: string;
  readonly kickoff: string;
}

export const SUCCESSION_TEXT: SuccessionText | undefined = undefined;
