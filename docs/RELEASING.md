# Releasing Jean

A release is a git tag. Pushing one builds Jean for every platform, starts each binary once, and publishes:

- **npm**: `jean-code-<os>-<cpu>` for each platform, then `jean-code`, so `npm install -g jean-code` gives a working `jean`;
- **a GitHub release** with the archives that `install.sh` and `install.ps1` download.

## Once: the npm token

1. On npmjs.com, sign in (or create the account that will own `jean-code`), then **Access Tokens → Generate New Token → Granular Access Token** with read and write access to packages. For the first publish the token must be allowed to create new packages.
2. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**, named `NPM_TOKEN`, with the token as its value.

## Each release

1. Set the version in `package.json`.
2. Tag and push:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Watch the **Release** workflow under **Actions**. Six build jobs run, one per platform, and the publish job starts only when all of them passed.

To try the builds without publishing: **Actions → Release → Run workflow**, enter a version, and leave **publish** unticked.

## Building locally

```bash
bun run release:build                      # this machine only → dist/
bun install --os='*' --cpu='*'             # once, for the next line
bun run release:build --all                # every platform (without the Rust core)
bun run release:build --native             # this machine, with the Rust core beside it
```

`dist/npm/` holds the packages and `dist/release/` the archives. To try an install from them without publishing:

```bash
npm install -g ./dist/npm/jean-code-linux-x64 ./dist/npm/jean-code   # use your platform's folder
JEAN_RELEASE_URL=http://127.0.0.1:8000 sh install.sh                 # after serving dist/release on port 8000
```

## What each platform gets

| Platform | Built on | Rust core |
|---|---|---|
| linux-x64, linux-arm64 | Linux runners of that architecture | built natively |
| darwin-arm64 | macOS (Apple Silicon) | built natively |
| darwin-x64 | macOS (Apple Silicon) | cross-compiled |
| win32-x64, win32-arm64 | Windows runners of that architecture | built natively |

x64 builds use Bun's baseline target, so they also run on CPUs without AVX2. The Linux builds need glibc; on musl systems (Alpine), the installers build from source.
