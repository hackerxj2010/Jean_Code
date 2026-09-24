# Third-party notices

Jean Code is MIT-licensed. Parts of it are derived from other projects under
their own licenses, listed here as those licenses require.

## Codebuff

`packages/tui2` — the full-screen terminal interface — is
derived from the CLI of [Codebuff](https://github.com/CodebuffAI/codebuff),
licensed under the Apache License, Version 2.0. The full license text is in
[`licenses/codebuff-APACHE-2.0.txt`](licenses/codebuff-APACHE-2.0.txt).

The files have been modified for Jean Code: the agent behind the interface is
Jean's (`packages/tui2/src/compat/`), branding and several commands were
changed, and Jean-specific commands were added (`packages/tui2/src/commands/jean.ts`).

Codebuff's NOTICE file reads:

```
Codebuff
Copyright 2025 Codebuff

This product includes software developed for the Codebuff project.
```

Upstream copyright: Copyright 2025 Manicode, Inc.
