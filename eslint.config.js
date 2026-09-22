import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.beads/**'] },
  js.configs.recommended,
  {
    // Standalone Node scripts, such as the runtime bridge process, run outside TypeScript.
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
