import type { Segment } from '../types'

export type Proc = { pid: number; ppid: number; seconds: number; args: string }
export type Tally = { done: number; failed: number; skipped: number; errors: number; isTesting: boolean; step: string; banner: string; seconds: number }

// Prepended to Bash commands that run xcodebuild: tees its stdout into a log the poller can read,
// so `xcodebuild ... | tail` still reports progress. pipefail keeps xcodebuild's exit code; the tee side
// always succeeds, so a log that cannot be written never fails the build. The log name starts with
// `owner` (the Claude pid), which claims a build for its session after its shell is gone (`&`), and ends
// with tee's own pid: unique per run, where zsh's $RANDOM repeats in every function subshell.
// Kept to plain commands, since permission rules and hooks judge it along with the model's command.
// ponytail: the poller deletes each log when its run ends; one orphaned by a killed session stays in TMPDIR.
export const wrap = (owner: string) =>
  `xcodebuild() ( set -o pipefail; d="\${TMPDIR:-/tmp}/xcodebuild-status"; mkdir -p "$d"; ` +
  `command xcodebuild "$@" | { sh -c 'exec tee "$0-$$.log"' "$d/${owner}" 2>/dev/null; true; } )`

// An Xcode path may hold spaces in any folder (`/Volumes/External SSD/Xcode 27 - beta.app`) but not
// a `-c` word, so the shell running it stays out.
const XCODEBUILD = /^(?:\S*\/|(?:\/[^\s/]+(?: (?!-\w)[^\s/]+)*)*\.app\/Contents\/Developer\/usr\/bin\/)?xcodebuild(?:\s|$)/
const TEE_LOG = /^(?:\S*\/)?tee .*?(\S*xcodebuild-status\/\S+\.log)/
const ACTIONS = ['test-without-building', 'build-for-testing', 'test', 'build', 'archive', 'analyze', 'clean']
// XCTest (`Test Case '-[A b]' passed (…)`, `Test case 'A.b()' passed on '…'`) and
// Swift Testing (`<sym> Test b() passed after 1.0 seconds.`); not `Test run with …` or the lines a test
// records an issue, a known issue or a warning on (`Test b() recorded an issue with 1 argument …: …`).
const RESULT =
  /^(?:Test [Cc]ase '[^']+'|\S+ Test (?!run |case passing )(?!.* recorded (?:an issue|a known issue|a warning)\b)\S.*?) (?:(passed|failed)(?: after| on | \(|\.|$)|(skipped))/
const TESTING = /^(?:Testing started|Test Suite '.+' started|\S+ Test run started)/
// Not XCTest's failed assertions (`T.swift:12: error: -[X testC] : XCTAssertTrue failed`).
const ERROR = /(?:^|: )error: (?!-\[)/
const STEP = /^([A-Z]\w+) .*\(in target '([^']+)'/
const BANNER = /^\*\* (.+) \*\*$/
const TOOL = /\/(swift-frontend|clang|ld)(?= |$)/

export const emptyTally = (): Tally => ({ done: 0, failed: 0, skipped: 0, errors: 0, isTesting: false, step: '', banner: '', seconds: 0 })

// ps `etime`: [[dd-]hh:]mm:ss.
export function etimeSeconds(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = (rest ?? '').split(':').map(Number)
  return Number(days) * 86400 + parts.reduce((sum, n) => sum * 60 + n, 0)
}

export const parsePs = (text: string): Proc[] =>
  text.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), seconds: etimeSeconds(m[3] ?? ''), args: m[4] ?? '' }] : []
  })

export const isXcodebuild = (p: Proc) => XCODEBUILD.test(p.args)

// The log wrap's tee writes for this xcodebuild: tee runs under the same function subshell
// (a child of it in zsh, a grandchild through the `{ }` group in bash).
// An xcodebuild launchd adopted itself (`nohup xcodebuild … &`) was never wrapped: it has no such tee.
export function teeLogOf(x: Proc, procs: Proc[]): string | undefined {
  if (x.ppid === 1) return undefined
  const byPid = new Map(procs.map(p => [p.pid, p]))
  for (const tee of procs) {
    const path = TEE_LOG.exec(tee.args)?.[1]
    let p: Proc | undefined = tee
    for (let hops = 0; path && p && hops < 3; p = byPid.get(p.ppid), hops++) {
      if (p.ppid === x.ppid) return path
    }
  }
  return undefined
}

// ponytail: any bare action word counts, so `-scheme test` reads as a test run.
// A test action wins (`clean test`), else the last one (`clean build`).
export function actionOf(args: string): string {
  const found = args.split(/\s+/).filter(t => ACTIONS.includes(t))
  return found.find(t => t.startsWith('test')) ?? found.at(-1) ?? 'build'
}

// What identifies a test run across runs, so the last run's count can serve as the total.
export const totalKey = (args: string) =>
  args.replace(/^.*?xcodebuild(?=\s|$)/, '').replace(/\s-(resultBundlePath|resultStreamPath|derivedDataPath)\s+\S+/g, '').trim()

export function scan(t: Tally, text: string): Tally {
  for (const line of text.split('\n')) {
    const r = RESULT.exec(line)
    if (r) {
      t.done += 1
      if (r[1] === 'failed') t.failed += 1
      if (r[2]) t.skipped += 1
      t.isTesting = true
    } else if (TESTING.test(line)) {
      t.isTesting = true
    } else if (ERROR.test(line)) {
      t.errors += 1
    } else if (BANNER.test(line)) {
      t.banner = BANNER.exec(line)![1]!
    } else {
      const s = STEP.exec(line)
      if (s) t.step = `${s[2]} · ${s[1]}`
    }
  }
  return t
}

// Without a log (stdout is a terminal or an unwrapped pipe): what the build service is running now.
export function phaseOf(pid: number, procs: Proc[]): string {
  const below = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of procs) {
      if (below.has(p.ppid) && !below.has(p.pid)) {
        below.add(p.pid)
        grew = true
      }
    }
  }
  const tools = procs.filter(p => p.pid !== pid && below.has(p.pid)).map(p => TOOL.exec(p.args)?.[1])
  const compiling = tools.filter(t => t === 'swift-frontend' || t === 'clang').length
  if (tools.includes('ld')) return 'linking'
  if (compiling > 0) return `compiling ×${compiling}`
  return ''
}

const BAR_CELLS = 10

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`

// 42 → `0:42`, 3725 → `1:02:05`.
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const ss = String(seconds % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function bar(done: number, total: number): Segment[] {
  const filled = Math.round((Math.min(done, total) / total) * BAR_CELLS)
  return [
    { text: '▰'.repeat(filled), color: 'suggestion' },
    { text: '▱'.repeat(BAR_CELLS - filled), color: 'subtle' },
  ]
}

export function format(action: string, t: Tally, total: number | undefined, others: number): Segment[] {
  const tail: Segment[] = [
    ...(t.errors > 0 ? [{ text: ` · ${plural(t.errors, 'error')}`, color: 'error' }] : []),
    { text: `  ${clock(t.seconds)}`, color: 'subtle' },
    ...(others > 0 ? [{ text: ` (+${others})`, color: 'subtle' }] : []),
  ]
  if (action.startsWith('test') && t.isTesting) {
    const hasTotal = total !== undefined && total >= t.done
    return [
      { text: '⚒ tests ', color: 'warning', bold: true },
      ...(hasTotal ? [...bar(t.done, total), { text: ' ' }] : []),
      { text: hasTotal ? `${t.done}/${total}` : `${t.done}` },
      ...(t.failed > 0 ? [{ text: ` · ✗${t.failed}`, color: 'error' }] : []),
      ...tail,
    ]
  }
  return [
    { text: `⚒ ${action === 'test' ? 'build for test' : action}`, color: 'warning', bold: true },
    ...(t.step ? [{ text: ` · ${t.step}`, color: 'subtle' }] : []),
    ...tail,
  ]
}

// The finished run's outcome, `✓ TEST SUCCEEDED 120/120  in 1:58`; null when it did nothing worth keeping (`-version`).
export function formatResult(action: string, t: Tally): Segment[] | null {
  if (!t.banner && !t.step && t.done === 0) return null
  const banner = t.banner || `${action.toUpperCase()} FINISHED`
  const [mark, color] = banner.includes('SUCCEEDED') ? ['✓', 'success'] : banner.includes('FAILED') ? ['✗', 'error'] : ['•', 'text']
  return [
    { text: `${mark} ${banner}${t.done > 0 ? ` ${t.done - t.failed - t.skipped}/${t.done}` : ''}`, color, bold: true },
    ...(t.skipped > 0 ? [{ text: ` · ${t.skipped} skipped`, color: 'subtle' }] : []),
    ...(t.errors > 0 ? [{ text: ` · ${plural(t.errors, 'error')}`, color: 'error' }] : []),
    { text: `  in ${clock(t.seconds)}`, color: 'subtle' },
  ]
}

export const plain = (segments: Segment[]) => segments.map(s => s.text).join('')
