import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Type-level assertions (expectTypeOf, @ts-expect-error) are checked by
    // `npm run typecheck`, which covers test/ as well.
  },
})
