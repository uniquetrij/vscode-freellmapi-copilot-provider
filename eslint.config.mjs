import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['build/**', 'node_modules/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['scripts/**/*.js'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'script',
			globals: {
				__dirname: 'readonly',
				__filename: 'readonly',
				Buffer: 'readonly',
				console: 'readonly',
				process: 'readonly',
				require: 'readonly',
				setTimeout: 'readonly'
			}
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off'
		}
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module'
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
