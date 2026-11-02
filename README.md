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

- While a Bash call is running, or a build it started is alive, the mod polls `ps` every two seconds,
  finds the `xcodebuild` processes that belong to this session, and reads what they write. It stops polling
  when there is nothing to watch.
- A build whose stdout goes to a file (the Bash tool's own output file, `> log`) is read from that file.
  One writing to a pipe (`xcodebuild … | tail -20`) or a terminal shows only the compiler phase.
- Claude's commands are never changed, so permission rules and auto mode judge exactly what Claude wrote.

## Permissions

- **Runs commands** through `$.process`: `ps`, `lsof`, `wc`, `tail`, and `sh -c 'echo $PPID'`,
  only while a build may be running.
- **Stores** one number per test command, the last complete run's test count, in the plugin store.
- **No network.**

## Limitations

- An `xcodebuild` a background script starts *after* its Bash call returned is missed.
- Output a redirected build wrote before the first poll saw it is skipped.
- A piped build (`xcodebuild … | tail`) has no step, test count or banner, only the compiler phase and the time.
- Only the first of several concurrent builds is detailed.

## Development

```
claude plugin validate .
claude plugin test .
```

## License

MIT
