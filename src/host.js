'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const childProcess = require('child_process');
const AdmZip = require('adm-zip');

const { Workbench } = require('./vscode-api');

/**
 * Return the directory holding an extension's package.json. A .vsix file is
 * unpacked into `cacheDir`, keyed by its content hash, and reused on later
 * runs.
 */
function resolveExtensionDir(extension, cacheDir) {
  const stat = fs.statSync(extension);
  if (stat.isDirectory()) {
    const nested = path.join(extension, 'extension');
    return fs.existsSync(path.join(nested, 'package.json')) ? nested : extension;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(extension)).digest('hex').slice(0, 16);
  const dest = path.join(cacheDir, 'unpacked', hash);
  const done = path.join(dest, '.complete');
  if (!fs.existsSync(done)) {
    fs.rmSync(dest, { recursive: true, force: true });
    new AdmZip(extension).extractAllTo(dest, true, true);
    fs.writeFileSync(done, '');
  }
  return path.join(dest, 'extension');
}

/**
 * Wrap child_process so that every process an extension starts is recorded
 * and can be killed when the host shuts down.
 */
function trackChildProcesses() {
  const children = new Set();
  for (const name of ['spawn', 'fork', 'exec', 'execFile']) {
    const original = childProcess[name];
    childProcess[name] = function tracked(...args) {
      const child = original.apply(this, args);
      children.add(child);
      child.on('exit', () => children.delete(child));
      return child;
    };
  }
  return children;
}

/**
 * Resolve `require('vscode')` from any module to `api`.
 */
function provideVscodeModule(api) {
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'vscode') {
      return api;
    }
    return originalLoad.call(this, request, ...rest);
  };
}

/**
 * Runs one extension in this process, opens source files in it, and collects
 * the diagnostics it reports.
 */
class ExtensionHost {
  /**
   * @param {object} options
   * @param {string} options.extension Path to a .vsix or an unpacked extension.
   * @param {string[]} options.workspaceFolders
   * @param {string} options.stateDir Directory kept between runs.
   * @param {(channel: string, text: string) => void} options.log
   * @param {(what: string) => void} options.reportMissing
   */
  constructor({ extension, workspaceFolders, stateDir, log, reportMissing }) {
    this.log = log;
    this.extensionDir = resolveExtensionDir(extension, stateDir);
    this.manifest = JSON.parse(fs.readFileSync(path.join(this.extensionDir, 'package.json'), 'utf8'));
    this.workbench = new Workbench({ workspaceFolders, stateDir, log, reportMissing });
    const { extension: ext, context } = this.workbench.addExtension(this.extensionDir, this.manifest);
    this.extensionRecord = ext;
    this.context = context;
    this.children = trackChildProcesses();
    provideVscodeModule(this.workbench.api);
  }

  get id() {
    return this.extensionRecord.id;
  }

  async activate() {
    const main = path.resolve(this.extensionDir, this.manifest.main ?? 'index.js');
    this.module = require(main);
    if (typeof this.module.activate === 'function') {
      this.extensionRecord.exports = await this.module.activate(this.context);
    }
    this.extensionRecord.isActive = true;
  }

  /**
   * Open and show each file, then wait until the extension has reported
   * diagnostics for all of them and has been quiet for `settleMs`, or until
   * `timeoutMs` has passed. "Quiet" means no new diagnostics and no
   * window.withProgress() task running.
   *
   * @returns {Promise<{timedOut: boolean, unreported: string[]}>} The files
   *   that never got any diagnostics report.
   */
  async analyze(files, { settleMs, timeoutMs }) {
    const wb = this.workbench;
    const pending = new Set(files.map((f) => wb.api.Uri.file(f).toString()));
    let lastActivity = Date.now();
    const bump = () => { lastActivity = Date.now(); };
    const subs = [
      wb.emitters.diagnosticsSet.event(({ uri }) => {
        pending.delete(uri.toString());
        bump();
      }),
      wb.emitters.progressChange.event(bump),
    ];

    for (const file of files) {
      const doc = await wb.openDocument(file);
      wb.showDocument(doc);
    }
    bump();

    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    for (;;) {
      const now = Date.now();
      if (pending.size === 0 && wb.progressInFlight === 0 && now - lastActivity >= settleMs) break;
      if (now >= deadline) {
        timedOut = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (const s of subs) s.dispose();
    return {
      timedOut,
      unreported: [...pending].map((u) => wb.api.Uri.parse(u).fsPath),
    };
  }

  /** All diagnostics currently held in the extension's diagnostic collections. */
  collectDiagnostics() {
    const out = [];
    for (const collection of this.workbench.diagnosticCollections) {
      collection.forEach((uri, diagnostics) => {
        for (const d of diagnostics) out.push({ collection: collection.name, uri, diagnostic: d });
      });
    }
    return out;
  }

  /**
   * Deactivate the extension, giving it up to `graceMs` to shut down, then
   * kill any child processes it left behind.
   */
  async shutdown(graceMs = 5000) {
    const work = (async () => {
      if (this.module && typeof this.module.deactivate === 'function') {
        await this.module.deactivate();
      }
      for (const d of this.context.subscriptions) {
        try {
          d?.dispose?.();
        } catch (err) {
          this.log('host', `error disposing subscription: ${err?.stack ?? err}`);
        }
      }
    })();
    const timer = new Promise((resolve) => { setTimeout(resolve, graceMs).unref(); });
    try {
      await Promise.race([work, timer]);
    } catch (err) {
      this.log('host', `error during deactivate: ${err?.stack ?? err}`);
    }
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }
}

module.exports = { ExtensionHost, resolveExtensionDir };
