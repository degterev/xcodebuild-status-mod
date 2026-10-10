import { expect, test } from 'claude-code/testing'

import {
  actionOf,
  clock,
  emptyTally,
  etimeSeconds,
  format,
  formatResult,
  isXcodebuild,
  parsePs,
  phaseOf,
  plain,
  scan,
  teeLogOf,
  totalKey,
} from './parse'

// Real xcodebuild 27 output: XCTest and Swift Testing in one run, one Swift Testing failure.
const LOG = `SwiftCompile normal arm64 /p/Demo.swift (in target 'Demo' from project 'Demo')
Test Suite 'All tests' started at 2026-10-10 02:13:39.990.
Test Case '-[DemoTests.X testA]' started.
Test Case '-[DemoTests.X testA]' passed (1.001 seconds).
Test Case '-[DemoTests.X testB]' skipped (0.001 seconds).
Test case 'X.testC()' failed on 'Clone 1 of iPhone 18 - Demo (123)' (0.2 seconds)
􀟈 Test run started.
􀟈 Test one() started.
􁁛 Test one() passed after 1.034 seconds.
􀢄 Test two() recorded an issue at T.swift:5:73: Expectation failed: add(1, 2) == 4
􀢄 Test two() failed after 1.036 seconds with 1 issue.
􀢄 Test run with 2 tests in 0 suites failed after 1.037 seconds with 1 issue.
`

test('counts finished tests once and failures', async () => {
  const t = { ...scan(emptyTally(), LOG), seconds: 42 }
  expect(t).toEqual({ done: 5, failed: 2, skipped: 1, errors: 0, isTesting: true, step: 'Demo · SwiftCompile', banner: '', seconds: 42 })
  expect(plain(format('test', t, 10, 0))).toBe('⚒ tests ▰▰▰▰▰▱▱▱▱▱ 5/10 · ✗2  0:42')
  expect(plain(format('test', t, undefined, 1))).toBe('⚒ tests 5 · ✗2  0:42 (+1)')
  const result = formatResult('test', scan(t, '** TEST FAILED **\n'))!
  expect(plain(result)).toBe('✗ TEST FAILED 2/5 · 1 skipped  in 0:42')
  expect(result[0]?.color).toBe('error')
})

test('result line after the run ends', async () => {
  expect(plain(formatResult('build', scan(emptyTally(), '** BUILD SUCCEEDED **\n'))!)).toBe('✓ BUILD SUCCEEDED  in 0:00')
  expect(plain(formatResult('build', { ...emptyTally(), step: 'compiling ×2' })!)).toBe('• BUILD FINISHED  in 0:00')
  expect(formatResult('build', scan(emptyTally(), 'Xcode 27.0\n'))).toBe(null)
})

test('build step and errors before tests start', async () => {
  const t = scan({ ...emptyTally(), seconds: 3725 }, `Ld /p/App (in target 'App' from project 'App')
/p/A.swift:3:5: error: cannot find 'x' in scope
`)
  expect(plain(format('build', t, undefined, 0))).toBe('⚒ build · App · Ld · 1 error  1:02:05')
  expect(plain(format('test', t, 40, 0))).toBe('⚒ build for test · App · Ld · 1 error  1:02:05')
})

test('finds xcodebuild, its tee log and its compilers', async () => {
  const procs = parsePs(`  100   1 01:05 /bin/zsh -c xcodebuild() ( ... ) xcodebuild test -scheme App
  101   100 01:05 /Applications/Xcode 27.app/Contents/Developer/usr/bin/xcodebuild test -scheme App -resultBundlePath /tmp/r1
  102   100 01:05 /bin/zsh -c xcodebuild
  103   102 01:05 tee /var/folders/T//xcodebuild-status/1-2.log
  104   101 01:05 /Applications/Xcode.app/SWBBuildService
  105   104 01:05 /Applications/Xcode.app/usr/bin/swift-frontend -frontend -c
  106   104 01:05 /Applications/Xcode.app/usr/bin/swift-frontend -frontend -c
  107   1 01:05 /bin/grep xcodebuild`)
  const [xcodebuild, ...others] = procs.filter(isXcodebuild)
  expect(xcodebuild?.pid).toBe(101)
  expect(others).toEqual([])
  expect(teeLogOf(xcodebuild!, procs)).toBe('/var/folders/T//xcodebuild-status/1-2.log')
  expect(phaseOf(101, procs)).toBe('compiling ×2')
  expect(actionOf(xcodebuild!.args)).toBe('test')
  expect(totalKey(xcodebuild!.args)).toBe('test -scheme App')
})

test('review regressions', async () => {
  const t = scan(emptyTally(), `􀢄 Test two() recorded an issue at T.swift:5:73: Issue recorded: login failed.
􀢄 Test login(user:) recorded an issue with 1 argument user → "a" at T.swift:9:5: Issue recorded: login failed.
􀢄 Test three() recorded a known issue at T.swift:7:3: Issue recorded: sync failed.
􀢄 Test four() recorded a warning: Expectation passed after retry
􀢄 Test five() recorded an issue: Issue recorded: upload skipped
/p/T.swift:12: error: -[DemoTests.X testC] : XCTAssertTrue failed
`)
  expect([t.done, t.failed, t.errors]).toEqual([0, 0, 0])
  expect(actionOf('xcodebuild clean test -scheme App')).toBe('test')
  expect(actionOf('xcodebuild clean build')).toBe('build')
  const procs = parsePs(`  200   1 00:05 /bin/zsh -c /Applications/Xcode 27.app/Contents/Developer/usr/bin/xcodebuild test
  201   200 00:05 /Applications/Xcode 27.app/Contents/Developer/usr/bin/xcodebuild test
  202   201 00:05 /Applications/Xcode 27.app/Contents/Developer/Toolchains/X.xctoolchain/usr/bin/ld -o /p/App`)
  expect(procs.filter(isXcodebuild).map(p => p.pid)).toEqual([201])
  const spaced = parsePs(`  300   1 00:05 /bin/zsh -c /Volumes/External SSD/Xcode 27 - beta.app/Contents/Developer/usr/bin/xcodebuild test
  301   300 00:05 /Volumes/External SSD/Xcode 27 - beta.app/Contents/Developer/usr/bin/xcodebuild test
  302   1 00:05 /Applications/Xcode Versions/Xcode-16.2.app/Contents/Developer/usr/bin/xcodebuild build`)
  expect(spaced.filter(isXcodebuild).map(p => p.pid)).toEqual([301, 302])
  // 302 was adopted by launchd unwrapped; 401 is a wrapped run whose shell exited, its tee adopted too.
  const adopted = parsePs(`  302   1 00:05 /usr/bin/xcodebuild test
  400   1 00:05 /bin/zsh -c xcodebuild
  401   400 00:05 /usr/bin/xcodebuild test
  402   1 00:05 tee /T/xcodebuild-status/7-402.log`)
  expect(teeLogOf(adopted[0]!, adopted)).toBe(undefined)
  expect(phaseOf(201, procs)).toBe('linking')
})

test('ps etime and clock', async () => {
  expect(etimeSeconds('01:05')).toBe(65)
  expect(etimeSeconds('02:01:05')).toBe(7265)
  expect(etimeSeconds('1-00:00:01')).toBe(86401)
  expect(clock(65)).toBe('1:05')
})
