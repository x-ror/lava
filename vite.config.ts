import { defineConfig } from 'vite-plus';

const ignoredGenerated = ['bin/**', 'build/**', 'node_modules/**', 'reports/**', 'tests/vendor/**'];

export default defineConfig({
	fmt: {
		ignorePatterns: ignoredGenerated,
		semi: true,
		singleQuote: true,
	},
	lint: {
		ignorePatterns: ignoredGenerated,
	},
});
