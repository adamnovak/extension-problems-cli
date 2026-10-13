# extension-problems-cli

`extension-problems-cli` runs a VS Code extension without VS Code and prints
the problems it reports, the ones VS Code would show in its Problems panel.
You can use it to get SonarQube for IDE (SonarLint) results from the command
line.

## Setup

You need Node.js 20.12 or newer. Clone this repository and install its
dependencies:

```
git clone <this repository> ~/extension-problems-cli
cd ~/extension-problems-cli
npm install
```

Then run it from any directory with `npx ~/extension-problems-cli`.

SonarQube for IDE also needs Java 21 or newer, for any language. On Ubuntu:

```
sudo apt install openjdk-21-jre-headless
```

Download the extension from the
[SonarQube for IDE releases](https://github.com/SonarSource/sonarlint-vscode/releases).
Take the file without a platform in its name:

```
curl -LO https://github.com/SonarSource/sonarlint-vscode/releases/download/6.1.0%2B91156/sonarlint-vscode-6.1.0.vsix
```

## Running

For C or C++, give it your compilation database. It analyzes every file
listed there:

```
cd ~/project
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --compile-commands build/compile_commands.json
```

For other languages, give it files or directories. It searches directories
recursively, skipping hidden ones and `node_modules`:

```
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix src test
```

The first run takes longer while the extension downloads its C/C++ analyzer.
The tool waits for the download, so the results are still complete.

To turn off a rule, pass its code in a setting:

```
npx ~/extension-problems-cli --extension ~/sonarlint-vscode-6.1.0.vsix \
    --setting 'sonarlint.rules={"cpp:S5827":{"level":"off"}}' \
    --compile-commands build/compile_commands.json
```

If the results look wrong, add `--log FILE` and read what the extension
logged.

## Output

The tool prints JSON. Lines and columns start at 1.

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

With `--format pretty` it prints one line per problem instead:

```
src/util.cpp:11:12: warning: Division by zero [+4 locations] [sonarqube cpp:S3518]
```

The exit status is 0 when the extension reported on every file. It is 2 when
some files got no report within `--timeout` seconds (30 minutes by default);
those files are listed in `unanalyzedFiles`. It is 1 when the tool failed.
