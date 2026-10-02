// Targeted mutation testing. Each mutant removes one safety guard; with the
// guard gone, the test suite must fail. A guard whose removal leaves the
// suite green is a guard no test protects.
//
// Mutants never touch the working tree: each one runs in a throwaway copy
// of the repository (sources, tests, examples, configuration; node_modules
// is linked, not copied). Interrupting the script, even with kill -9, can at
// worst leave a directory behind in the system's temporary folder.
//
// A mutant counts as caught only when named tests fail. A run that crashes,
// times out or is interrupted proves nothing, and fails the check. A mutant
// whose pattern is no longer found fails it too: when the code moves, the
// list must move with it.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MUTANTS = [
  {
    guard: 'The role is checked again at call time',
    file: 'src/bridge.ts',
    find: "    if (!canAccess(tool, caller)) return this.#reject(inScope, 'forbidden')\n",
    replace: '',
  },
  {
    guard: 'A confirmation token is single-use',
    file: 'src/confirmation/store.ts',
    find: '    this.#records.delete(tokenHash)\n    return Promise.resolve(record)',
    replace: '    return Promise.resolve(record)',
  },
  {
    guard: 'A token only runs the exact arguments it was issued for',
    file: 'src/bridge.ts',
    find: '      expected.name === record.tool &&\n      expected.args !== undefined &&\n      digestArguments(expected.args) === record.argumentsDigest',
    replace: '      expected.name === record.tool',
  },
  {
    guard: 'The role is checked again when a confirmation is redeemed',
    file: 'src/bridge.ts',
    find: "    if (!canAccess(tool, caller)) return this.#reject(scope, 'forbidden')\n",
    replace: '',
  },
  {
    guard: 'The token never appears in what the model reads',
    file: 'src/server/mcpServer.ts',
    find: "    structuredContent: { status: 'confirmation_required', tool, summary, expiresAt },",
    replace:
      "    structuredContent: { status: 'confirmation_required', tool, summary, expiresAt, token },",
  },
]

const ROOT = resolve(import.meta.dirname, '..')
/** What the test suite needs to run; everything else stays behind. */
const COPIED = ['src', 'test', 'examples', 'package.json', 'tsconfig.json', 'vitest.config.ts']
const RUN_TIMEOUT_MS = 5 * 60 * 1000

let workdir

function cleanUp() {
  if (workdir === undefined) return
  // Remove the link first, so that deleting the copy can never reach the
  // real node_modules.
  try {
    unlinkSync(join(workdir, 'node_modules'))
  } catch {
    // Not created yet.
  }
  rmSync(workdir, { recursive: true, force: true })
  workdir = undefined
}

function stop(code, message) {
  cleanUp()
  if (message) console.error(message)
  process.exit(code)
}

// Between two runs, signals reach these handlers. During a run the script is
// blocked in spawnSync: the child gets the same Ctrl-C, and its exit by
// signal is handled in runSuite.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(130, 'Interrupted: no verdict for this run.'))
}

/** Fingerprint of the working tree's sources, to prove they were left alone. */
function fingerprint() {
  const hash = createHash('sha256')
  const walk = (path) => {
    const entries = readdirSync(path, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(full).update(readFileSync(full))
    }
  }
  for (const dir of ['src', 'test', 'examples']) walk(join(ROOT, dir))
  return hash.digest('hex')
}

/** Runs the suite in a fresh copy of the repository, with `mutate` applied to the copy. */
function runSuite(mutate) {
  workdir = mkdtempSync(join(tmpdir(), 'mcp-tool-bridge-mutant-'))
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(workdir, entry), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(workdir, 'node_modules'), 'dir')
  mutate?.(workdir)

  const run = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=dot'],
    { cwd: workdir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  )
  cleanUp()

  // Ctrl-C reaches the child too: it either dies by the signal or, like
  // Vitest, catches it and exits with 128 + the signal number.
  const interrupted =
    run.signal === 'SIGINT' || run.signal === 'SIGTERM' || run.status === 130 || run.status === 143
  if (interrupted) stop(130, 'Interrupted: no verdict for this run.')
  if (run.error) return { verdict: 'inconclusive', reason: run.error.message }
  if (run.status === 0) return { verdict: 'passed' }
  const output = `${run.stdout}\n${run.stderr}`
  // Failed tests, not files that failed to load: " FAIL  test/x.test.ts > describe > it".
  const failed = [...output.matchAll(/^ FAIL {2}(\S+\.test\.ts > .+)$/gm)].map((m) => m[1].trim())
  if (failed.length === 0) {
    const status = String(run.status ?? run.signal)
    return {
      verdict: 'inconclusive',
      reason: `the suite exited (${status}) without failing a test`,
    }
  }
  return { verdict: 'failed', failed: [...new Set(failed)] }
}

const before = fingerprint()

const baseline = runSuite()
if (baseline.verdict !== 'passed') {
  stop(1, `The suite does not pass before any mutation (${baseline.reason ?? 'tests fail'}).`)
}

let problems = 0
for (const mutant of MUTANTS) {
  const source = readFileSync(join(ROOT, mutant.file), 'utf8')
  if (!source.includes(mutant.find)) {
    console.error(`✗ ${mutant.guard}: pattern not found in ${mutant.file}, update the mutant`)
    problems += 1
    continue
  }
  const result = runSuite((dir) => {
    writeFileSync(join(dir, mutant.file), source.replace(mutant.find, mutant.replace))
  })
  if (result.verdict === 'passed') {
    problems += 1
    console.error(`✗ ${mutant.guard}: removed, and every test still passes`)
  } else if (result.verdict === 'inconclusive') {
    problems += 1
    console.error(`✗ ${mutant.guard}: inconclusive, ${result.reason}`)
  } else {
    console.log(`✓ ${mutant.guard}: caught by ${String(result.failed.length)} test(s)`)
    for (const name of result.failed) console.log(`    ${name}`)
  }
}

if (fingerprint() !== before) stop(1, 'The working tree changed during the check: inspect it.')
if (problems > 0) process.exit(1)
console.log(`All ${String(MUTANTS.length)} guards are protected by the tests.`)
