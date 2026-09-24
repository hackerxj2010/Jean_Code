/**
 * A language server for a tiny made-up language, speaking real LSP over
 * stdio — enough of the protocol that every operation of `crates/pi-lsp` can
 * be driven end to end, deterministically, without installing a real server.
 *
 * The language, in `.mock` files:
 *
 *   def NAME            declares NAME (indent by two to nest inside the def above)
 *   use NAME            references NAME
 *   A calls B           A calls B (for call hierarchy)
 *   import "file"       imports another file (for willRenameFiles)
 *   ERROR / WARN        produce an error / a warning diagnostic
 *   CRASH               makes the server exit when the file is opened
 *
 * The server also exercises the client's side of the protocol: it asks for
 * its configuration, registers a capability dynamically, reports progress,
 * and applies an edit through `workspace/applyEdit`.
 */

const docs = new Map() // uri -> text
let buffer = Buffer.alloc(0)
let nextId = 1000
const waiting = new Map()
let config = null
// Settles once the client has answered `workspace/configuration`; requests
// that depend on settings wait for it, as real servers do.
let configured
const configReady = new Promise((resolve) => {
  configured = resolve
})

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function request(method, params) {
  const id = nextId++
  send({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

const lines = (text) => text.split(/\r?\n/)
const word = /[A-Za-z_][A-Za-z0-9_]*/g

function wordAt(uri, position) {
  const line = lines(docs.get(uri) ?? '')[position.line] ?? ''
  for (const match of line.matchAll(word)) {
    if (position.character >= match.index && position.character <= match.index + match[0].length) {
      return { word: match[0], start: match.index }
    }
  }
  return undefined
}

function range(line, start, length) {
  return { start: { line, character: start }, end: { line, character: start + length } }
}

function occurrences(name) {
  const found = []
  for (const [uri, text] of docs) {
    lines(text).forEach((line, index) => {
      for (const match of line.matchAll(word)) {
        if (match[0] === name) found.push({ uri, line: index, start: match.index, isDef: /^\s*def\s/.test(line) })
      }
    })
  }
  return found
}

function declaration(name) {
  return occurrences(name).find((o) => o.isDef)
}

function publish(uri) {
  const diagnostics = []
  lines(docs.get(uri) ?? '').forEach((line, index) => {
    const error = line.indexOf('ERROR')
    if (error >= 0) diagnostics.push({ range: range(index, error, 5), severity: 1, message: 'found ERROR', source: 'mock', code: 'E1' })
    const warn = line.indexOf('WARN')
    if (warn >= 0) diagnostics.push({ range: range(index, warn, 4), severity: 2, message: 'found WARN', source: 'mock' })
  })
  // Asynchronous, as real servers are: the client has to wait for it.
  setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } }), 80)
}

function symbolsOf(uri) {
  const out = []
  const stack = []
  lines(docs.get(uri) ?? '').forEach((line, index) => {
    const match = /^(\s*)def\s+([A-Za-z_]\w*)/.exec(line)
    if (!match) return
    const depth = match[1].length / 2
    const start = match[1].length + 4
    const symbol = {
      name: match[2],
      kind: depth === 0 ? 5 : 6,
      range: range(index, 0, line.length),
      selectionRange: range(index, start, match[2].length),
      children: [],
    }
    while (stack.length > depth) stack.pop()
    if (stack.length === 0) out.push(symbol)
    else stack[stack.length - 1].children.push(symbol)
    stack.push(symbol)
  })
  return out
}

function callItem(name) {
  const decl = declaration(name)
  if (!decl) return undefined
  return { name, kind: 12, uri: decl.uri, range: range(decl.line, 0, 4 + name.length), selectionRange: range(decl.line, decl.start, name.length) }
}

async function handle(message) {
  const { id, method, params } = message
  if (method === undefined && id !== undefined) {
    waiting.get(id)?.(message.result)
    waiting.delete(id)
    return
  }
  const reply = (result) => send({ id, result })

  switch (method) {
    case 'initialize':
      reply({
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          hoverProvider: true,
          definitionProvider: true,
          typeDefinitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          renameProvider: { prepareProvider: true },
          codeActionProvider: { resolveProvider: true },
          documentFormattingProvider: true,
          completionProvider: {},
          signatureHelpProvider: { triggerCharacters: ['('] },
          callHierarchyProvider: true,
          documentHighlightProvider: true,
          inlayHintProvider: true,
          executeCommandProvider: { commands: ['mock.fixAll'] },
          workspace: { fileOperations: { willRename: { filters: [{ pattern: { glob: '**/*.mock' } }] } } },
        },
        serverInfo: { name: 'mock-lsp', version: '1.0' },
      })
      return
    case 'initialized': {
      const [section] = await request('workspace/configuration', { items: [{ section: 'mock' }] })
      config = section
      configured()
      await request('client/registerCapability', {
        registrations: [{ id: 'watch', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*' }] } }],
      })
      await request('window/workDoneProgress/create', { token: 'index' })
      send({ method: '$/progress', params: { token: 'index', value: { kind: 'begin', title: 'indexing' } } })
      setTimeout(() => send({ method: '$/progress', params: { token: 'index', value: { kind: 'end' } } }), 30)
      return
    }
    case 'textDocument/didOpen':
      if (params.textDocument.text.includes('CRASH')) process.exit(3)
      docs.set(params.textDocument.uri, params.textDocument.text)
      publish(params.textDocument.uri)
      return
    case 'textDocument/didChange':
      docs.set(params.textDocument.uri, params.contentChanges[params.contentChanges.length - 1].text)
      publish(params.textDocument.uri)
      return
    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri)
      return
    case 'textDocument/didSave':
    case 'workspace/didChangeWatchedFiles':
    case 'workspace/didChangeConfiguration':
    case 'workspace/didRenameFiles':
    case '$/cancelRequest':
      return
    case 'textDocument/hover': {
      await configReady
      const at = wordAt(params.textDocument.uri, params.position)
      const decl = at && declaration(at.word)
      reply(decl ? { contents: { kind: 'markdown', value: `\`\`\`mock\ndef ${at.word}\n\`\`\`\nconfigured: ${config?.flavor ?? 'none'}` } } : null)
      return
    }
    case 'textDocument/definition':
    case 'textDocument/typeDefinition': {
      const at = wordAt(params.textDocument.uri, params.position)
      const decl = at && declaration(at.word)
      if (!decl) return reply(null)
      const target = range(decl.line, decl.start, at.word.length)
      reply(
        method === 'textDocument/definition'
          ? { uri: decl.uri, range: target }
          : [{ targetUri: decl.uri, targetRange: range(decl.line, 0, 99), targetSelectionRange: target }],
      )
      return
    }
    case 'textDocument/references': {
      const at = wordAt(params.textDocument.uri, params.position)
      if (!at) return reply([])
      reply(
        occurrences(at.word)
          .filter((o) => params.context.includeDeclaration || !o.isDef)
          .map((o) => ({ uri: o.uri, range: range(o.line, o.start, at.word.length) })),
      )
      return
    }
    case 'textDocument/documentHighlight': {
      const at = wordAt(params.textDocument.uri, params.position)
      if (!at) return reply([])
      reply(
        occurrences(at.word)
          .filter((o) => o.uri === params.textDocument.uri)
          .map((o) => ({ range: range(o.line, o.start, at.word.length), kind: o.isDef ? 3 : 2 })),
      )
      return
    }
    case 'textDocument/documentSymbol':
      reply(symbolsOf(params.textDocument.uri))
      return
    case 'workspace/symbol': {
      const out = []
      for (const uri of docs.keys()) {
        const walk = (symbols) => {
          for (const s of symbols) {
            if (s.name.includes(params.query)) out.push({ name: s.name, kind: s.kind, location: { uri, range: s.selectionRange } })
            walk(s.children)
          }
        }
        walk(symbolsOf(uri))
      }
      reply(out)
      return
    }
    case 'textDocument/prepareRename': {
      const at = wordAt(params.textDocument.uri, params.position)
      reply(at && declaration(at.word) ? range(params.position.line, at.start, at.word.length) : null)
      return
    }
    case 'textDocument/rename': {
      const at = wordAt(params.textDocument.uri, params.position)
      const byUri = new Map()
      for (const o of occurrences(at.word)) {
        byUri.set(o.uri, [...(byUri.get(o.uri) ?? []), { range: range(o.line, o.start, at.word.length), newText: params.newName }])
      }
      reply({ documentChanges: [...byUri].map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits })) })
      return
    }
    case 'textDocument/codeAction': {
      const actions = params.context.diagnostics
        .filter((d) => d.message === 'found ERROR')
        .map((d) => ({ title: 'Replace ERROR with OK', kind: 'quickfix', diagnostics: [d], data: { uri: params.textDocument.uri, line: d.range.start.line } }))
      actions.push({ title: 'Fix all', kind: 'source.fixAll', command: { title: 'Fix all', command: 'mock.fixAll', arguments: [] } })
      reply(actions)
      return
    }
    case 'codeAction/resolve': {
      const { uri, line } = params.data
      const text = lines(docs.get(uri))[line]
      const at = text.indexOf('ERROR')
      reply({ ...params, edit: { changes: { [uri]: [{ range: range(line, at, 5), newText: 'OK' }] } } })
      return
    }
    case 'workspace/executeCommand': {
      const changes = {}
      for (const [uri, text] of docs) {
        const edits = []
        lines(text).forEach((line, index) => {
          for (const match of line.matchAll(/ERROR/g)) edits.push({ range: range(index, match.index, 5), newText: 'OK' })
        })
        if (edits.length) changes[uri] = edits
      }
      await request('workspace/applyEdit', { label: 'Fix all', edit: { changes } })
      reply(null)
      return
    }
    case 'textDocument/formatting': {
      const edits = []
      lines(docs.get(params.textDocument.uri) ?? '').forEach((line, index) => {
        const trimmed = line.replace(/[ \t]+$/, '')
        if (trimmed !== line) edits.push({ range: range(index, trimmed.length, line.length - trimmed.length), newText: '' })
      })
      reply(edits)
      return
    }
    case 'textDocument/completion': {
      const names = new Set()
      for (const text of docs.values()) for (const m of text.matchAll(/def\s+(\w+)/g)) names.add(m[1])
      reply({ isIncomplete: false, items: [...names].map((label) => ({ label, kind: 3, detail: 'mock function' })).concat([{ label: 'def', kind: 14 }]) })
      return
    }
    case 'textDocument/signatureHelp':
      reply({ signatures: [{ label: 'fn(first, second)', parameters: [{ label: [3, 8] }, { label: 'second' }] }], activeSignature: 0, activeParameter: 1 })
      return
    case 'textDocument/prepareCallHierarchy': {
      const at = wordAt(params.textDocument.uri, params.position)
      const item = at && callItem(at.word)
      reply(item ? [item] : null)
      return
    }
    case 'callHierarchy/incomingCalls':
    case 'callHierarchy/outgoingCalls': {
      const out = []
      for (const [uri, text] of docs) {
        lines(text).forEach((line, index) => {
          const match = /^(\w+) calls (\w+)/.exec(line)
          if (!match) return
          const [, caller, callee] = match
          if (method === 'callHierarchy/incomingCalls' && callee === params.item.name) {
            const from = callItem(caller)
            if (from) out.push({ from, fromRanges: [range(index, line.indexOf(callee), callee.length)] })
          }
          if (method === 'callHierarchy/outgoingCalls' && caller === params.item.name) {
            const to = callItem(callee)
            if (to) out.push({ to, fromRanges: [range(index, line.indexOf(callee), callee.length)] })
          }
        })
      }
      reply(out)
      return
    }
    case 'textDocument/inlayHint': {
      const hints = []
      lines(docs.get(params.textDocument.uri) ?? '').forEach((line, index) => {
        if (/^\s*def\s/.test(line)) hints.push({ position: { line: index, character: line.length }, label: ': fn', kind: 1 })
      })
      reply(hints)
      return
    }
    case 'workspace/willRenameFiles': {
      const changes = {}
      for (const file of params.files) {
        const from = file.oldUri.split('/').pop()
        const to = file.newUri.split('/').pop()
        for (const [uri, text] of docs) {
          lines(text).forEach((line, index) => {
            const at = line.indexOf(`import "${from}"`)
            if (at >= 0) (changes[uri] ??= []).push({ range: range(index, at + 8, from.length), newText: to })
          })
        }
      }
      reply(Object.keys(changes).length ? { changes } : null)
      return
    }
    case 'shutdown':
      reply(null)
      return
    case 'exit':
      process.exit(0)
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no handler for ${method}` } })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)
    let message
    try {
      message = JSON.parse(body)
    } catch {
      continue
    }
    // A handler that throws answers with an error, as a real server does,
    // rather than taking the process down.
    handle(message).catch((error) => {
      if (message.id !== undefined && message.method !== undefined) {
        send({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } })
      }
    })
  }
})
