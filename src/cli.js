'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { parseArgs } = require('util');

const { readSettingsFile, defaultSettingsFile, resolveSettings } = require('./settings');
const { loadReadinessRule } = require('./readiness');

const USAGE = `\
Usage: extension-problems-cli --extension <vsix-or-dir> [options] <compile_commands.json>

Load a VS Code extension without VS Code, open every source file listed in
the compilation database, and print the problems the extension reports.

Options:
  --extension PATH     Extension .vsix file or unpacked extension directory.
  --workspace DIR      Workspace folder to present to the extension
                       (default: current directory).
  --file FILE          Analyze only this file (repeatable; default: every file
                       in the compilation database).
  --setting KEY=VALUE  Set an extension setting; VALUE is parsed as JSON if
                       possible, otherwise used as a string (repeatable).
  --settings FILE      Read settings from a JSON object, as in settings.json.
                       These override the defaults this tool ships for the
                       extension, in extension-defaults/.
  --format FORMAT      json (default) or pretty.
  --timeout SECONDS    Give up waiting for results after this long
                       (default: 1800).
  --state-dir DIR      Where to keep extension storage between runs
                       (default: $XDG_CACHE_HOME/extension-problems-cli).
  --log FILE           Write extension output channels and messages to FILE.
  --verbose            Write extension output channels and messages to stderr.
  -h, --help           Show this help.

Exit status: 0 when every file was analyzed, 2 when some files got no
results before the timeout, 1 on other errors.
`;

const SEVERITY_NAMES = ['error', 'warning', 'information', 'hint'];

/**
 * Ask the `java` on PATH for its installation directory, for extensions that
 * find Java through JAVA_HOME. Returns undefined if there is no usable java.
 */
function javaHomeFromPath() {
  const result = childProcess.spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  // The JVM prints its settings on stderr.
  return /^\s*java\.home = (.*)$/m.exec(result.stderr)?.[1]?.trim();
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
 * List the absolute source file paths in a compilation database, without
 * duplicates. A relative `directory` is taken relative to the database file.
 */
function filesFromCompileCommands(compileCommands) {
  const entries = JSON.parse(fs.readFileSync(compileCommands, 'utf8'));
  const files = new Set();
  for (const entry of entries) {
    const directory = path.resolve(path.dirname(compileCommands), entry.directory ?? '.');
    files.add(path.resolve(directory, entry.file));
  }
  return [...files];
}

/**
 * Return the path of a compilation database whose `directory` fields are
 * all absolute, as the JSON Compilation Database format requires.
 *
 * Databases written with relative directories, taken relative to the
 * database file, are rewritten to a new temporary file, which is removed
 * when the process exits.
 */
function absoluteCompileCommands(compileCommands) {
  const entries = JSON.parse(fs.readFileSync(compileCommands, 'utf8'));
  if (entries.every((e) => e.directory && path.isAbsolute(e.directory))) {
    return compileCommands;
  }
  const base = path.dirname(compileCommands);
  const fixed = entries.map((e) => ({ ...e, directory: path.resolve(base, e.directory ?? '.') }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-problems-cli-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'compile_commands.json');
  fs.writeFileSync(file, JSON.stringify(fixed, null, 2));
  return file;
}

function toProblem({ collection, uri, diagnostic: d }) {
  const code = d.code && typeof d.code === 'object' ? d.code.value : d.code;
  const codeUrl = d.code && typeof d.code === 'object' ? d.code.target?.toString() : undefined;
  const span = (r) => ({
    line: r.start.line + 1,
    column: r.start.character + 1,
    endLine: r.end.line + 1,
    endColumn: r.end.character + 1,
  });
  const problem = {
    file: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    ...span(d.range),
    severity: SEVERITY_NAMES[d.severity] ?? String(d.severity),
    message: d.message,
    source: d.source,
    code: code === undefined ? undefined : String(code),
    codeUrl,
    collection,
  };
  if (d.tags?.length) {
    problem.tags = d.tags.map((t) => ({ 1: 'unnecessary', 2: 'deprecated' }[t] ?? t));
  }
  if (d.relatedInformation?.length) {
    problem.relatedInformation = d.relatedInformation.map((ri) => ({
      file: ri.location.uri.scheme === 'file' ? ri.location.uri.fsPath : ri.location.uri.toString(),
      ...span(ri.location.range),
      message: ri.message,
    }));
  }
  return problem;
}

function compareProblems(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
    || a.message.localeCompare(b.message);
}

function formatPretty(result) {
  const lines = [];
  for (const p of result.problems) {
    const rel = path.relative(process.cwd(), p.file);
    const where = rel.startsWith('..') ? p.file : rel;
    const tag = [p.source, p.code].filter(Boolean).join(' ');
    lines.push(`${where}:${p.line}:${p.column}: ${p.severity}: ${p.message}${tag ? ` [${tag}]` : ''}`);
    for (const ri of p.relatedInformation ?? []) {
      lines.push(`  ${path.relative(process.cwd(), ri.file)}:${ri.line}:${ri.column}: note: ${ri.message}`);
    }
  }
  for (const f of result.unanalyzedFiles) {
    lines.push(`${path.relative(process.cwd(), f)}: no results from the extension`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      extension: { type: 'string' },
      workspace: { type: 'string' },
      file: { type: 'string', multiple: true },
      setting: { type: 'string', multiple: true },
      settings: { type: 'string' },
      format: { type: 'string', default: 'json' },
      timeout: { type: 'string', default: '1800' },
      'state-dir': { type: 'string' },
      log: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || !values.extension) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!['json', 'pretty'].includes(values.format)) {
    throw new Error(`unknown --format ${values.format}`);
  }

  const compileCommands = path.resolve(positionals[0]);
  const files = values.file?.length
    ? values.file.map((f) => path.resolve(f))
    : filesFromCompileCommands(compileCommands);
  const stateDir = path.resolve(values['state-dir']
    ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'extension-problems-cli'));

  const logStream = values.log ? fs.createWriteStream(values.log) : null;
  const log = (channel, text) => {
    const line = `[${channel}] ${text}\n`;
    logStream?.write(line);
    if (values.verbose) process.stderr.write(line);
  };
  const missing = new Set();
  const reportMissing = (what) => {
    if (!missing.has(what)) {
      missing.add(what);
      log('extension-problems-cli', `unimplemented API used: ${what}`);
    }
  };

  if (!process.env.JAVA_HOME) {
    const javaHome = javaHomeFromPath();
    if (javaHome) {
      process.env.JAVA_HOME = javaHome;
    }
  }

  const workspaceFolder = path.resolve(values.workspace ?? process.cwd());
  const extensionCompileCommands = absoluteCompileCommands(compileCommands);

  // Loaded here so that --help works without dependencies installed.
  const { ExtensionHost } = require('./host');
  const host = new ExtensionHost({
    extension: path.resolve(values.extension),
    workspaceFolders: [workspaceFolder],
    stateDir,
    log,
    reportMissing,
  });

  // Apply settings from least to most specific: the defaults shipped for
  // this extension, then the settings file, then --setting.
  const settings = {};
  const defaultsFile = defaultSettingsFile(host.id);
  if (defaultsFile) {
    const variables = {
      workspaceFolder: workspaceFolder,
      compileCommands: extensionCompileCommands,
    };
    Object.assign(settings, resolveSettings(readSettingsFile(defaultsFile), variables,
      (message) => log('extension-problems-cli', `${path.basename(defaultsFile)}: ${message}`)));
  }
  if (values.settings) {
    Object.assign(settings, readSettingsFile(values.settings));
  }
  for (const s of values.setting ?? []) {
    const [k, v] = parseSettingArg(s);
    settings[k] = v;
  }
  for (const [k, v] of Object.entries(settings)) {
    host.workbench.configuration.setUser(k, v);
  }

  let status = 0;
  try {
    await host.activate();
    const { timedOut, unreported } = await host.analyze(files, {
      readiness: loadReadinessRule(host.id),
      timeoutMs: Number(values.timeout) * 1000,
    });
    if (timedOut) {
      process.stderr.write(`extension-problems-cli: timed out waiting for the extension to finish\n`);
    }
    if (unreported.length) {
      status = 2;
    }
    const result = {
      extension: host.id,
      problems: host.collectDiagnostics().map(toProblem).sort(compareProblems),
      unanalyzedFiles: unreported,
    };
    process.stdout.write(values.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : formatPretty(result));
  } finally {
    await host.shutdown();
    if (logStream) await new Promise((resolve) => logStream.end(resolve));
  }
  return status;
}

module.exports = { main, filesFromCompileCommands, toProblem };
