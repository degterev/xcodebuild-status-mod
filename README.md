# xcodebuild-status

A Claude Code mod that shows what `xcodebuild` is doing, live, under the prompt.

While Claude runs a build or a test suite you see the current step, or the test progress,
instead of a silent "Running…":

```
⚒ build · App · CompileSwift  0:42
⚒ build · compiling ×6  1:03
⚒ tests ▰▰▰▰▰▰▱▱▱▱ 71/120 · ✗1  1:31
```

When the run ends, its outcome stays until your next prompt:

```
✓ TEST SUCCEEDED 118/120 · 2 skipped  in 1:58
✗ BUILD FAILED · 3 errors  in 0:27
```

## Install

At a Claude Code prompt:

```
/plugin install xcodebuild-status --marketplace degterev/xcodebuild-status-mod
```

Answer `y` to add the marketplace, then pick a scope. Nothing else to configure.

## What it shows

- **Build:** the target and step from the log (`App · CompileSwift`, `AppTests · Ld`), errors as they
  appear, and the elapsed time. Without a log (see below) it reports what the build service is running:
  `compiling ×6` or `linking`.
- **Tests:** finished tests, failures, and a progress bar once a previous run of the same command has
  taught it the total. The first run shows a plain count. XCTest and Swift Testing both count.
- **Several builds at once:** the first one, with `(+1)` for the rest.
- **Result:** the `** TEST SUCCEEDED **` banner (or `FAILED`), passed/total, skipped and error counts,
  and the duration. A run killed partway does not update the remembered total.

## How it works

- Every Bash call Claude makes that runs `xcodebuild` gets a one-line shell function prepended, which
  tees xcodebuild's stdout into `$TMPDIR/xcodebuild-status/<pid>-<pid>.log`. The build's exit code and
  its output to Claude are unchanged; `xcodebuild … | tail -20` still reports progress. The log is deleted
  when the run ends.
- While a Bash call is running, or a build it started is alive, the mod polls `ps` every two seconds,
  finds the `xcodebuild` processes that belong to this session, and reads their logs. It stops polling
  when there is nothing to watch.
- An `xcodebuild` started without the wrapper (from a script or `make test`) is still found by process
  tree. If its stdout is redirected to a file, that file is read; otherwise only the compiler phase is shown.
- Permission rules and `/permissions` prompts judge the command exactly as Claude wrote it, without the
  wrapper in front.

## Permissions

- **Runs commands** through `$.process`: `ps`, `lsof`, `wc`, `tail`, `rm`, and `sh -c 'echo $PPID'`,
  only while a build may be running.
- **Prepends** a shell function to Bash commands that run `xcodebuild` (plain `sh` builtins plus `tee`).
- **Stores** one number per test command, the last complete run's test count, in the plugin store.
- **No network.**

## Limitations

- An `xcodebuild` a background script starts *after* its Bash call returned is missed.
- Output a redirected build wrote before the first poll saw it is skipped.
- Logs orphaned by a killed Claude session stay in `$TMPDIR/xcodebuild-status/`.
- Only the first of several concurrent builds is detailed.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
