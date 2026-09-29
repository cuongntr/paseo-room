/**
 * How an assignment is named for a reader: its outcome cut to a short phrase. Shared by the
 * server, which titles Peers and worktrees with it, and the panel, which lists assignments by it.
 */

/** Characters of an assignment's outcome kept where it names the assignment. */
const GIST = 48;

/** An assignment's outcome, cut to a short phrase on one line, at a word boundary where one is near. */
export function outcomeGist(outcome: string): string {
  const flat = outcome.replace(/\s+/g, ' ').trim();
  if (flat.length <= GIST) return flat;
  const cut = flat.slice(0, GIST - 1);
  const words = cut.replace(/\s+\S*$/, '');
  return `${words.length >= GIST / 2 ? words : cut.trimEnd()}…`;
}
