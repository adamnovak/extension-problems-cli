'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const childProcess = require('child_process');
const AdmZip = require('adm-zip');

const { Workbench } = require('./vscode-api');
const { isNotReady } = require('./readiness');

// How often to check on the extension while waiting for results.
const POLL_MS = 250;
// How long after the last diagnostics publish results count as final.
const GRACE_MS = 1000;

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
   * Open and show each file once the extension's language server is ready,
   * and wait until every file has had diagnostics published and no
   * window.withProgress() task is running, or until `timeoutMs` has passed.
   *
   * With a readiness rule (see readiness.js), the server is asked whether it
   * is ready before the files are opened, and while waiting for results. If
   * it stops being ready, the files are closed and opened again once it is
   * ready, so that they are analyzed again.
   *
   * @returns {Promise<{timedOut: boolean, unreported: string[]}>} The files
   *   that never got any diagnostics report.
   */
  async analyze(files, { timeoutMs, readiness }) {
    const wb = this.workbench;
    const deadline = Date.now() + timeoutMs;
    const sleep = () => new Promise((resolve) => { setTimeout(resolve, POLL_MS); });

    let pending = new Set();
    let lastPublish = 0;
    const sub = wb.emitters.diagnosticsSet.event(({ uri }) => {
      pending.delete(uri.toString());
      lastPublish = Date.now();
    });

    let opened = false;
    let wasNotReady = false;
    let timedOut = false;
    try {
      for (;; await sleep()) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (readiness && !(await this._isReady(readiness))) {
          wasNotReady = true;
          continue;
        }
        if (!opened || wasNotReady) {
          // An analysis in progress may have started before the server was
          // ready; let it finish so its results are not taken for new ones.
          if (wb.progressInFlight > 0) continue;
          for (const doc of [...wb.documents.values()]) wb.closeDocument(doc);
          pending = new Set(files.map((f) => wb.api.Uri.file(f).toString()));
          for (const file of files) wb.showDocument(await wb.openDocument(file));
          opened = true;
          wasNotReady = false;
          continue;
        }
        // TODO: can more diagnostics for a file arrive after the progress
        // task covering its analysis ends? The grace period assumes so.
        if (pending.size === 0 && wb.progressInFlight === 0 && Date.now() - lastPublish >= GRACE_MS) {
          break;
        }
      }
    } finally {
      sub.dispose();
    }
    return {
      timedOut,
      unreported: [...pending].map((u) => wb.api.Uri.parse(u).fsPath),
    };
  }

  /**
   * Ask the language client named by a readiness rule whether its server is
   * ready. Not finding the client, or the request failing, counts as not
   * ready.
   */
  async _isReady(rule) {
    const clients = [...this.workbench.languageClients].filter((c) => !rule.client || c.name === rule.client);
    if (clients.length !== 1) {
      return false;
    }
    const [client] = clients;
    if (typeof client.isRunning === 'function' && !client.isRunning()) {
      return false;
    }
    try {
      return !isNotReady(rule, await client.sendRequest(rule.request, rule.params));
    } catch (err) {
      this.log('extension-problems-cli', `readiness request ${rule.request} failed: ${err?.message ?? err}`);
      return false;
    }
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
