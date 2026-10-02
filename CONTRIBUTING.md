# Contributing

## Setup

```sh
npm ci
npm run lint && npm run format:check && npm run typecheck
npm test
npm run build && npm run check:dist
npm run check:mutations
```

Node.js 20 or later. The tests make no network calls. CI runs every command above on
Node 20, 22 and 24.

## Code rules

- TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. No `any`,
  enforced by ESLint's strict type-checked rules.
- Type assertions are a last resort. Each one in `src/` carries a comment that explains
  why it is sound.
- Values that come from outside the type system (JavaScript callers, configuration,
  handler results) are read as `unknown` and checked.
- Type-level behaviour is tested too, with `expectTypeOf` and `@ts-expect-error`.
  `npm run typecheck` covers `test/`.

## Mutation checks

Coverage tells you a line ran. It does not tell you that any test would fail if the line
were wrong. For the lines that keep the bridge safe, we check the second thing.

The practice is **targeted mutation testing**. Each guard below is deliberately removed
from the source (a _mutant_), the test suite is run, and the suite must fail. A guard
whose removal leaves every test green is protected by nothing.
`npm run check:mutations` does this automatically, and CI runs it on every push. If a
guard's code moves and its pattern is no longer found, the check fails until the list is
updated.

Running it is safe, and its verdicts are strict:

- **It never modifies your working tree.** Each mutant runs in a throwaway copy of the
  repository in the system's temporary folder, with `node_modules` linked rather than
  copied. Even a `kill -9` leaves your sources untouched; at worst a copy remains in the
  temporary folder. At the end, the script compares a fingerprint of `src/`, `test/` and
  `examples/` with the one taken at the start.
- **Only failing tests count.** A mutant is caught when named tests fail, as read from
  Vitest's JSON report. A run that crashes, does not load, or exceeds five minutes is
  _inconclusive_, and an inconclusive mutant fails the check, like a surviving one.
- **Ctrl-C stops it at once**, with exit code 130 and no verdict for the interrupted
  run.

#### Why a throwaway copy

The first version of the script mutated the sources in place and restored them in a
`finally` block. Interrupting it on purpose showed that this was not enough:

- After a `kill -9`, the mutated `src/bridge.ts` stayed in the working tree. Nothing
  said so, and the next commit could have shipped the guard removed.
- After a Ctrl-C, the sources were restored, but the script went on with the other
  mutants. It reported the interrupted one as "caught by 0 tests" and exited with code 0. The test runner had caught the signal and exited with an error, and the script
  read that error as a test failure.

A verification tool that reports success after an interruption gives a false guarantee,
which is worse than no tool at all. Hence the three rules above: mutate a copy, never the
working tree; accept only named failing tests as a catch; and treat an interruption as
the absence of a verdict.

The strict rule paid off on the first CI run. The script then found failing tests by
reading Vitest's console output, which CI colours: the colour codes hid every test name,
and all five mutants came out _inconclusive_. The build went red instead of falsely
green. Verdicts now come from Vitest's JSON report, which does not depend on the
environment, and an inconclusive verdict prints the last lines of the run.

| Guard                                                     | Mutant                                                                                       | Caught by                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The role is checked again at call time                    | `callTool` no longer calls `canAccess` before running a tool                                 | 7 tests: calling a tool that was never listed, a role revoked after listing, `forbidden` answered like `unknown_tool` (also over MCP), … |
| A confirmation token is single-use                        | The store's `take` reads the record without deleting it                                      | 11 tests: a second redemption (also over MCP), two concurrent redemptions, a token spent by a mismatched call, revocation, …             |
| A token only runs the exact arguments it was issued for   | A repeated call carrying the token is matched on the tool name only, not the argument digest | 2 tests: the same token with other arguments, or with arguments that are not JSON                                                        |
| The role is checked again when a confirmation is redeemed | Redemption no longer calls `canAccess`                                                       | 2 tests: the role revoked between issue and redemption, through `executeConfirmed()` and through a repeated call                         |
| The token never appears in what the model reads           | The pending result's `structuredContent` also carries the token                              | 3 tests: the pending result over MCP, the fallback when elicitation fails, and the example server end to end                             |

### Adding a guard

When you write code whose only purpose is to refuse something, add a mutant for it to
`scripts/check-mutations.mjs`: the exact text to remove and a sentence naming the guard.
Then run `npm run check:mutations`. If the new mutant survives, the guard has no test
yet: write the test before merging.
