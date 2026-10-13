# extension-problems-cli

Run a VS Code extension from the command line, without VS Code, and print the
problems it would show in the Problems tab.

It is built to run [SonarQube for IDE](https://github.com/SonarSource/sonarlint-vscode)
(formerly SonarLint) against a C/C++ `compile_commands.json`. It implements the
parts of the `vscode` extension API that the extension uses, loads the
extension's own code from its `.vsix`, opens each source file in the
compilation database, and collects what the extension puts in its diagnostic
collections.

## Requirements

* Node.js 20 or newer
* For SonarQube for IDE: a Java 21+ runtime, which it finds through
  `JAVA_HOME`. If `JAVA_HOME` is unset, the tool sets it to the installation
  that the `java` on `PATH` reports. On Ubuntu:
  `sudo apt install openjdk-21-jre-headless`
* The extension `.vsix`, from the
  [sonarlint-vscode releases page](https://github.com/SonarSource/sonarlint-vscode/releases).
  The platform-independent `sonarlint-vscode-<version>.vsix` works on any
  platform that has a system Java.

```
npm install
```

## Usage

```
bin/extension-problems-cli.js --extension sonarlint-vscode-6.1.0.vsix \
    --workspace example example/compile_commands.json
```

A compilation database with relative `directory` fields, like the one in
`example/`, is taken relative to the database file. The extension is given an
absolute-path copy, since the format requires absolute directories.

Output is JSON:

```json
{
  "extension": "SonarSource.sonarlint-vscode",
  "problems": [
    {
      "file": "/path/to/project/src/util.cpp",
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

Lines and columns are 1-based, as in the editor's UI. `--format pretty`
prints compiler-style lines instead:

```
src/util.cpp:11:12: warning: Division by zero [+4 locations] [sonarqube cpp:S3518]
```

Run `bin/extension-problems-cli.js --help` for all options. Useful ones:

* `--setting KEY=VALUE` sets any extension setting, for example
  `--setting 'sonarlint.rules={"cpp:S5827":{"level":"off"}}'`.
* `--file FILE` analyzes only some of the files.
* `--log FILE` saves the extension's output channels, its messages to the
  user, and the unimplemented API members it touched.

Exit status is 0 when every file got results, 2 when some files got none
before `--timeout`, and 1 on other errors.

### Extension configs

`extension-configs/<extension id>.jsonc` configures one extension. It may have
comments and trailing commas, like VS Code's `settings.json`, and two
optional sections:

* `settings`: settings applied before any given on the command line. String
  values can use these variables:
  * `${compileCommands}`: the compilation database, with absolute directories
  * `${workspaceFolder}`: the `--workspace` directory
  * `${env:NAME}`: an environment variable

  A setting that uses an unavailable variable is skipped.
* `readiness`: how to ask the extension's language server whether it can
  analyze yet. Some servers are not ready right away; SonarQube for IDE, for
  example, downloads its C/C++ analyzer on first use. The rule names an LSP
  request to send through the extension's language client and which response
  values mean "not ready". Files are opened only when the server is ready, and
  opened again if it stops being ready.

The SonarQube for IDE config turns off telemetry and monitoring, points the
extension at the compilation database, and waits for analyzer downloads.

The extension's `LanguageClient` is found when vscode-languageclient's
document features subscribe to editor events, passing themselves as
`thisArgs`; the client is their private `_client` field.

## License

`src/vscode-api/` implements the VS Code extension API and may contain code
equivalent to VS Code's own, so it carries the VS Code and VSCodium MIT
license in `src/vscode-api/LICENSE.txt`.

## How it works

* `src/vscode-api/` is the `vscode` module. `require('vscode')` from the
  extension resolves to it. API members it lacks are replaced by inert stand-ins
  and logged, so new extension versions degrade rather than crash.
* `src/host.js` unpacks the `.vsix` (cached under `--state-dir`), activates
  the extension, opens and shows each file, and waits until every file has had
  diagnostics published and no `window.withProgress` task is running.
* Messages the extension shows to the user are logged and dismissed. Commands
  it runs on the editor itself are logged and do nothing.
