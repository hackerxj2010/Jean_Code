/**
 * Loaded before every test file (`bunfig.toml`).
 *
 * The language-server and debugger engines install what is missing into
 * `~/.jean/tools` on first use. A test that writes a `.py` file must not
 * download Pyright as a side effect, so the suite runs with installs off;
 * tests that exercise installing turn it back on for themselves.
 */
process.env.JEAN_DISABLE_LSP_DOWNLOAD ??= '1'
