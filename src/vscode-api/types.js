/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE.txt in this directory for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Value types, classes and enums from the `vscode` module, following the
// definitions in vscode.d.ts. Numeric enum values must match vscode.d.ts,
// because extensions sometimes compare against literal numbers.

const { URI, Utils } = require('vscode-uri');

// vscode.Uri is the vscode-uri URI class plus the static helpers that the
// editor adds to it.
const Uri = URI;
if (!Uri.joinPath) {
  Uri.joinPath = Utils.joinPath;
}

class Disposable {
  static from(...disposables) {
    return new Disposable(() => {
      for (const d of disposables) {
        if (d && typeof d.dispose === 'function') {
          d.dispose();
        }
      }
    });
  }

  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }

  dispose() {
    if (this._callOnDispose) {
      const f = this._callOnDispose;
      this._callOnDispose = undefined;
      f();
    }
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    // An Event is a function that subscribes a listener and returns a
    // Disposable that unsubscribes it.
    this.event = (listener, thisArgs, disposables) => {
      const entry = { listener, thisArgs };
      this._listeners.add(entry);
      const d = new Disposable(() => this._listeners.delete(entry));
      if (Array.isArray(disposables)) {
        disposables.push(d);
      }
      return d;
    };
  }

  fire(data) {
    // Listeners subscribed while this event is delivered get the next one.
    const current = Array.from(this._listeners);
    for (const { listener, thisArgs } of current) {
      try {
        listener.call(thisArgs, data);
      } catch (e) {
        console.error('[extension-problems-cli] event listener threw:', e);
      }
    }
  }

  dispose() {
    this._listeners.clear();
  }
}

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this._emitter.event,
    };
  }

  cancel() {
    if (!this.token.isCancellationRequested) {
      this.token.isCancellationRequested = true;
      this._emitter.fire();
    }
  }

  dispose() {
    this._emitter.dispose();
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isBefore(o) { return this.compareTo(o) < 0; }
  isBeforeOrEqual(o) { return this.compareTo(o) <= 0; }
  isAfter(o) { return this.compareTo(o) > 0; }
  isAfterOrEqual(o) { return this.compareTo(o) >= 0; }
  isEqual(o) { return this.compareTo(o) === 0; }
  compareTo(o) {
    return this.line === o.line ? this.character - o.character : this.line - o.line;
  }
  translate(lineDeltaOrChange = 0, characterDelta = 0) {
    if (typeof lineDeltaOrChange === 'object') {
      ({ lineDelta: lineDeltaOrChange = 0, characterDelta = 0 } = lineDeltaOrChange);
    }
    return new Position(this.line + lineDeltaOrChange, this.character + characterDelta);
  }
  with(lineOrChange, character) {
    if (typeof lineOrChange === 'object' && lineOrChange !== null) {
      ({ line: lineOrChange, character } = lineOrChange);
    }
    return new Position(lineOrChange ?? this.line, character ?? this.character);
  }
  toJSON() { return { line: this.line, character: this.character }; }
}

class Range {
  constructor(startOrLine, endOrChar, endLine, endChar) {
    let start;
    let end;
    if (typeof startOrLine === 'number') {
      start = new Position(startOrLine, endOrChar);
      end = new Position(endLine, endChar);
    } else {
      start = startOrLine;
      end = endOrChar;
    }
    if (start.isAfter(end)) {
      [start, end] = [end, start];
    }
    this.start = start;
    this.end = end;
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(posOrRange) {
    if (posOrRange instanceof Range) {
      return this.contains(posOrRange.start) && this.contains(posOrRange.end);
    }
    return posOrRange.isAfterOrEqual(this.start) && posOrRange.isBeforeOrEqual(this.end);
  }
  isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
  intersection(o) {
    const start = this.start.isAfter(o.start) ? this.start : o.start;
    const end = this.end.isBefore(o.end) ? this.end : o.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(o) {
    return new Range(
      this.start.isBefore(o.start) ? this.start : o.start,
      this.end.isAfter(o.end) ? this.end : o.end,
    );
  }
  with(startOrChange, end) {
    if (startOrChange && !(startOrChange instanceof Position)) {
      ({ start: startOrChange, end } = startOrChange);
    }
    return new Range(startOrChange ?? this.start, end ?? this.end);
  }
  toJSON() { return { start: this.start, end: this.end }; }
}

class Selection extends Range {
  constructor(anchorOrLine, activeOrChar, activeLine, activeChar) {
    let anchor;
    let active;
    if (typeof anchorOrLine === 'number') {
      anchor = new Position(anchorOrLine, activeOrChar);
      active = new Position(activeLine, activeChar);
    } else {
      anchor = anchorOrLine;
      active = activeOrChar;
    }
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() { return this.anchor.isAfter(this.active); }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position
      ? new Range(rangeOrPosition, rangeOrPosition)
      : rangeOrPosition;
  }
}

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 };

class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class TextEdit {
  static replace(range, newText) { return new TextEdit(range, newText); }
  static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
  static delete(range) { return new TextEdit(range, ''); }
  static setEndOfLine(eol) { const e = new TextEdit(new Range(0, 0, 0, 0), ''); e.newEol = eol; return e; }
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
}

class WorkspaceEdit {
  constructor() { this._edits = []; }
  get size() { return new Set(this._edits.map((e) => e.uri.toString())).size; }
  replace(uri, range, newText) { this._edits.push({ uri, edit: TextEdit.replace(range, newText) }); }
  insert(uri, position, newText) { this._edits.push({ uri, edit: TextEdit.insert(position, newText) }); }
  delete(uri, range) { this._edits.push({ uri, edit: TextEdit.delete(range) }); }
  set(uri, edits) {
    this._edits = this._edits.filter((e) => e.uri.toString() !== uri.toString());
    for (const edit of edits || []) {
      this._edits.push({ uri, edit: edit.edit ?? edit });
    }
  }
  get(uri) { return this._edits.filter((e) => e.uri.toString() === uri.toString()).map((e) => e.edit); }
  has(uri) { return this.get(uri).length > 0; }
  entries() {
    const byUri = new Map();
    for (const { uri, edit } of this._edits) {
      const key = uri.toString();
      if (!byUri.has(key)) byUri.set(key, [uri, []]);
      byUri.get(key)[1].push(edit);
    }
    return [...byUri.values()];
  }
  createFile() {
    // File operations are not recorded, because workspace.applyEdit() never applies edits.
  }
  deleteFile() {
    // File operations are not recorded, because workspace.applyEdit() never applies edits.
  }
  renameFile() {
    // File operations are not recorded, because workspace.applyEdit() never applies edits.
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value) { this.value += value.replaceAll(/[\\`*_{}[\]()#+\-.!]/g, String.raw`\$&`); return this; }
  appendMarkdown(value) { this.value += value; return this; }
  appendCodeblock(code, language = '') { this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`; return this; }
}

class SnippetString {
  constructor(value = '') { this.value = value; }
  appendText(s) { this.value += s.replaceAll(/[$}\\]/g, String.raw`\$&`); return this; }
  appendPlaceholder(s) {
    const text = typeof s === 'string' ? s : '';
    this.value += `\${${text}}`;
    return this;
  }
  appendTabstop(n = 0) { this.value += `$${n}`; return this; }
  appendVariable(name, def) {
    const suffix = def ? ':' + def : '';
    this.value += `\${${name}${suffix}}`;
    return this;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class ThemeColor {
  constructor(id) { this.id = id; }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

class TreeItem {
  constructor(labelOrUri, collapsibleState = TreeItemCollapsibleState.None) {
    if (labelOrUri instanceof URI) {
      this.resourceUri = labelOrUri;
    } else {
      this.label = labelOrUri;
    }
    this.collapsibleState = collapsibleState;
  }
}

class CodeActionKind {
  constructor(value) { this.value = value; }
  append(part) { return new CodeActionKind(this.value ? `${this.value}.${part}` : part); }
  intersects(other) { return this.contains(other) || other.contains(this); }
  contains(other) { return this.value === '' || other.value === this.value || other.value.startsWith(`${this.value}.`); }
}
CodeActionKind.Empty = new CodeActionKind('');
CodeActionKind.QuickFix = new CodeActionKind('quickfix');
CodeActionKind.Refactor = new CodeActionKind('refactor');
CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
CodeActionKind.RefactorMove = new CodeActionKind('refactor.move');
CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
CodeActionKind.Source = new CodeActionKind('source');
CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');
CodeActionKind.Notebook = new CodeActionKind('notebook');

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() { return !!this.command; }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class CompletionList {
  constructor(items = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}

class InlayHint {
  constructor(position, label, kind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

class SymbolInformation {
  constructor(name, kind, containerNameOrRange, locationOrUri, containerName) {
    this.name = name;
    this.kind = kind;
    if (containerNameOrRange instanceof Range) {
      this.location = new Location(locationOrUri, containerNameOrRange);
      this.containerName = containerName;
    } else {
      this.containerName = containerNameOrRange;
      this.location = locationOrUri;
    }
  }
}

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

class TypeHierarchyItem extends CallHierarchyItem {}

class FoldingRange {
  constructor(start, end, kind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

class SelectionRange {
  constructor(range, parent) {
    this.range = range;
    this.parent = parent;
  }
}

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

class SemanticTokens {
  constructor(data, resultId) {
    this.data = data;
    this.resultId = resultId;
  }
}

class SemanticTokensEdits {
  constructor(edits, resultId) {
    this.edits = edits;
    this.resultId = resultId;
  }
}

class SemanticTokensEdit {
  constructor(start, deleteCount, data) {
    this.start = start;
    this.deleteCount = deleteCount;
    this.data = data;
  }
}

class SemanticTokensBuilder {
  constructor() { this._data = []; }
  push(...args) { this._data.push(...(args.length === 1 ? [] : args)); }
  build(resultId) { return new SemanticTokens(Uint32Array.from(this._data), resultId); }
}

class RelativePattern {
  constructor(base, pattern) {
    if (typeof base === 'string') {
      this.baseUri = Uri.file(base);
    } else if (base instanceof URI) {
      this.baseUri = base;
    } else {
      this.baseUri = base.uri;
    }
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

class FileSystemError extends Error {
  static FileNotFound(m) { return new FileSystemError(m, 'FileNotFound'); }
  static FileExists(m) { return new FileSystemError(m, 'FileExists'); }
  static FileNotADirectory(m) { return new FileSystemError(m, 'FileNotADirectory'); }
  static FileIsADirectory(m) { return new FileSystemError(m, 'FileIsADirectory'); }
  static NoPermissions(m) { return new FileSystemError(m, 'NoPermissions'); }
  static Unavailable(m) { return new FileSystemError(m, 'Unavailable'); }
  constructor(message, code = 'Unknown') {
    super(message instanceof URI ? message.toString() : message);
    this.code = code;
    this.name = `${code} (FileSystemError)`;
  }
}

class TabInputText {
  constructor(uri) { this.uri = uri; }
}

class LanguageModelToolResult {
  constructor(content) { this.content = content; }
}

class LanguageModelTextPart {
  constructor(value) { this.value = value; }
}

module.exports = {
  Uri,
  Disposable,
  EventEmitter,
  CancellationError,
  CancellationTokenSource,
  Position,
  Range,
  Selection,
  Location,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DiagnosticRelatedInformation,
  TextEdit,
  WorkspaceEdit,
  MarkdownString,
  SnippetString,
  ThemeIcon,
  ThemeColor,
  TreeItem,
  TreeItemCollapsibleState,
  CodeAction,
  CodeActionKind,
  CodeLens,
  CompletionItem,
  CompletionList,
  Hover,
  DocumentLink,
  InlayHint,
  SymbolInformation,
  DocumentSymbol,
  CallHierarchyItem,
  TypeHierarchyItem,
  FoldingRange,
  SelectionRange,
  SemanticTokensLegend,
  SemanticTokens,
  SemanticTokensEdits,
  SemanticTokensEdit,
  SemanticTokensBuilder,
  RelativePattern,
  FileSystemError,
  TabInputText,
  LanguageModelToolResult,
  LanguageModelTextPart,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  EndOfLine: { LF: 1, CRLF: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  UIKind: { Desktop: 1, Web: 2 },
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FilePermission: { Readonly: 1 },
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
  SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
  DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
  InlayHintKind: { Type: 1, Parameter: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentMode: { Editing: 0, Preview: 1 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  SymbolKind: Object.fromEntries([
    'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor',
    'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array',
    'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter',
  ].map((k, i) => [k, i])),
  SymbolTag: { Deprecated: 1 },
  CompletionItemKind: Object.fromEntries([
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
    'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder',
    'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter', 'User', 'Issue',
  ].map((k, i) => [k, i])),
  CompletionItemTag: { Deprecated: 1 },
  FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
};
