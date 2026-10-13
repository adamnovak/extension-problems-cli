/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const types = require('./types');
const { TextDocument } = require('./text-document');
const { ConfigurationStore } = require('./configuration');
const { permissive, ignore } = require('./stubs');
const { BUILTIN_LANGUAGES } = require('./languages');
const { createExtensionContext } = require('./extension-context');
const { buildApi } = require('./api');

const { Uri, EventEmitter, Range, Selection, FileSystemError } = types;

const EMITTER_NAMES = [
  'openTextDocument', 'closeTextDocument', 'changeTextDocument', 'saveTextDocument',
  'changeVisibleTextEditors', 'changeActiveTextEditor', 'changeDiagnostics',
  'diagnosticsSet', 'progressChange', 'languageClientFound',
];

function toUri(uriOrPath) {
  return typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
}

function isLanguageClient(candidate) {
  return typeof candidate?.sendRequest === 'function' && typeof candidate.onNotification === 'function';
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
    // Language ID for each lower-case file name extension.
    this.languageByExtension = new Map();
    for (const [id, extensions] of Object.entries(BUILTIN_LANGUAGES)) {
      for (const ext of extensions) this.languageByExtension.set(ext, id);
    }
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

    this.emitters = Object.fromEntries(EMITTER_NAMES.map((name) => [name, new EventEmitter()]));

    // LanguageClient objects from vscode-languageclient, which extensions
    // bundle privately. They are found when the library's features subscribe
    // to editor events, passing themselves as `thisArgs`.
    this.languageClients = new Set();
    for (const emitter of [...Object.values(this.emitters), this.configuration._onDidChange]) {
      const { event } = emitter;
      emitter.event = (listener, thisArgs, disposables) => {
        this.noticeLanguageClient(thisArgs);
        return event(listener, thisArgs, disposables);
      };
    }

    this.api = buildApi(this);
  }

  /** Wrap an API object so uses of members it lacks are reported; see stubs.js. */
  permissive(obj, name) {
    return permissive(obj, name, (what) => this.reportMissing(what));
  }

  /** The language ID for a file, or undefined if no language claims it. */
  languageIdForPath(p) {
    return this.languageByExtension.get(path.extname(p).toLowerCase());
  }

  /**
   * Record `obj`, or the client it holds, if it is a LanguageClient.
   * vscode-languageclient's document sync features keep their client in the
   * private field `_client`, so a new version of that library could hide it.
   */
  noticeLanguageClient(obj) {
    for (const candidate of [obj, obj?._client]) {
      if (isLanguageClient(candidate) && !this.languageClients.has(candidate)) {
        this.languageClients.add(candidate);
        this.emitters.languageClientFound.fire(candidate);
      }
    }
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
    const doc = new TextDocument(uri, this.languageIdForPath(uri.fsPath) ?? 'plaintext', text);
    this.documents.set(key, doc);
    this.emitters.openTextDocument.fire(doc);
    return doc;
  }

  /** Close a document, and its editor if it has one. */
  closeDocument(doc) {
    if (this.documents.get(doc.uri.toString()) !== doc) {
      return;
    }
    const editors = this.visibleEditors.filter((e) => e.document !== doc);
    if (editors.length !== this.visibleEditors.length) {
      this.visibleEditors = editors;
      this.emitters.changeVisibleTextEditors.fire(this.visibleEditors);
      if (this.activeEditor?.document === doc) {
        this.activeEditor = editors.at(-1);
        this.emitters.changeActiveTextEditor.fire(this.activeEditor);
      }
    }
    this.documents.delete(doc.uri.toString());
    doc.isClosed = true;
    this.emitters.closeTextDocument.fire(doc);
  }

  /** Show a document in an editor, which becomes the active editor. */
  showDocument(doc) {
    let editor = this.visibleEditors.find((e) => e.document === doc);
    if (!editor) {
      const selection = new Selection(0, 0, 0, 0);
      editor = this.permissive({
        document: doc,
        selection,
        selections: [selection],
        visibleRanges: [new Range(0, 0, Math.min(doc.lineCount - 1, 50), 0)],
        options: { tabSize: 4, insertSpaces: true },
        viewColumn: types.ViewColumn.One,
        edit: () => Promise.resolve(false),
        insertSnippet: () => Promise.resolve(false),
        setDecorations: ignore,
        revealRange: ignore,
        show: ignore,
        hide: ignore,
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

  onDiagnosticsChanged(collection, uri) {
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
    if (id === 'vscode.open' && args[0]) {
      try {
        this.showDocument(await this.openDocument(args[0]));
      } catch (err) {
        this.log('vscode.open', `cannot open ${args[0]}: ${err.message}`);
      }
    } else if (id !== 'setContext') {
      this.reportMissing(`commands.executeCommand(${JSON.stringify(id)})`);
    }
    return undefined;
  }

  /**
   * Make the vscode.ExtensionContext and vscode.Extension objects for an
   * extension unpacked at `extensionPath`, and register the extension so
   * vscode.extensions.getExtension() can find it. The manifest's settings
   * and languages become known to the editor.
   */
  addExtension(extensionPath, manifest) {
    this.configuration.addDefaultsFromManifest(manifest);
    for (const language of manifest.contributes?.languages ?? []) {
      for (const ext of language.extensions ?? []) {
        this.languageByExtension.set(ext.toLowerCase(), language.id);
      }
    }
    const { extension, context } = createExtensionContext(this, extensionPath, manifest);
    this.extensions.push(extension);
    return { extension, context };
  }
}

module.exports = { Workbench };
