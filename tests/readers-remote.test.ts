import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { defaultConfig } from '../packages/config/src/index.ts'
import {
  type GitHubClient,
  createGitHubReadSource,
  parseGitHubPath,
} from '../packages/github/src/index.ts'
import {
  PdfError,
  extractPdfText,
  parseSshPath,
  sshCommand,
} from '../packages/readers/src/index.ts'
import { createUrlReadSource } from '../packages/search/src/index.ts'
import { createSessionState, readTool, registerReadSource } from '../packages/tools/src/index.ts'

/**
 * What `read` reaches beyond local text files: PDFs, web pages, pull
 * requests and issues, and files on other machines over SSH.
 */

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jean-remote-')))
  temps.push(dir)
  return dir
}

const context = (cwd: string) => ({
  cwd,
  config: defaultConfig(),
  session: createSessionState(cwd),
})

// ---- a PDF built by hand ------------------------------------------------------

/**
 * Two pages: the first with a plain content stream and a simple font, the
 * second compressed and drawn with a composite font that only a ToUnicode
 * map can decode. The catalog and page tree sit in a compressed object
 * stream, as PDF 1.5 writers put them.
 */
function samplePdf(trailer = '<< /Root 1 0 R /Size 11 >>'): Buffer {
  const parts: Buffer[] = []
  const add = (text: string | Buffer) =>
    parts.push(typeof text === 'string' ? Buffer.from(text, 'latin1') : text)
  const stream = (num: number, dict: string, data: Buffer) => {
    add(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`)
    add(data)
    add('\nendstream\nendobj\n')
  }
  add('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')

  stream(
    4,
    '',
    Buffer.from(
      'BT /F1 12 Tf 72 700 Td (Hello PDF world) Tj 0 -14 Td [(Sec) -20 (ond) -400 (line)] TJ ET',
      'latin1',
    ),
  )
  stream(
    5,
    '/Filter /FlateDecode',
    deflateSync(
      Buffer.from('BT /F2 10 Tf 50 600 Td <00010002> Tj 0 -12 Td <000300040005> Tj ET', 'latin1'),
    ),
  )
  add(
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
  )
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <004A> <0002> <0065> endbfchar',
    '1 beginbfrange <0003> <0005> <0061> endbfrange',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n')
  stream(7, '', Buffer.from(cmap, 'latin1'))
  add(
    '8 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R >>\nendobj\n',
  )

  // Catalog (1), page tree (2), and pages (3, 9) inside an object stream.
  const objects: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [
      2,
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 /Resources << /Font << /F1 6 0 R /F2 8 0 R >> >> >>',
    ],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'],
    [9, '<< /Type /Page /Parent 2 0 R /Contents [5 0 R] >>'],
  ]
  let body = ''
  const offsets: string[] = []
  for (const [num, text] of objects) {
    offsets.push(`${num} ${body.length}`)
    body += `${text}\n`
  }
  const header = `${offsets.join(' ')}\n`
  stream(
    10,
    `/Type /ObjStm /N ${objects.length} /First ${header.length} /Filter /FlateDecode`,
    deflateSync(Buffer.from(header + body, 'latin1')),
  )
  add(`trailer\n${trailer}\n%%EOF\n`)
  return Buffer.concat(parts)
}

describe('PDFs', () => {
  test('text comes out page by page, through encodings, ToUnicode maps, and object streams', () => {
    const { pages, via } = extractPdfText(samplePdf())
    expect(via).toBe('builtin')
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('Hello PDF world')
    // A kerning gap under a space's width joins; a wide one separates.
    expect(pages[0]).toContain('Second line')
    expect(pages[0]!.split('\n')).toHaveLength(2)
    expect(pages[1]).toBe('Je\nabc')
  })

  test('an encrypted PDF says so rather than returning noise', () => {
    expect(() => extractPdfText(samplePdf('<< /Root 1 0 R /Encrypt 11 0 R >>'))).toThrow(PdfError)
    expect(() => extractPdfText(Buffer.from('not a pdf'))).toThrow('not a PDF')
  })

  test('`read` shows a PDF by page, and pages through it with offset and limit', async () => {
    const dir = workspace()
    writeFileSync(join(dir, 'spec.pdf'), samplePdf())
    const all = await readTool.execute({ path: 'spec.pdf' }, context(dir))
    expect(all.output).toContain('PDF, 2 pages')
    expect(all.output).toContain('--- page 1 ---')
    expect(all.output).toContain('Hello PDF world')
    const second = await readTool.execute({ path: 'spec.pdf', offset: 2, limit: 1 }, context(dir))
    expect(second.output).toContain('--- page 2 ---')
    expect(second.output).not.toContain('Hello PDF world')
  })
})

describe('SSH paths', () => {
  test('only the explicit forms are remote', () => {
    expect(parseSshPath('ssh://deploy@web-1:2222/etc/app.conf')).toEqual({
      user: 'deploy',
      host: 'web-1',
      port: 2222,
      path: '/etc/app.conf',
    })
    expect(parseSshPath('ssh://web-1/~/notes.txt')).toEqual({
      user: undefined,
      host: 'web-1',
      port: undefined,
      path: '~/notes.txt',
    })
    expect(parseSshPath('deploy@web-1:/var/log/app.log')).toEqual({
      user: 'deploy',
      host: 'web-1',
      path: '/var/log/app.log',
    })
    // Local paths, however they look.
    expect(parseSshPath('C:\\Users\\x.txt')).toBeUndefined()
    expect(parseSshPath('src/a:b.ts')).toBeUndefined()
    expect(parseSshPath('https://example.com/x')).toBeUndefined()
  })

  test('the remote command never prompts and quotes the path for the remote shell', () => {
    const args = sshCommand({ user: 'me', host: 'box', port: 22, path: "/tmp/it's here" }, 1024)
    expect(args.slice(0, 4)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'])
    expect(args).toContain('me@box')
    const script = args[args.length - 1]!
    expect(script).toContain(`p='/tmp/it'\\''s here'`)
    expect(script).toContain('head -c 1024')
    expect(sshCommand({ host: 'box', path: '~/x y' }, 10).at(-1)).toContain(`p="$HOME"/'x y'`)
  })
})

describe('pull requests and issues', () => {
  test('pr:// and issue:// name this repository or another', () => {
    expect(parseGitHubPath('pr://42')).toEqual({ kind: 'pr', repo: undefined, number: 42 })
    expect(parseGitHubPath('issue://octo/demo/7')).toEqual({
      kind: 'issue',
      repo: { owner: 'octo', name: 'demo' },
      number: 7,
    })
    expect(parseGitHubPath('pull://octo/demo#9')).toEqual({
      kind: 'pr',
      repo: { owner: 'octo', name: 'demo' },
      number: 9,
    })
    expect(parseGitHubPath('pr://nope')).toBeUndefined()
  })

  test('a pull request reads as one document: description, files, discussion', async () => {
    const api: Record<string, unknown> = {
      '/repos/octo/demo/pulls/9': {
        number: 9,
        title: 'Fix login',
        state: 'open',
        draft: false,
        user: { login: 'ada' },
        head: { ref: 'fix-login' },
        base: { ref: 'main' },
        body: 'Login failed on empty passwords.',
        html_url: 'https://github.com/octo/demo/pull/9',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-02T00:00:00Z',
        additions: 12,
        deletions: 3,
        changed_files: 1,
      },
    }
    const lists: Record<string, unknown[]> = {
      '/repos/octo/demo/pulls/9/files': [
        { filename: 'src/auth.ts', status: 'modified', additions: 12, deletions: 3 },
      ],
      '/repos/octo/demo/issues/9/comments': [
        { user: { login: 'bob' }, body: 'Looks right.', created_at: '2026-09-03T00:00:00Z' },
      ],
      '/repos/octo/demo/pulls/9/comments': [
        {
          user: { login: 'eve' },
          body: 'Guard null here.',
          created_at: '2026-09-02T12:00:00Z',
          path: 'src/auth.ts',
          line: 4,
        },
      ],
    }
    const client = {
      request: async (path: string) => api[path],
      paginate: async (path: string) => lists[path] ?? [],
    } as unknown as GitHubClient
    const source = createGitHubReadSource(client)
    expect(source.matches('pr://octo/demo/9')).toBe(true)
    const result = await source.read('pr://octo/demo/9', {}, context(workspace()))
    expect(result.output).toContain('# octo/demo#9: Fix login')
    expect(result.output).toContain('fix-login → main')
    expect(result.output).toContain('Login failed on empty passwords.')
    expect(result.output).toContain('src/auth.ts')
    // Both kinds of comment, oldest first.
    expect(result.output.indexOf('Guard null here.')).toBeLessThan(
      result.output.indexOf('Looks right.'),
    )
    expect(result.output).toContain('on src/auth.ts:4')
  })
})

describe('web pages', () => {
  test('`read https://…` returns the page as text', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          '<html><head><title>Docs</title><script>ignore()</script></head><body><h1>Install</h1><p>Run the installer.</p></body></html>',
          { headers: { 'content-type': 'text/html' } },
        ),
    })
    try {
      registerReadSource(createUrlReadSource())
      const result = await readTool.execute(
        { path: `http://127.0.0.1:${server.port}/docs` },
        context(workspace()),
      )
      expect(result.output).toContain('Docs')
      expect(result.output).toContain('Run the installer.')
      expect(result.output).not.toContain('ignore()')
    } finally {
      server.stop(true)
    }
  })
})
