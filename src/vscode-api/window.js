/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('node:crypto');

const types = require('./types');
const { TextDocument } = require('./text-document');
const { NEVER_FIRES, ignore } = require('./stubs');

const { Disposable } = types;

/** Render a value passed to a LogOutputChannel method as text. */
function logArgument(arg) {
  if (arg instanceof Error) return arg.stack;
  if (typeof arg === 'string') return arg;
  return JSON.stringify(arg);
}

/**
 * Make a vscode.OutputChannel, or a vscode.LogOutputChannel if
 * `options.log` is set, that sends each complete line to `wb.log`.
 */
function createOutputChannel(wb, name, options) {
  // Text appended since the last line break.
  let partialLine = '';
  const emit = (text) => wb.log(name, text);
  const logAt = (label) => (message, ...args) => {
    emit(`[${label}] ${[message, ...args].map(logArgument).join(' ')}`);
  };
  const channel = {
    name,
    append(text) {
      partialLine += text;
      const lines = partialLine.split('\n');
      partialLine = lines.pop();
      for (const line of lines) emit(line);
    },
    appendLine(text) {
      emit(partialLine + text);
      partialLine = '';
    },
    replace(text) {
      partialLine = '';
      emit(text);
    },
    clear: ignore,
    show: ignore,
    hide: ignore,
    dispose: ignore,
  };
  if (options && typeof options === 'object' && options.log) {
    Object.assign(channel, {
      logLevel: types.LogLevel.Info,
      onDidChangeLogLevel: NEVER_FIRES,
      trace: logAt('trace'),
      debug: logAt('debug'),
      info: logAt('info'),
      warn: logAt('warning'),
      error: logAt('error'),
    });
  }
  return wb.permissive(channel, 'OutputChannel');
}

/**
 * Make a window.show*Message function. Messages are logged with their
 * buttons; nobody is there to click a button, so every message is dismissed.
 */
function messageShower(wb, kind) {
  return (message, ...rest) => {
    const items = rest.filter((r) => typeof r === 'string' || (r && typeof r === 'object' && 'title' in r));
    const labels = items.map((i) => (typeof i === 'string' ? i : i.title));
    const buttons = labels.length ? ` [${labels.join(' | ')}]` : '';
    wb.log(`window.show${kind}Message`, `${message}${buttons}`);
    return Promise.resolve(undefined);
  };
}

/**
 * window.withProgress(): run the task, counting it in
 * `wb.progressInFlight` while it runs and logging its title and messages.
 */
async function withProgress(wb, options, task) {
  const source = new types.CancellationTokenSource();
  const title = options.title ?? '';
  const progress = {
    report(value) {
      if (value?.message) wb.log('window.withProgress', `${title} ${value.message}`.trim());
    },
  };
  wb.progressInFlight++;
  wb.emitters.progressChange.fire(wb.progressInFlight);
  if (title) wb.log('window.withProgress', `start: ${title}`);
  try {
    return await task(progress, source.token);
  } finally {
    wb.progressInFlight--;
    if (title) wb.log('window.withProgress', `end: ${title}`);
    wb.emitters.progressChange.fire(wb.progressInFlight);
  }
}

const NO_ANSWER = () => Promise.resolve(undefined);
const NO_OP_DISPOSABLE = () => new Disposable(ignore);

/** Make the vscode.window namespace for a Workbench. */
function createWindow(wb) {
  const uiObject = (name, fields) => wb.permissive({ dispose: ignore, ...fields }, name);
  return {
    get activeTextEditor() { return wb.activeEditor; },
    get visibleTextEditors() { return wb.visibleEditors; },
    onDidChangeActiveTextEditor: wb.emitters.changeActiveTextEditor.event,
    onDidChangeVisibleTextEditors: wb.emitters.changeVisibleTextEditors.event,
    state: { focused: true, active: true },
    activeColorTheme: { kind: types.ColorThemeKind.Dark },
    terminals: [],
    tabGroups: wb.permissive({
      all: [],
      activeTabGroup: { tabs: [], isActive: true, viewColumn: types.ViewColumn.One },
      onDidChangeTabs: NEVER_FIRES,
      onDidChangeTabGroups: NEVER_FIRES,
      close: () => Promise.resolve(true),
    }, 'window.tabGroups'),
    createOutputChannel: (name, options) => createOutputChannel(wb, name, options),
    showInformationMessage: messageShower(wb, 'Information'),
    showWarningMessage: messageShower(wb, 'Warning'),
    showErrorMessage: messageShower(wb, 'Error'),
    showQuickPick: NO_ANSWER,
    showInputBox: NO_ANSWER,
    showOpenDialog: NO_ANSWER,
    showSaveDialog: NO_ANSWER,
    async showTextDocument(docOrUri) {
      const doc = docOrUri instanceof TextDocument ? docOrUri : await wb.openDocument(docOrUri);
      return wb.showDocument(doc);
    },
    withProgress: (options, task) => withProgress(wb, options, task),
    createStatusBarItem: () => uiObject('StatusBarItem', {
      text: '', tooltip: undefined, command: undefined, show: ignore, hide: ignore,
    }),
    createTreeView: (viewId) => uiObject(`TreeView(${viewId})`, {
      visible: false,
      selection: [],
      onDidChangeVisibility: NEVER_FIRES,
      onDidChangeSelection: NEVER_FIRES,
      onDidExpandElement: NEVER_FIRES,
      onDidCollapseElement: NEVER_FIRES,
      onDidChangeCheckboxState: NEVER_FIRES,
      reveal: () => Promise.resolve(),
    }),
    registerTreeDataProvider: NO_OP_DISPOSABLE,
    registerWebviewViewProvider: NO_OP_DISPOSABLE,
    registerUriHandler: NO_OP_DISPOSABLE,
    registerFileDecorationProvider: NO_OP_DISPOSABLE,
    createTextEditorDecorationType: () => ({ key: crypto.randomUUID(), dispose: ignore }),
  };
}

module.exports = { createWindow };
