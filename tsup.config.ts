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
  // No sourcemaps in the published package: the CJS splitting pass writes the
  // absolute path of the build machine into them. The output is not minified
  // and stays readable without maps. check:dist fails on any such path.
  sourcemap: false,
  clean: true,
})
