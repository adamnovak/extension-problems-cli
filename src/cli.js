/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { parseArgs } = require('node:util');

const { readJsoncObject, resolveSettings } = require('./settings');
const { loadExtensionConfig } = require('./extension-config');
const { filesFromCompileCommands, absoluteCompileCommands } = require('./compile-commands');
const { collectFiles } = require('./files');
const { toProblem, compareProblems, formatPretty, formatJson } = require('./output');

const USAGE = `\
Usage: extension-problems-cli --extension <vsix-or-dir> [options] [PATH...]

Load a VS Code extension without VS Code, open files in it, and print the
problems it reports.

Each PATH is a file or a directory. Directories are searched for files in
languages the editor or the extension knows, skipping hidden entries and
node_modules. With no PATH, the files in the --compile-commands database are
analyzed.

Options:
  --extension PATH         Extension .vsix file or unpacked extension directory.
  --compile-commands FILE  C/C++ compilation database (compile_commands.json)
                           for extensions that use one.
  --workspace DIR          Workspace folder to present to the extension
                           (default: current directory).
  --setting KEY=VALUE      Set an extension setting; VALUE is parsed as JSON if
                           possible, otherwise used as a string (repeatable).
  --settings FILE          Read settings from a JSON object, as in
                           settings.json. These override the defaults this tool
                           ships for the extension.
  --format FORMAT          json (default) or pretty.
  --timeout SECONDS        Give up waiting for results after this long
                           (default: 1800).
  --state-dir DIR          Where to keep extension storage between runs
                           (default: $XDG_CACHE_HOME/extension-problems-cli).
  --log FILE               Write extension output and messages to FILE.
  --verbose                Write extension output and messages to stderr.
  -h, --help               Show this help.

Exit status: 0 when every file was analyzed, 2 when some files got no
results before the timeout, 1 on other errors.
`;

const OPTIONS = {
  extension: { type: 'string' },
  'compile-commands': { type: 'string' },
  workspace: { type: 'string' },
  setting: { type: 'string', multiple: true },
  settings: { type: 'string' },
  format: { type: 'string', default: 'json' },
  timeout: { type: 'string', default: '1800' },
  'state-dir': { type: 'string' },
  log: { type: 'string' },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const FORMATTERS = { json: formatJson, pretty: formatPretty };

/** Find an executable by name in the directories on PATH. */
function findOnPath(name) {
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of names.map((n) => path.join(dir, n))) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Ask the `java` on PATH for its installation directory, for extensions that
 * find Java through JAVA_HOME. Returns undefined if there is no usable java.
 */
function javaHomeFromPath() {
  const java = findOnPath('java');
  if (!java) {
    return undefined;
  }
  const result = childProcess.spawnSync(java, ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  // The JVM prints its settings on stderr, one `name = value` per line.
  const prefix = 'java.home = ';
  const line = result.stderr.split('\n').map((l) => l.trim()).find((l) => l.startsWith(prefix));
  return line?.slice(prefix.length);
}

function parseSettingArg(arg) {
  const eq = arg.indexOf('=');
  if (eq <= 0) {
    throw new Error(`--setting needs KEY=VALUE, got ${JSON.stringify(arg)}`);
  }
  const raw = arg.slice(eq + 1);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return [arg.slice(0, eq), value];
}

/**
 * Make the logging functions: `log` for extension output and messages, and
 * `reportMissing` for uses of unimplemented editor API.
 */
function makeLoggers({ logFile, verbose }) {
  const stream = logFile ? fs.createWriteStream(logFile) : null;
  const log = (channel, text) => {
    const line = `[${channel}] ${text}\n`;
    stream?.write(line);
    if (verbose) process.stderr.write(line);
  };
  const missing = new Set();
  const reportMissing = (what) => {
    if (!missing.has(what)) {
      missing.add(what);
      log('extension-problems-cli', `unimplemented API used: ${what}`);
    }
  };
  const close = () => (stream ? new Promise((resolve) => stream.end(resolve)) : Promise.resolve());
  return { log, reportMissing, close };
}

/**
 * Combine settings from least to most specific: the defaults shipped for the
 * extension, then the --settings file, then each --setting.
 */
function gatherSettings({ config, configFile, variables, values, log }) {
  const settings = {};
  if (config.settings) {
    const warn = (message) => log('extension-problems-cli', `${path.basename(configFile)}: ${message}`);
    Object.assign(settings, resolveSettings(config.settings, variables, warn));
  }
  if (values.settings) {
    Object.assign(settings, readJsoncObject(values.settings));
  }
  for (const arg of values.setting ?? []) {
    const [key, value] = parseSettingArg(arg);
    settings[key] = value;
  }
  return settings;
}

function defaultStateDir() {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'extension-problems-cli');
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const compileCommands = values['compile-commands'] && path.resolve(values['compile-commands']);
  if (!values.extension || (positionals.length === 0 && !compileCommands)) {
    process.stderr.write(USAGE);
    return 1;
  }
  const format = FORMATTERS[values.format];
  if (!format) {
    throw new Error(`unknown --format ${values.format}`);
  }

  if (!process.env.JAVA_HOME) {
    const javaHome = javaHomeFromPath();
    if (javaHome) process.env.JAVA_HOME = javaHome;
  }

  const loggers = makeLoggers({ logFile: values.log, verbose: values.verbose });
  const workspaceFolder = path.resolve(values.workspace ?? process.cwd());

  // Loaded here so that --help works without dependencies installed.
  const { ExtensionHost } = require('./host');
  const host = new ExtensionHost({
    extension: path.resolve(values.extension),
    workspaceFolders: [workspaceFolder],
    stateDir: path.resolve(values['state-dir'] ?? defaultStateDir()),
    log: loggers.log,
    reportMissing: loggers.reportMissing,
  });

  const files = positionals.length
    ? collectFiles(positionals, (file) => host.workbench.languageIdForPath(file) !== undefined)
    : filesFromCompileCommands(compileCommands);

  const { config, file: configFile } = loadExtensionConfig(host.id);
  const variables = {
    workspaceFolder,
    compileCommands: compileCommands && absoluteCompileCommands(compileCommands),
  };
  const settings = gatherSettings({ config, configFile, variables, values, log: loggers.log });
  for (const [key, value] of Object.entries(settings)) {
    host.workbench.configuration.setUser(key, value);
  }

  try {
    await host.activate();
    const { timedOut, unreported } = await host.analyze(files, {
      readiness: config.readiness,
      timeoutMs: Number(values.timeout) * 1000,
    });
    if (timedOut) {
      process.stderr.write('extension-problems-cli: timed out waiting for the extension to finish\n');
    }
    const problems = host.collectDiagnostics().map(toProblem).sort(compareProblems);
    process.stdout.write(format({ extension: host.id, problems, unanalyzedFiles: unreported }));
    return unreported.length ? 2 : 0;
  } finally {
    await host.shutdown();
    await loggers.close();
  }
}

module.exports = { main };
