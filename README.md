# extension-problems-cli

`extension-problems-cli` runs a VS Code extension without VS Code and prints
the problems it reports, the ones VS Code would show in its Problems panel.

## Setup

You need Node.js 20.12 or newer. Clone this repository and install its
dependencies:

```
git clone <this repository> ~/extension-problems-cli
cd ~/extension-problems-cli
npm install
```

Then run it from any directory with `npx ~/extension-problems-cli`.

You also need the extension you want to run, as a `.vsix` file.

## Running

Give it the extension and the files or directories to analyze. It searches
directories recursively, skipping hidden ones and `node_modules`:

```
npx ~/extension-problems-cli --extension EXTENSION.vsix src test
```

For C or C++, give it your compilation database instead. It analyzes every
file listed there:

```
npx ~/extension-problems-cli --extension EXTENSION.vsix \
    --compile-commands build/compile_commands.json
```

`--setting KEY=VALUE` sets an extension setting, as in VS Code's
`settings.json`. If the results look wrong, add `--log FILE` and read what
the extension logged.

## Output

The tool prints a JSON object. Its `problems` list has one entry per
problem, with `file`, `line`, `column`, `endLine`, `endColumn`, `severity`,
`message`, `source`, and `code`. Lines and columns start at 1.

With `--format pretty` it prints one line per problem instead:

```
FILE:LINE:COLUMN: SEVERITY: MESSAGE [SOURCE CODE]
```

The exit status is 0 when the extension reported on every file. It is 2 when
some files got no report within `--timeout` seconds (30 minutes by default);
those files are listed in `unanalyzedFiles`. It is 1 when the tool failed.

## Example: SonarQube for IDE

[SonarQube for IDE](https://github.com/SonarSource/sonarlint-vscode)
(formerly SonarLint) needs Java 21 or newer, for any language. On Ubuntu:

```
sudo apt install openjdk-21-jre-headless
```

Download the extension from its
[releases](https://github.com/SonarSource/sonarlint-vscode/releases), taking
the file without a platform in its name:

```
curl -LO https://github.com/SonarSource/sonarlint-vscode/releases/download/6.1.0%2B91156/sonarlint-vscode-6.1.0.vsix
```

Analyze a C++ project:

```
cd ~/project
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --compile-commands build/compile_commands.json
```

The first run takes longer while the extension downloads its C/C++ analyzer.
The tool waits for the download, so the results are still complete.

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

Analyze a JavaScript project's source and tests:

```
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix src test
```

Turn off a rule by its code:

```
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --setting 'sonarlint.rules={"cpp:S5827":{"level":"off"}}' \
    --compile-commands build/compile_commands.json
```
