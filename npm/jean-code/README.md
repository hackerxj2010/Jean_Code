# Jean Code

A coding agent for your terminal: it reads your project, edits files, runs commands, and keeps working until the task is done.

## Install

```bash
npm install -g jean-code
```

Then, in any project:

```bash
jean
```

npm downloads a single prebuilt program for your platform (Linux, macOS, and Windows, on x64 and ARM). Nothing else is needed: no Bun, no Rust, no build.

## First run

Give Jean one model key. It is asked for without echoing, checked against the provider, and saved in `~/.jean/auth.json`:

```bash
jean auth login openrouter    # or opencode, anthropic, openai, google, and 200+ more
```

Then:

```bash
jean                          # the full-screen interface
jean "fix the failing test in auth.test.ts"
jean -p "what does this service do?"   # one answer, printed, no interface
jean --help
```

`jean doctor` shows which keys, config files, and optional tools it found.

## Update

```bash
npm install -g jean-code@latest
```

## More

Source, documentation, and other ways to install: https://github.com/hackerxj2010/Jean_Code
