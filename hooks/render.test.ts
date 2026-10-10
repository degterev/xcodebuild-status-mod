import { expect, test } from 'claude-code/testing'

const HINT = { component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

const LINE = [
  { text: '✓ TEST SUCCEEDED 4/4', color: 'success', bold: true },
  { text: '  in 0:12', color: 'subtle' },
]

test('draws the status after the engine hint line, in color', async ($, on) => {
  on('state.get', () => ({ value: { value: LINE, version: 1 } }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'xcodebuild-status', surface, ...HINT })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.find({ type: 'Text', text: /TEST SUCCEEDED 4\/4/ })).toBeDefined()
    await ui.unmount()
  }
})
