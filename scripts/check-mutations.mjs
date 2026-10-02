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
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

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
  {
    guard: 'Invalid arguments never reach a handler',
    file: 'src/tool.ts',
    find: '    if (!parsed.ok) return { ok: false, issues: parsed.issues }\n',
    replace: '',
  },
  {
    // The failure this guard prevents is a silent default, not a missing check:
    // the mutant removes the check and lets an unclassified tool start open.
    guard: 'An imported tool without governance never starts',
    file: 'src/adapters/definitions.ts',
    edits: [
      {
        find: '  if (missing.length > 0) {\n    throw new ToolDefinitionError(',
        replace: '  if (missing.length < 0) {\n    throw new ToolDefinitionError(',
      },
      {
        find: "    const rules = governance[name]\n    if (rules === undefined) throw new ToolDefinitionError('missing_governance', name)",
        replace:
          "    const rules = governance[name] ?? { sensitivity: 'none', reversible: true, roles: ['anyone'] }",
      },
    ],
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
  // Resolved, because Vitest reports real paths (on macOS, /var is /private/var).
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-tool-bridge-mutant-')))
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(workdir, entry), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(workdir, 'node_modules'), 'dir')
  mutate?.(workdir)

  // Verdicts come from Vitest's JSON report, not from its console output,
  // whose format depends on the environment (CI colours it, for one).
  const report = join(workdir, 'vitest-report.json')
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    { cwd: workdir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS },
  )
  const failed = failedTests(report)
  cleanUp()

  // Ctrl-C reaches the child too: it either dies by the signal or, like
  // Vitest, catches it and exits with 128 + the signal number.
  const interrupted =
    run.signal === 'SIGINT' || run.signal === 'SIGTERM' || run.status === 130 || run.status === 143
  if (interrupted) stop(130, 'Interrupted: no verdict for this run.')
  if (run.error) return { verdict: 'inconclusive', reason: run.error.message }
  if (run.status === 0) return { verdict: 'passed' }
  if (failed === undefined || failed.length === 0) {
    const status = String(run.status ?? run.signal)
    const tail = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-15).join('\n')
    return {
      verdict: 'inconclusive',
      reason: `the suite exited (${status}) without failing a test. Last lines:\n${tail}`,
    }
  }
  return { verdict: 'failed', failed }
}

/**
 * Names of the failed tests in a Vitest JSON report, or undefined when there
 * is no readable report. Files that failed to load are not tests: they do
 * not count.
 */
function failedTests(report) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8'))
  } catch {
    return undefined
  }
  const names = []
  for (const file of parsed.testResults ?? []) {
    const path = relative(workdir, file.name)
    for (const test of file.assertionResults ?? []) {
      if (test.status === 'failed')
        names.push([path, ...test.ancestorTitles, test.title].join(' > '))
    }
  }
  return [...new Set(names)]
}

const before = fingerprint()

const baseline = runSuite()
if (baseline.verdict !== 'passed') {
  stop(1, `The suite does not pass before any mutation (${baseline.reason ?? 'tests fail'}).`)
}

let problems = 0
for (const mutant of MUTANTS) {
  const source = readFileSync(join(ROOT, mutant.file), 'utf8')
  const edits = mutant.edits ?? [{ find: mutant.find, replace: mutant.replace }]
  const lost = edits.find((edit) => !source.includes(edit.find))
  if (lost) {
    console.error(`✗ ${mutant.guard}: pattern not found in ${mutant.file}, update the mutant`)
    problems += 1
    continue
  }
  const mutated = edits.reduce((text, edit) => text.replace(edit.find, edit.replace), source)
  const result = runSuite((dir) => {
    writeFileSync(join(dir, mutant.file), mutated)
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
