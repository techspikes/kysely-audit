import type { Linter } from 'eslint'
import { globalIgnores } from 'eslint/config'
import { neostandard, resolveIgnoresFromGitignore } from 'neostandard'

export default [
  globalIgnores(resolveIgnoresFromGitignore()),
  ...neostandard({ ts: true }),
  {
    rules: {
      curly: ['error', 'all'],
      'init-declarations': ['error', 'always'],
      'no-undef-init': 'off',
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'do', 'switch', 'return', 'throw'] },
        { blankLine: 'always', prev: 'block-like', next: '*' },
      ],
    },
  },
] satisfies Linter.Config[]
