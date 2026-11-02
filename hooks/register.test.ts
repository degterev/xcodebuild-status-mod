import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOST = 4242

// `sh -c 'echo $PPID'` answers the host pid, `ps` the rows given; every argv is recorded.
function stubProcess(on: On, rows: () => string, argvs: string[][] = []) {
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'sh' ? `${HOST}\n` : e.argv[0] === 'ps' ? rows() : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return argvs
}

// A rewritten command goes to the auto-mode classifier, which then asks about the rewrite.
test('leaves the command as the model wrote it', async ($, on) => {
  stubProcess(on, () => '')
  let seen: string | undefined
  on('tool.call', (_$, e) => {
    seen = (e as { command: string }).command
    return { deny: 'done' }
  })
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme App | tail -5' })
  expect(seen).toBe('xcodebuild test -scheme App | tail -5')
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

test('keeps a tracked build launchd adopted, not another session\'s', async ($, on) => {
  const clock = mock.clock(on)
  let rows = `  800 ${HOST} 00:01 /bin/zsh -c xcodebuild
  801   800 00:01 /usr/bin/xcodebuild test
`
  const argvs = stubProcess(on, () => rows)
  on('tool.call', () => new Promise(() => {}))
  void $.tool.call({ tool: 'Bash', command: 'xcodebuild test &' })
  await clock.advance(2000)

  // The shell exited: 801 is tracked already, 701 was never below this host.
  rows = `  801     1 00:03 /usr/bin/xcodebuild test
  701     1 00:03 /usr/bin/xcodebuild test
`
  await clock.advance(2000)
  const lsofOf = (pid: string) => argvs.filter(a => a[0] === 'lsof' && a.includes(pid)).length
  expect(lsofOf('801')).toBe(1)
  expect(lsofOf('701')).toBe(0)
  rows = ''
  await clock.advance(2000)
  expect(argvs.some(a => a[0] === 'rm')).toBe(false)
})
