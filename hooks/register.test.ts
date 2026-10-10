import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { wrap } from './parse'

const HOST = 4242
const BARE = 'xcodebuild test -scheme App'
const WRAPPED = `${wrap(String(HOST))}\n${BARE}`

// `sh -c 'echo $PPID'` answers the host pid, `ps` the rows given; every argv is recorded.
function stubProcess(on: On, rows: () => string, argvs: string[][] = []) {
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'sh' ? `${HOST}\n` : e.argv[0] === 'ps' ? rows() : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return argvs
}

test('settings rules judge the bare command; a hook or subagent verdict stands', async ($, on) => {
  stubProcess(on, () => '')
  let hook: string | undefined
  // The wrapper makes the rules ask; a rule denies the bare command.
  on('tool.check', (_$, e) => {
    if ((e.input as { command: string }).command === BARE) return { decision: 'deny', rule: 'Bash(xcodebuild test:*)' }
    return hook ? { decision: 'allow', hook } : { decision: 'ask' }
  })
  const check = async (command: string, agentId?: string) =>
    (await $.tool.check({ tool: 'Bash', input: { command }, ...(agentId ? { agentId } : {}) })).decision

  expect(await check(WRAPPED)).toBe('deny')
  expect(await check(WRAPPED, 'sub-1')).toBe('ask')
  // A first line that only looks like the wrapper is the model's own and is never stripped.
  expect(await check(`xcodebuild() ( true )\n${BARE}`)).toBe('ask')
  hook = 'PreToolUse'
  expect(await check(WRAPPED)).toBe('allow')
})

test('polls while a Bash call runs or a build it started lives, then stops', async ($, on) => {
  const clock = mock.clock(on)
  let rows = ''
  const argvs = stubProcess(on, () => rows)
  let release = () => {}
  on('tool.call', () => new Promise(resolve => (release = () => resolve({ deny: 'done' }))))
  const pses = () => argvs.filter(a => a[0] === 'ps').length

  const call = $.tool.call({ tool: 'Bash', command: 'make test' })
  await clock.advance(0)
  rows = `  500 ${HOST} 00:01 /usr/bin/xcodebuild test\n`
  await clock.advance(2000)
  release()
  await call
  await clock.advance(2000)
  expect(pses()).toBe(2)

  rows = ''
  await clock.advance(2000)
  await clock.advance(10000)
  expect(pses()).toBe(3)
})

test('keeps builds launchd adopted when tracked or teeing into a log named after this session', async ($, on) => {
  const clock = mock.clock(on)
  let rows = `  800 ${HOST} 00:01 /bin/zsh -c xcodebuild
  801   800 00:01 /usr/bin/xcodebuild test
  802   800 00:01 tee /T/xcodebuild-status/1-1.log
`
  const argvs = stubProcess(on, () => rows)
  on('tool.call', () => new Promise(() => {}))
  void $.tool.call({ tool: 'Bash', command: 'xcodebuild test &' })
  await clock.advance(2000)

  // The shells exited: 801 is tracked already, 901 tees into a log named after this host, 701 another's.
  rows = `  800     1 00:03 /bin/zsh -c xcodebuild
  801   800 00:03 /usr/bin/xcodebuild test
  802   800 00:03 tee /T/xcodebuild-status/1-1.log
  900     1 00:03 /bin/zsh -c xcodebuild
  901   900 00:03 /usr/bin/xcodebuild test
  902   900 00:03 tee /T/xcodebuild-status/${HOST}-5.log
  700     1 00:03 /bin/zsh -c xcodebuild
  701   700 00:03 /usr/bin/xcodebuild test
  702   700 00:03 tee /T/xcodebuild-status/77-5.log
`
  await clock.advance(2000)
  const read = (path: string) => argvs.some(a => a[0] === 'tail' && a.includes(path))
  expect(argvs.some(a => a[0] === 'rm')).toBe(false)
  expect(read(`/T/xcodebuild-status/${HOST}-5.log`)).toBe(true)
  expect(read('/T/xcodebuild-status/77-5.log')).toBe(false)
})
