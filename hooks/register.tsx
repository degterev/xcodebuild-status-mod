import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Line } from '../types'
import {
  actionOf,
  emptyTally,
  format,
  formatResult,
  isXcodebuild,
  parsePs,
  phaseOf,
  scan,
  teeLogOf,
  totalKey,
  wrap,
} from './parse'
import type { Proc, Tally } from './parse'

const line = atom({ plugin: 'xcodebuild-status', key: 'line' } as const, null as Line)

const POLL_MS = 2000
const RUNS_XCODEBUILD = /(?:^|[\s;&|(])xcodebuild\s/

type Run = { args: string; path?: string; isLsofChecked: boolean; offset: number; tally: Tally }

// ponytail: module state, a hot reload re-reads running tee logs from the start on its next tick.
const runs = new Map<number, Run>()
let totals: Record<string, number> = {}
let shown: Line = null
let isBusy = false
// Shown once every run ended, until the next prompt.
let lastResult: Line = null
// Bumped by each prompt, so a tick that started before it does not draw over its clearing.
let prompts = 0
// The Claude process: xcodebuilds below it, or teeing into a log named after it, belong to this session.
let hostPid = 0
// ponytail: polls only while a Bash call runs or a build it started is alive;
// an xcodebuild a background script starts after its call returned is missed.
let poller: { cancel: () => void } | undefined
let bashCalls = 0

// stdout redirected to a file (the Bash tool's own output file, `> log`): read that.
// The file may already hold earlier commands' output, so reading starts at its current end.
// ponytail: what this xcodebuild wrote before the first tick saw it is skipped too.
async function stdoutFile($: EngineInterface, run: Run, pid: number) {
  const { stdout } = await $.process.run(['lsof', '-a', '-p', String(pid), '-d', '1', '-Fn'])
  const path = stdout.split('\n').find(l => l.startsWith('n/'))?.slice(1)
  if (!path || path.startsWith('/dev/')) return
  run.path = path
  run.offset = Number.parseInt((await $.process.run(['wc', '-c', path])).stdout, 10) || 0
}

async function host($: EngineInterface) {
  hostPid ||= Number.parseInt((await $.process.run(['sh', '-c', 'echo $PPID'])).stdout, 10) || 0
  return hostPid
}

const isBelow = (pid: number, ancestor: number, procs: Proc[]) => {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  for (let p = byPid.get(pid); p; p = byPid.get(p.ppid)) if (p.ppid === ancestor) return true
  return false
}

async function feed($: EngineInterface, run: Run) {
  if (!run.path) return
  const { exitCode, stdout } = await $.process.run(['tail', '-c', `+${run.offset + 1}`, run.path])
  const end = stdout.lastIndexOf('\n') + 1
  if (exitCode !== 0 || end === 0) return
  const lines = stdout.slice(0, end)
  run.offset += new TextEncoder().encode(lines).length
  scan(run.tally, lines)
}

async function finish($: EngineInterface, run: Run, prompt: number) {
  await feed($, run)
  // Only a run that reached its banner counts as the whole suite, not one killed or timed out partway.
  if (actionOf(run.args).startsWith('test') && run.tally.done > 0 && /SUCCEEDED|FAILED/.test(run.tally.banner)) {
    totals = { ...totals, [totalKey(run.args)]: run.tally.done }
    await $.store.set('totals', totals)
  }
  if (run.path?.includes('/xcodebuild-status/')) await $.process.run(['rm', '-f', run.path])
  // A prompt that came in meanwhile has already cleared the last result; this one is older still.
  if (prompt === prompts) lastResult = formatResult(actionOf(run.args), run.tally) ?? lastResult
}

async function tick($: EngineInterface) {
  const prompt = prompts
  const owner = await host($)
  const procs: Proc[] = parsePs((await $.process.run(['ps', '-axww', '-o', 'pid=,ppid=,etime=,args='])).stdout)
  // A tracked run stays ours once its shell exited and launchd adopted it.
  const isOurs = (p: Proc) =>
    !owner || runs.has(p.pid) || isBelow(p.pid, owner, procs) || !!teeLogOf(p, procs)?.includes(`/xcodebuild-status/${owner}-`)
  const builds = procs.filter(p => isXcodebuild(p) && isOurs(p))

  for (const [pid, run] of runs) {
    if (!builds.some(b => b.pid === pid)) {
      runs.delete(pid)
      await finish($, run, prompt)
    }
  }

  for (const b of builds) {
    const run = runs.get(b.pid) ?? { args: b.args, isLsofChecked: false, offset: 0, tally: emptyTally() }
    runs.set(b.pid, run)
    run.path ??= teeLogOf(b, procs)
    if (!run.path && !run.isLsofChecked) {
      run.isLsofChecked = true
      await stdoutFile($, run, b.pid)
    }
    run.tally.seconds = b.seconds
    await feed($, run)
    if (!run.path) run.tally.step = phaseOf(b.pid, procs) || (run.tally.step && 'running')
  }

  const first = builds[0]
  let text: Line = lastResult
  if (first) {
    text = format(actionOf(first.args), runs.get(first.pid)!.tally, totals[totalKey(first.args)], builds.length - 1)
  }
  if (prompt !== prompts) return
  if (JSON.stringify(text) !== JSON.stringify(shown)) {
    shown = text
    await update($, line, () => text)
  }
  if (bashCalls === 0 && runs.size === 0) {
    poller?.cancel()
    poller = undefined
  }
}

async function poll($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    await tick($)
  } catch (error) {
    $.ui.log(`xcodebuild-status: ${error}`, { to: 'debug' })
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  // Also after a hot reload, which cancelled the poller with the old module: one tick picks up a build
  // still running, and the poller stops on its own when none is.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    totals = ((await $.store.get('totals')) as Record<string, number> | undefined) ?? {}
    poller ??= $.clock.every(POLL_MS, () => void poll($))
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    prompts += 1
    lastResult = null
    if (shown !== null && runs.size === 0) {
      shown = null
      await update($, line, () => null)
    }
    return next(e)
  })

  // Any Bash call may start xcodebuild (a script, `make test`), so each one keeps the poller on.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    bashCalls += 1
    poller ??= $.clock.every(POLL_MS, () => void poll($))
    try {
      const prefix = `${wrap(String(await host($)))}\n`
      return await next(RUNS_XCODEBUILD.test(e.command) ? { ...e, command: prefix + e.command } : e)
    } finally {
      bashCalls -= 1
    }
  })

  // Settings rules judge the command as the model wrote it, not with the wrapper in front: the engine's
  // verdict is replaced by a query on the bare command. A query runs no PreToolUse hook and knows no
  // subagent, so a hook's verdict and a subagent's are kept as they are, judged with the wrapper.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const { command } = e.input as { command?: unknown }
    const prefix = `${wrap(String(await host($)))}\n`
    if (typeof command !== 'string' || !command.startsWith(prefix) || verdict.hook || e.agentId) return verdict
    return $.tool.check({ tool: 'Bash', input: { ...(e.input as object), command: command.slice(prefix.length) } })
  })

  // The engine's own hint line stays live; the status is drawn after it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const segments = await read($, line)
    const hint = await next(e)
    if (!segments) return hint

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {hint}
        <Text wrap="truncate-end">
          {'   '}
          {segments.map((s, i) => (
            <Text key={String(i)} color={s.color} bold={s.bold}>
              {s.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
