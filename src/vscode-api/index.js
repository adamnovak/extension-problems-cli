'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { minimatch } = require('minimatch');

const types = require('./types');
const { TextDocument } = require('./text-document');
const { ConfigurationStore } = require('./configuration');
const { makeStub, permissive, NEVER_FIRES } = require('./stubs');

const { Uri, Disposable, EventEmitter, Position, Range, Selection, FileType, FileSystemError } = types;

// Version of the editor API this module pretends to provide. Extensions
// check it against their `engines.vscode` range.
const API_VERSION = '1.105.0';

const LANGUAGE_BY_EXTENSION = {
  '.c': 'c',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  '.ipp': 'cpp',
  '.inl': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
};

function languageIdForPath(p) {
  return LANGUAGE_BY_EXTENSION[path.extname(p).toLowerCase()] ?? 'plaintext';
}

function toUri(uriOrPath) {
  return typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
}

/**
 * Score how well a vscode.DocumentSelector matches a document, as
 * vscode.languages.match() does: 0 for no match, higher for better matches.
 */
function matchSelector(selector, document) {
  if (Array.isArray(selector)) {
    return Math.max(0, ...selector.map((s) => matchSelector(s, document)));
  }
  if (typeof selector === 'string') {
    if (selector === '*') return 5;
    return selector === document.languageId ? 10 : 0;
  }
  if (!selector) return 0;
  let score = 0;
  if (selector.language) {
    if (selector.language === document.languageId) score = 10;
    else if (selector.language === '*') score = 5;
    else return 0;
  }
  if (selector.scheme) {
    if (selector.scheme === document.uri.scheme) score = Math.max(score, 10);
    else if (selector.scheme === '*') score = Math.max(score, 5);
    else return 0;
  }
  if (selector.pattern) {
    const pattern = typeof selector.pattern === 'string'
      ? selector.pattern
      : path.join(selector.pattern.base, selector.pattern.pattern);
    if (minimatch(document.uri.fsPath, pattern, { dot: true, matchBase: !pattern.includes('/') })) {
      score = Math.max(score, 10);
    } else {
      return 0;
    }
  }
  if (selector.notebookType) return 0;
  return score;
}

class DiagnosticCollection {
  constructor(name, onChange) {
    this.name = name;
    this._entries = new Map();
    this._onChange = onChange;
  }

  set(uriOrEntries, diagnostics) {
    if (Array.isArray(uriOrEntries)) {
      for (const [uri, diags] of uriOrEntries) {
        this.set(uri, diags);
      }
      return;
    }
    const key = uriOrEntries.toString();
    if (diagnostics === undefined || diagnostics === null) {
      this._entries.delete(key);
    } else {
      this._entries.set(key, { uri: uriOrEntries, diagnostics: [...diagnostics] });
    }
    this._onChange(this, uriOrEntries);
  }

  delete(uri) {
    this._entries.delete(uri.toString());
    this._onChange(this, uri);
  }

  clear() {
    const uris = [...this._entries.values()].map((e) => e.uri);
    this._entries.clear();
    for (const uri of uris) this._onChange(this, uri);
  }

  get(uri) {
    return this._entries.get(uri.toString())?.diagnostics;
  }

  has(uri) {
    return this._entries.has(uri.toString());
  }

  forEach(callback, thisArg) {
    for (const { uri, diagnostics } of this._entries.values()) {
      callback.call(thisArg, uri, diagnostics, this);
    }
  }

  *[Symbol.iterator]() {
    for (const { uri, diagnostics } of this._entries.values()) {
      yield [uri, diagnostics];
    }
  }

  dispose() {
    this.clear();
  }
}

/**
 * Persistent key-value storage for vscode.Memento. Values are written
 * through to a JSON file so that they survive between runs, as they do in
 * the editor.
 */
class FileMemento {
  constructor(file) {
    this._file = file;
    try {
      this._data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this._data = {};
    }
  }

  keys() { return Object.keys(this._data); }

  get(key, defaultValue) {
    return key in this._data ? structuredClone(this._data[key]) : defaultValue;
  }

  update(key, value) {
    if (value === undefined) delete this._data[key];
    else this._data[key] = structuredClone(value);
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2));
    return Promise.resolve();
  }

  setKeysForSync() {}
}

/**
 * The editor state an extension can observe and the `vscode` module that
 * exposes it.
 *
 * Construct one per process; `api` is what `require('vscode')` returns.
 */
class Workbench {
  /**
   * @param {object} options
   * @param {string[]} options.workspaceFolders Absolute directory paths.
   * @param {string} options.stateDir Directory for persistent machine state.
   * @param {(channel: string, text: string) => void} options.log Receives
   *   everything written to output channels and every user-facing message.
   * @param {(what: string) => void} options.reportMissing Called on each use
   *   of an API member this module does not implement.
   */
  constructor({ workspaceFolders, stateDir, log, reportMissing }) {
    this.log = log;
    this.reportMissing = reportMissing;
    this.stateDir = stateDir;
    this.configuration = new ConfigurationStore();
    this.workspaceFolders = workspaceFolders.map((p, index) => ({
      uri: Uri.file(p),
      name: path.basename(p),
      index,
    }));

    // Opened documents, keyed by URI string.
    this.documents = new Map();
    this.visibleEditors = [];
    this.activeEditor = undefined;
    this.diagnosticCollections = new Set();
    this.commands = new Map();
    this.extensions = [];
    // Number of window.withProgress() tasks that have not finished.
    this.progressInFlight = 0;

    this.emitters = {};
    for (const name of [
      'openTextDocument', 'closeTextDocument', 'changeTextDocument', 'saveTextDocument',
      'changeVisibleTextEditors', 'changeActiveTextEditor', 'changeDiagnostics',
      'diagnosticsSet', 'progressChange',
    ]) {
      this.emitters[name] = new EventEmitter();
    }

    this.api = this._buildApi();
  }

  _report(what) {
    this.reportMissing(what);
  }

  _permissive(obj, name) {
    return permissive(obj, name, (what) => this._report(what));
  }

  async openDocument(uriOrPath) {
    const uri = toUri(uriOrPath);
    const key = uri.toString();
    if (this.documents.has(key)) {
      return this.documents.get(key);
    }
    if (uri.scheme !== 'file') {
      throw FileSystemError.Unavailable(uri);
    }
    const text = await fs.promises.readFile(uri.fsPath, 'utf8');
    if (this.documents.has(key)) {
      return this.documents.get(key);
    }
    const doc = new TextDocument(uri, languageIdForPath(uri.fsPath), text);
    this.documents.set(key, doc);
    this.emitters.openTextDocument.fire(doc);
    return doc;
  }

  showDocument(doc) {
    let editor = this.visibleEditors.find((e) => e.document === doc);
    if (!editor) {
      const selection = new Selection(0, 0, 0, 0);
      editor = this._permissive({
        document: doc,
        selection,
        selections: [selection],
        visibleRanges: [new Range(0, 0, Math.min(doc.lineCount - 1, 50), 0)],
        options: { tabSize: 4, insertSpaces: true },
        viewColumn: types.ViewColumn.One,
        edit: () => Promise.resolve(false),
        insertSnippet: () => Promise.resolve(false),
        setDecorations: () => {},
        revealRange: () => {},
        show: () => {},
        hide: () => {},
      }, 'TextEditor');
      this.visibleEditors = [...this.visibleEditors, editor];
      this.emitters.changeVisibleTextEditors.fire(this.visibleEditors);
    }
    if (this.activeEditor !== editor) {
      this.activeEditor = editor;
      this.emitters.changeActiveTextEditor.fire(editor);
    }
    return editor;
  }

  _onDiagnosticsChanged(collection, uri) {
    this.emitters.diagnosticsSet.fire({ collection, uri });
    this.emitters.changeDiagnostics.fire({ uris: [uri] });
  }

  getDiagnostics(uri) {
    if (uri) {
      return [...this.diagnosticCollections].flatMap((c) => c.get(uri) ?? []);
    }
    const byUri = new Map();
    for (const c of this.diagnosticCollections) {
      c.forEach((u, diags) => {
        const key = u.toString();
        if (!byUri.has(key)) byUri.set(key, [u, []]);
        byUri.get(key)[1].push(...diags);
      });
    }
    return [...byUri.values()];
  }

  /**
   * Run a command registered by an extension, or one of the editor's own
   * commands that this module knows about. Unknown commands resolve to
   * undefined.
   */
  async executeCommand(id, ...args) {
    const registered = this.commands.get(id);
    if (registered) {
      return registered.callback.apply(registered.thisArg, args);
    }
    switch (id) {
      case 'setContext':
        return undefined;
      case 'vscode.open':
        if (args[0]) await this.openDocument(args[0]).then((d) => this.showDocument(d), () => {});
        return undefined;
      default:
        this._report(`commands.executeCommand(${JSON.stringify(id)})`);
        return undefined;
    }
  }

  _buildApi() {
    const wb = this;
    const e = wb.emitters;

    const workspace = {
      get workspaceFolders() { return wb.workspaceFolders.length ? wb.workspaceFolders : undefined; },
      get name() { return wb.workspaceFolders[0]?.name; },
      get rootPath() { return wb.workspaceFolders[0]?.uri.fsPath; },
      workspaceFile: undefined,
      isTrusted: true,
      get textDocuments() { return [...wb.documents.values()]; },
      notebookDocuments: [],
      getWorkspaceFolder(uri) {
        const p = uri.fsPath;
        return wb.workspaceFolders
          .filter((f) => p === f.uri.fsPath || p.startsWith(f.uri.fsPath + path.sep))
          .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
      },
      asRelativePath(pathOrUri, includeWorkspaceFolder) {
        const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        const folder = workspace.getWorkspaceFolder(Uri.file(p));
        if (!folder) return p;
        const rel = path.relative(folder.uri.fsPath, p);
        return includeWorkspaceFolder && wb.workspaceFolders.length > 1 ? `${folder.name}/${rel}` : rel;
      },
      getConfiguration(section) { return wb.configuration.getConfiguration(section); },
      onDidChangeConfiguration: wb.configuration.onDidChangeConfiguration,
      openTextDocument(arg) {
        if (arg && typeof arg === 'object' && !(arg instanceof Uri) && !arg.scheme) {
          const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${wb.documents.size + 1}` });
          const doc = new TextDocument(uri, arg.language ?? 'plaintext', arg.content ?? '');
          wb.documents.set(uri.toString(), doc);
          e.openTextDocument.fire(doc);
          return Promise.resolve(doc);
        }
        return wb.openDocument(arg);
      },
      onDidOpenTextDocument: e.openTextDocument.event,
      onDidCloseTextDocument: e.closeTextDocument.event,
      onDidChangeTextDocument: e.changeTextDocument.event,
      onDidSaveTextDocument: e.saveTextDocument.event,
      fs: wb._permissive({
        async stat(uri) {
          try {
            const s = await fs.promises.stat(uri.fsPath);
            return {
              type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown,
              ctime: s.ctimeMs,
              mtime: s.mtimeMs,
              size: s.size,
            };
          } catch (err) {
            throw FileSystemError.FileNotFound(uri);
          }
        },
        async readFile(uri) {
          try {
            return new Uint8Array(await fs.promises.readFile(uri.fsPath));
          } catch {
            throw FileSystemError.FileNotFound(uri);
          }
        },
        async writeFile(uri, content) {
          await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.promises.writeFile(uri.fsPath, content);
        },
        async readDirectory(uri) {
          const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((d) => [
            d.name,
            d.isDirectory() ? FileType.Directory : d.isFile() ? FileType.File : FileType.Unknown,
          ]);
        },
        async createDirectory(uri) {
          await fs.promises.mkdir(uri.fsPath, { recursive: true });
        },
        async delete(uri, options) {
          await fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive, force: true });
        },
        async rename(source, target) {
          await fs.promises.rename(source.fsPath, target.fsPath);
        },
        async copy(source, target) {
          await fs.promises.cp(source.fsPath, target.fsPath, { recursive: true });
        },
        isWritableFileSystem: (scheme) => scheme === 'file',
      }, 'workspace.fs'),
      async findFiles(include, exclude, maxResults) {
        const toGlob = (p) => (typeof p === 'string' ? { base: null, pattern: p } : { base: p.baseUri.fsPath, pattern: p.pattern });
        const inc = toGlob(include);
        const exc = exclude ? toGlob(exclude) : null;
        const roots = inc.base ? [inc.base] : wb.workspaceFolders.map((f) => f.uri.fsPath);
        const results = [];
        for (const root of roots) {
          for (const rel of await fs.promises.readdir(root, { recursive: true })) {
            if (maxResults !== undefined && results.length >= maxResults) return results;
            const full = path.join(root, rel);
            if (!minimatch(rel, inc.pattern, { dot: true })) continue;
            if (exc && minimatch(exc.base ? path.relative(exc.base, full) : rel, exc.pattern, { dot: true })) continue;
            if (!(await fs.promises.stat(full)).isFile()) continue;
            results.push(Uri.file(full));
          }
        }
        return results;
      },
      createFileSystemWatcher() {
        return {
          ignoreCreateEvents: false,
          ignoreChangeEvents: false,
          ignoreDeleteEvents: false,
          onDidCreate: NEVER_FIRES,
          onDidChange: NEVER_FIRES,
          onDidDelete: NEVER_FIRES,
          dispose() {},
        };
      },
      applyEdit() {
        wb._report('workspace.applyEdit');
        return Promise.resolve(false);
      },
      saveAll() { return Promise.resolve(true); },
    };

    const makeOutputChannel = (name, options) => {
      let pending = '';
      const emit = (text) => wb.log(name, text);
      const level = { value: types.LogLevel.Info };
      const logAt = (label) => (message, ...args) => {
        const rest = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)));
        emit(`[${label}] ${[message, ...rest].join(' ')}`);
      };
      const channel = {
        name,
        append(text) {
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) emit(line);
        },
        appendLine(text) {
          emit(pending + text);
          pending = '';
        },
        replace(text) { pending = ''; emit(text); },
        clear() {},
        show() {},
        hide() {},
        dispose() {},
      };
      if (options && typeof options === 'object' && options.log) {
        Object.assign(channel, {
          get logLevel() { return level.value; },
          onDidChangeLogLevel: NEVER_FIRES,
          trace: logAt('trace'),
          debug: logAt('debug'),
          info: logAt('info'),
          warn: logAt('warning'),
          error: logAt('error'),
        });
      }
      return wb._permissive(channel, 'OutputChannel');
    };

    const showMessage = (kind) => (message, ...rest) => {
      const items = rest.filter((r) => typeof r === 'string' || (r && typeof r === 'object' && 'title' in r));
      const labels = items.map((i) => (typeof i === 'string' ? i : i.title));
      wb.log(`window.show${kind}Message`, labels.length ? `${message} [${labels.join(' | ')}]` : message);
      // Nobody is there to click a button, so every message is dismissed.
      return Promise.resolve(undefined);
    };

    const makeEventfulObject = (name, fields) => wb._permissive({ dispose() {}, ...fields }, name);

    const window = {
      get activeTextEditor() { return wb.activeEditor; },
      get visibleTextEditors() { return wb.visibleEditors; },
      onDidChangeActiveTextEditor: e.changeActiveTextEditor.event,
      onDidChangeVisibleTextEditors: e.changeVisibleTextEditors.event,
      state: { focused: true, active: true },
      activeColorTheme: { kind: types.ColorThemeKind.Dark },
      terminals: [],
      tabGroups: wb._permissive({
        all: [],
        activeTabGroup: { tabs: [], isActive: true, viewColumn: types.ViewColumn.One },
        onDidChangeTabs: NEVER_FIRES,
        onDidChangeTabGroups: NEVER_FIRES,
        close: () => Promise.resolve(true),
      }, 'window.tabGroups'),
      createOutputChannel: makeOutputChannel,
      showInformationMessage: showMessage('Information'),
      showWarningMessage: showMessage('Warning'),
      showErrorMessage: showMessage('Error'),
      showQuickPick: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(undefined),
      showOpenDialog: () => Promise.resolve(undefined),
      showSaveDialog: () => Promise.resolve(undefined),
      async showTextDocument(docOrUri) {
        const doc = docOrUri instanceof TextDocument ? docOrUri : await wb.openDocument(docOrUri);
        return wb.showDocument(doc);
      },
      async withProgress(options, task) {
        const source = new types.CancellationTokenSource();
        const progress = {
          report(value) {
            if (value?.message) wb.log('window.withProgress', `${options.title ?? ''} ${value.message}`.trim());
          },
        };
        wb.progressInFlight++;
        e.progressChange.fire(wb.progressInFlight);
        if (options.title) wb.log('window.withProgress', `start: ${options.title}`);
        try {
          return await task(progress, source.token);
        } finally {
          wb.progressInFlight--;
          if (options.title) wb.log('window.withProgress', `end: ${options.title}`);
          e.progressChange.fire(wb.progressInFlight);
        }
      },
      createStatusBarItem: () => makeEventfulObject('StatusBarItem', {
        text: '', tooltip: undefined, command: undefined, show() {}, hide() {},
      }),
      createTreeView: (viewId) => makeEventfulObject(`TreeView(${viewId})`, {
        visible: false,
        selection: [],
        onDidChangeVisibility: NEVER_FIRES,
        onDidChangeSelection: NEVER_FIRES,
        onDidExpandElement: NEVER_FIRES,
        onDidCollapseElement: NEVER_FIRES,
        onDidChangeCheckboxState: NEVER_FIRES,
        reveal: () => Promise.resolve(),
      }),
      registerTreeDataProvider: () => new Disposable(() => {}),
      registerWebviewViewProvider: () => new Disposable(() => {}),
      registerUriHandler: () => new Disposable(() => {}),
      registerFileDecorationProvider: () => new Disposable(() => {}),
      createTextEditorDecorationType: () => ({ key: crypto.randomUUID(), dispose() {} }),
    };

    const languages = {
      createDiagnosticCollection(name) {
        const c = new DiagnosticCollection(name ?? `collection${wb.diagnosticCollections.size}`,
          (coll, uri) => wb._onDiagnosticsChanged(coll, uri));
        const dispose = c.dispose.bind(c);
        c.dispose = () => {
          dispose();
          wb.diagnosticCollections.delete(c);
        };
        wb.diagnosticCollections.add(c);
        return c;
      },
      getDiagnostics: (uri) => wb.getDiagnostics(uri),
      onDidChangeDiagnostics: e.changeDiagnostics.event,
      match: matchSelector,
      getLanguages: () => Promise.resolve([...new Set(Object.values(LANGUAGE_BY_EXTENSION)), 'plaintext']),
      setTextDocumentLanguage: (doc) => Promise.resolve(doc),
    };
    const commands = {
      registerCommand(id, callback, thisArg) {
        wb.commands.set(id, { callback, thisArg });
        return new Disposable(() => wb.commands.delete(id));
      },
      registerTextEditorCommand(id, callback, thisArg) {
        return commands.registerCommand(id, (...args) => {
          if (wb.activeEditor) return callback.call(thisArg, wb.activeEditor, { replace() {}, insert() {}, delete() {} }, ...args);
          return undefined;
        });
      },
      executeCommand: (id, ...args) => wb.executeCommand(id, ...args),
      getCommands: () => Promise.resolve([...wb.commands.keys()]),
    };

    const machineIdFile = path.join(wb.stateDir, 'machine-id');
    let machineId;
    try {
      machineId = fs.readFileSync(machineIdFile, 'utf8').trim();
    } catch {
      machineId = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(wb.stateDir, { recursive: true });
      fs.writeFileSync(machineIdFile, machineId);
    }

    const env = {
      appName: 'Visual Studio Code',
      appRoot: path.resolve(__dirname, '..', '..'),
      appHost: 'desktop',
      uriScheme: 'vscode',
      language: 'en',
      machineId,
      sessionId: crypto.randomUUID(),
      isNewAppInstall: false,
      // The editor-wide telemetry switch is off.
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: NEVER_FIRES,
      logLevel: types.LogLevel.Info,
      onDidChangeLogLevel: NEVER_FIRES,
      remoteName: undefined,
      shell: process.env.SHELL ?? '/bin/sh',
      uiKind: types.UIKind.Desktop,
      clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
      openExternal(uri) {
        wb.log('env.openExternal', uri.toString());
        return Promise.resolve(false);
      },
      asExternalUri: (uri) => Promise.resolve(uri),
      createTelemetryLogger: () => wb._permissive({
        isUsageEnabled: false,
        isErrorsEnabled: false,
        onDidChangeEnableStates: NEVER_FIRES,
        logUsage() {},
        logError() {},
        dispose() {},
      }, 'TelemetryLogger'),
    };

    const extensions = {
      getExtension: (id) => wb.extensions.find((x) => x.id.toLowerCase() === String(id).toLowerCase()),
      get all() { return wb.extensions; },
      onDidChange: NEVER_FIRES,
    };

    const l10n = {
      t(...args) {
        const opts = typeof args[0] === 'object' ? args[0] : { message: args[0], args: args.slice(1) };
        const values = opts.args ?? [];
        return String(opts.message).replace(/\{(\w+)\}/g, (m, k) => {
          const v = Array.isArray(values) ? values[k] : values[k];
          return v === undefined ? m : String(v);
        });
      },
      bundle: undefined,
      uri: undefined,
    };

    const api = {
      ...types,
      version: API_VERSION,
      workspace: wb._permissive(workspace, 'workspace'),
      window: wb._permissive(window, 'window'),
      languages: wb._permissive(languages, 'languages'),
      commands: wb._permissive(commands, 'commands'),
      env: wb._permissive(env, 'env'),
      extensions: wb._permissive(extensions, 'extensions'),
      l10n,
    };
    return wb._permissive(api, 'vscode');
  }

  /**
   * Make the vscode.ExtensionContext and vscode.Extension objects for an
   * extension unpacked at `extensionPath`, and register the extension so
   * vscode.extensions.getExtension() can find it.
   */
  addExtension(extensionPath, manifest) {
    const id = `${manifest.publisher}.${manifest.name}`;
    const storageRoot = path.join(this.stateDir, 'extensions', id);
    const globalStorage = path.join(storageRoot, 'globalStorage');
    const workspaceStorage = path.join(storageRoot, 'workspaceStorage',
      crypto.createHash('sha256').update(this.workspaceFolders.map((f) => f.uri.fsPath).join('\0')).digest('hex').slice(0, 16));
    const logs = path.join(storageRoot, 'logs');
    for (const d of [globalStorage, workspaceStorage, logs]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.configuration.addDefaultsFromManifest(manifest);

    const extension = {
      id,
      extensionUri: Uri.file(extensionPath),
      extensionPath,
      packageJSON: manifest,
      extensionKind: types.ExtensionKind.Workspace,
      isActive: false,
      exports: undefined,
      activate: () => Promise.resolve(extension.exports),
    };
    this.extensions.push(extension);

    const secrets = new Map();
    const context = this._permissive({
      subscriptions: [],
      extension,
      extensionPath,
      extensionUri: extension.extensionUri,
      extensionMode: types.ExtensionMode.Production,
      asAbsolutePath: (rel) => path.join(extensionPath, rel),
      globalState: new FileMemento(path.join(storageRoot, 'globalState.json')),
      workspaceState: new FileMemento(path.join(workspaceStorage, 'workspaceState.json')),
      secrets: {
        get: (k) => Promise.resolve(secrets.get(k)),
        store: (k, v) => { secrets.set(k, v); return Promise.resolve(); },
        delete: (k) => { secrets.delete(k); return Promise.resolve(); },
        onDidChange: NEVER_FIRES,
      },
      globalStorageUri: Uri.file(globalStorage),
      globalStoragePath: globalStorage,
      storageUri: Uri.file(workspaceStorage),
      storagePath: workspaceStorage,
      logUri: Uri.file(logs),
      logPath: logs,
      environmentVariableCollection: makeStub('ExtensionContext.environmentVariableCollection', (w) => this._report(w)),
      languageModelAccessInformation: makeStub('ExtensionContext.languageModelAccessInformation', (w) => this._report(w)),
    }, 'ExtensionContext');
    return { extension, context };
  }
}

module.exports = { Workbench, languageIdForPath, matchSelector, API_VERSION };
