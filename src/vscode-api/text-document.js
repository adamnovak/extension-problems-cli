/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { Position, Range, EndOfLine } = require('./types');

/**
 * An in-memory vscode.TextDocument. The host never edits documents, so the
 * text and version stay as they were when the document was opened.
 */
class TextDocument {
  constructor(uri, languageId, text, version = 1) {
    this.uri = uri;
    this.languageId = languageId;
    this.version = version;
    this.isDirty = false;
    this.isClosed = false;
    this.encoding = 'utf8';
    this._text = text;
    // Offset of the first character of each line.
    this._lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\r' && text[i + 1] === '\n') {
        i++;
      }
      if (c === '\r' || c === '\n') {
        this._lineStarts.push(i + 1);
      }
    }
  }

  get fileName() { return this.uri.fsPath; }
  get isUntitled() { return this.uri.scheme === 'untitled'; }
  get lineCount() { return this._lineStarts.length; }
  get eol() { return this._text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF; }

  save() { return Promise.resolve(true); }

  getText(range) {
    if (!range) {
      return this._text;
    }
    const r = this.validateRange(range);
    return this._text.slice(this.offsetAt(r.start), this.offsetAt(r.end));
  }

  _lineEnd(line) {
    // End of line content, excluding the line break.
    let end = line + 1 < this._lineStarts.length ? this._lineStarts[line + 1] : this._text.length;
    while (end > this._lineStarts[line] && (this._text[end - 1] === '\n' || this._text[end - 1] === '\r')) {
      end--;
    }
    return end;
  }

  lineAt(lineOrPosition) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    if (line < 0 || line >= this.lineCount) {
      throw new Error(`Illegal value for line: ${line}`);
    }
    const start = this._lineStarts[line];
    const end = this._lineEnd(line);
    const text = this._text.slice(start, end);
    const breakEnd = line + 1 < this.lineCount ? this._lineStarts[line + 1] : end;
    const firstNonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(this.positionAt(start), this.positionAt(breakEnd)),
      firstNonWhitespaceCharacterIndex: firstNonWs === -1 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs === -1,
    };
  }

  offsetAt(position) {
    const p = this.validatePosition(position);
    return this._lineStarts[p.line] + p.character;
  }

  positionAt(offset) {
    const o = Math.max(0, Math.min(offset, this._text.length));
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this._lineStarts[mid] <= o) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return new Position(lo, Math.min(o - this._lineStarts[lo], this._lineEnd(lo) - this._lineStarts[lo]));
  }

  validatePosition(position) {
    if (position.line < 0) {
      return new Position(0, 0);
    }
    if (position.line >= this.lineCount) {
      const last = this.lineCount - 1;
      return new Position(last, this._lineEnd(last) - this._lineStarts[last]);
    }
    const len = this._lineEnd(position.line) - this._lineStarts[position.line];
    return new Position(position.line, Math.max(0, Math.min(position.character, len)));
  }

  validateRange(range) {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  getWordRangeAtPosition(position, regex = /[A-Za-z_]\w*/g) {
    const p = this.validatePosition(position);
    const { text } = this.lineAt(p.line);
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index <= p.character && p.character <= m.index + m[0].length) {
        return new Range(p.line, m.index, p.line, m.index + m[0].length);
      }
      if (m[0].length === 0) {
        re.lastIndex++;
      }
    }
    return undefined;
  }
}

module.exports = { TextDocument };
