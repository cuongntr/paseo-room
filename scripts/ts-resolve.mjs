// Lets Node run this repository's TypeScript sources directly for development scripts: a `.js`
// specifier that has no file resolves to the `.ts` file beside it. Used only by `npm run
// attention:eval`; the published package never loads it.
import { register } from 'node:module';

const hook = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const candidate = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(candidate))) {
      const typescript = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(typescript))) return next(typescript.href, context);
    }
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
