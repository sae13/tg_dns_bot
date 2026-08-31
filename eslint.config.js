import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', '.wrangler', 'dist', '_bmad', '_bmad-output', '.agents'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { Request: 'readonly', Response: 'readonly', URL: 'readonly', fetch: 'readonly', process: 'readonly', console: 'readonly' } }
  }
);
