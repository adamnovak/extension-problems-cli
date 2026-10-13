'use strict';

const { isNotReady } = require('./readiness');

// How often to check on the extension while waiting for results.
const POLL_MS = 250;
// How long after the last diagnostics publish results count as final. It is
// not known whether a server can publish diagnostics for a file after the
// progress task covering its analysis ends; this allows for it.
const GRACE_MS = 1000;

/**
 * One pass of opening files in a Workbench and waiting for the extension to
 * report diagnostics for them.
 *
 * Files are opened once the extension's language server is ready. Results
 * are final when every file has had diagnostics published and no
 * window.withProgress() task is running.
 *
 * With a readiness rule (see readiness.js), the server is asked whether it
 * is ready before the files are opened, and while waiting for results. If
 * it stops being ready, the files are closed and opened again once it is
 * ready, so that they are analyzed again.
 */
class AnalysisRun {
  /**
   * @param {object} options
   * @param {import('./vscode-api').Workbench} options.workbench
   * @param {string[]} options.files Absolute paths.
   * @param {object} [options.readiness] Readiness rule.
   * @param {number} options.timeoutMs
   * @param {(channel: string, text: string) => void} options.log
   */
  constructor({ workbench, files, readiness, timeoutMs, log }) {
    this.workbench = workbench;
    this.files = files;
    this.readiness = readiness;
    this.deadline = Date.now() + timeoutMs;
    this.log = log;
    // URI strings of opened files that have had no diagnostics published
    // since they were opened.
    this.pending = new Set();
    this.lastPublish = 0;
    this.opened = false;
    this.wasNotReady = false;
    this.timedOut = false;
  }

  /**
   * Run until results are final or the timeout passes.
   *
   * @returns {Promise<{timedOut: boolean, unreported: string[]}>} The files
   *   that never got any diagnostics report.
   */
  run() {
    const wb = this.workbench;
    const subscription = wb.emitters.diagnosticsSet.event(({ uri }) => {
      this.pending.delete(uri.toString());
      this.lastPublish = Date.now();
    });
    return new Promise((resolve, reject) => {
      const tick = () => {
        this.step().then((finished) => {
          if (finished) {
            resolve();
          } else {
            setTimeout(tick, POLL_MS);
          }
        }, reject);
      };
      tick();
    }).finally(() => subscription.dispose()).then(() => ({
      timedOut: this.timedOut,
      unreported: Array.from(this.pending, (u) => wb.api.Uri.parse(u).fsPath),
    }));
  }

  /** Make one round of progress; resolves to true when the run is over. */
  async step() {
    if (Date.now() >= this.deadline) {
      this.timedOut = true;
      return true;
    }
    if (this.readiness && !(await this.isReady())) {
      this.wasNotReady = true;
      return false;
    }
    if (!this.opened || this.wasNotReady) {
      await this.openFiles();
      return false;
    }
    return this.pending.size === 0
      && this.workbench.progressInFlight === 0
      && Date.now() - this.lastPublish >= GRACE_MS;
  }

  /**
   * Open and show every file, closing any open documents first. Waits
   * instead while an analysis is in progress, because it may have started
   * before the server was ready and its results must not be taken for new
   * ones.
   */
  async openFiles() {
    const wb = this.workbench;
    if (wb.progressInFlight > 0) {
      return;
    }
    for (const doc of wb.documents.values()) {
      wb.closeDocument(doc);
    }
    this.pending = new Set(this.files.map((f) => wb.api.Uri.file(f).toString()));
    const docs = await Promise.all(this.files.map((f) => wb.openDocument(f)));
    for (const doc of docs) {
      wb.showDocument(doc);
    }
    this.opened = true;
    this.wasNotReady = false;
  }

  /**
   * Ask the language client named by the readiness rule whether its server
   * is ready. Not finding the client, or the request failing, counts as not
   * ready.
   */
  async isReady() {
    const rule = this.readiness;
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
}

module.exports = { AnalysisRun };
