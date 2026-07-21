import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      // Module scope must stay inert: Workers rejects timers at module scope
      // and the failure only shows up at deploy. See AGENTS.md.
      'no-restricted-globals': [
        'error',
        {
          name: 'setInterval',
          message: 'Timers are not allowed at module scope; see AGENTS.md.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier
);
