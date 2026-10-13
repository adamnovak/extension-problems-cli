# extension-problems-cli

`extension-problems-cli` runs a VS Code extension without VS Code. It opens
the files you name in the extension, waits for it to finish analyzing them,
and prints the problems it reports: the entries VS Code would show in its
Problems panel.

It works with extensions that report problems through the standard VS Code
API, usually by running a language server. Extensions that need someone to
click through dialogs, or that only show results in their own panels, will
not produce useful output.

## Installing

You need Node.js 20.12 or newer.

```
git clone <this repository>
cd extension-problems-cli
npm install
npm install --global .
```

The last step puts `extension-problems-cli` on your `PATH`. You can skip it
and run `bin/extension-problems-cli.js` from the repository instead.

You also need the extension itself, as a `.vsix` file or an unpacked
extension directory.

## Usage

```
extension-problems-cli --extension EXTENSION.vsix [options] [PATH...]
```

Each `PATH` is a file or directory to analyze. The tool searches directories
recursively for files in languages VS Code or the extension recognizes,
skipping hidden files and directories and `node_modules`.

For C and C++, pass `--compile-commands compile_commands.json`. With no
`PATH`, the tool analyzes every file in that compilation database. Entries
may use a relative `directory`, which is resolved against the database file,
so you can commit a database that works on every machine.

Other options:

* `--workspace DIR` sets the folder the extension sees as the open workspace.
  It defaults to the current directory.
* `--setting KEY=VALUE` and `--settings FILE` set extension settings, as in
  VS Code's `settings.json`. A `VALUE` is parsed as JSON when it can be.
* `--format pretty` prints compiler-style lines instead of JSON.
* `--log FILE` saves the extension's output channels and the messages it
  tried to show you. Start here when results look wrong.
* `--timeout SECONDS` limits the wait for results. The default is 30 minutes.

Run `extension-problems-cli --help` for the full list.

The extension stores its data under `~/.cache/extension-problems-cli`, or
`$XDG_CACHE_HOME/extension-problems-cli`, so things it downloads or
remembers carry over between runs. `--state-dir` moves it.

### Output

The default output is a JSON object. Lines and columns start at 1, as in the
editor.

```json
{
  "extension": "SonarSource.sonarlint-vscode",
  "problems": [
    {
      "file": "/home/you/project/src/util.cpp",
      "line": 11,
      "column": 12,
      "endLine": 11,
      "endColumn": 17,
      "severity": "warning",
      "message": "Division by zero [+4 locations]",
      "source": "sonarqube",
      "code": "cpp:S3518",
      "collection": "sonarlint"
    }
  ],
  "unanalyzedFiles": []
}
```

`unanalyzedFiles` lists files the extension never reported on before the
timeout. The exit status is 0 when every file got a report, 2 when some
did not, and 1 when the tool failed.

With `--format pretty`:

```
src/util.cpp:11:12: warning: Division by zero [+4 locations] [sonarqube cpp:S3518]
```

## Example: SonarQube for IDE

[SonarQube for IDE](https://github.com/SonarSource/sonarlint-vscode)
(formerly SonarLint) analyzes C, C++, JavaScript, TypeScript, Python, Java,
and other languages. This tool ships settings for it that turn off its
telemetry and error reporting.

Its language server needs Java 21 or newer. It finds Java through
`JAVA_HOME`; when `JAVA_HOME` is unset, `extension-problems-cli` asks the
`java` on your `PATH` where it is installed. On Ubuntu:

```
sudo apt install openjdk-21-jre-headless
```

Download the platform-independent `.vsix` from the
[releases page](https://github.com/SonarSource/sonarlint-vscode/releases):

```
curl -LO https://github.com/SonarSource/sonarlint-vscode/releases/download/6.1.0%2B91156/sonarlint-vscode-6.1.0.vsix
```

Analyze a C++ project that has a compilation database:

```
cd ~/project
extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --compile-commands build/compile_commands.json --format pretty
```

Analyze a JavaScript project's source and tests:

```
extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix src test
```

Turn off a rule:

```
extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --setting 'sonarlint.rules={"cpp:S5827":{"level":"off"}}' \
    --compile-commands build/compile_commands.json
```

The first run on a machine takes longer, because the extension downloads
its C/C++ analyzer then. The tool waits for the download before opening
files, so the first run's results are complete.

The `example` directory in this repository holds a small C++ program with a
compilation database you can try this on.

## Configuring an extension

The tool reads `extension-configs/<extension ID>.jsonc` from its installation
directory when it loads an extension. The extension ID is the publisher and
name from its `package.json`, such as `SonarSource.sonarlint-vscode`. The
file can contain comments, like `settings.json`. Both sections are optional:

```jsonc
{
  // Settings applied before any given on the command line.
  "settings": {
    "sonarlint.disableTelemetry": true,
    "sonarlint.pathToCompileCommands": "${compileCommands}"
  },
  // How to ask the extension's language server whether it can analyze yet.
  "readiness": {
    "client": "SonarLint Language Server",
    "request": "sonarlint/getPluginStatuses",
    "params": {},
    "notReadyWhen": { "path": "pluginStatuses.*.state", "equals": 2 }
  }
}
```

Setting values can use `${compileCommands}`, `${workspaceFolder}`, and
`${env:NAME}`. The tool leaves out a setting whose variable has no value,
such as `${compileCommands}` when you did not pass `--compile-commands`.

The tool sends the `readiness` request through the extension's own
language client and treats the server as not ready while any value at
`path` in the response equals `equals`. It opens files only once the server
is ready, and reopens them if the server stops being ready. Without a
`readiness` section, the tool opens files right away and takes the first
complete set of results.

## How it works

The tool loads the extension's JavaScript into its own Node.js process and
answers the extension's `require('vscode')` with an implementation of the
VS Code API in `src/vscode-api`. That implementation covers what language
server extensions use: settings, documents, editors, diagnostics, commands,
progress, output channels, and extension storage. Any other API member the
extension touches gets a stand-in that does nothing, and the tool records
the access in the `--log` file.

Messages the extension shows are logged and dismissed. Requests to open a
browser are logged and refused.

To send readiness requests, the tool needs the extension's language client.
Extensions bundle their own copy of `vscode-languageclient`, so the tool
recognizes the client when the library subscribes to editor events. That
relies on a private field of the library, `_client`, and a future version of
the library could break it.

## License

`src/vscode-api` implements the VS Code extension API and may contain code
equivalent to VS Code's own. It is under the MIT license in
`src/vscode-api/LICENSE.txt`, which carries the copyright notices of VS Code
and VSCodium.
