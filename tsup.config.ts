import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    zod: 'src/schema/zod.ts',
  },
  format: ['esm', 'cjs'],
  target: 'node20',
  // tsup's declaration bundler sets `baseUrl`, which TypeScript 6 deprecates;
  // the project's own tsconfig does not use it.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  // Shared code (error classes, the defineTool brand) lives in one chunk, so
  // `instanceof` and the registry's brand check hold across both entry points.
  splitting: true,
  sourcemap: true,
  clean: true,
})
