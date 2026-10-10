/** One colored piece of the status; `color` a theme key (`success`, `error`, `subtle`, ...). */
export type Segment = { text: string; color?: string; bold?: boolean }

/** The status under the prompt; null while there is nothing to show. */
export type Line = Segment[] | null

declare module 'claude-code' {
  interface PluginState {
    'xcodebuild-status': { line: Line }
  }
}
