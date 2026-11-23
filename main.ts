// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all ten sections of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** Moves a successful move edit made, in patch order: used to print `R` lines (section 2). */
const moves: Array<{ old: string; new: string }> = [];

// ---------------------------------------------------------------------------
// Section 3: a file's lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** A line reduced the way a tier compares it: 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i >= `from` where O's lines match the file's lines i, i+1, ... at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || lines.length < k) return out;
  for (let i = from; i + k <= lines.length; i++) {
    if (eofOnly && i + k !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (lineKey(lines[i + j]!, tier) !== lineKey(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions, or null. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const positions = occurrences(lines, o, t, from, eofOnly);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` at the first tier where one is, or -1. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const t of tiers(strict)) {
    const key = lineKey(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (lineKey(lines[i]!, t) === key) return i;
    }
  }
  return -1;
}

function leadingOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/** Tier 2 re-indent of one new line: P (O's first line's leading whitespace) replaced by F (the file's). */
function reindentLine(text: string, p: string, f: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NewItem {
  text: string;
  /** Index into O (and into the file's matched lines) when this is a context line, else null. */
  ctx: number | null;
}

/** N with context lines taken from the file and other lines re-indented at tier 2. */
function mapNew(n: NewItem[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  if (tier !== 2 || o.length === 0) {
    return n.map((it) => (it.ctx !== null ? fileLines[pos + it.ctx]! : it.text));
  }
  const p = leadingOf(o[0]!);
  const f = leadingOf(fileLines[pos]!);
  return n.map((it) => (it.ctx !== null ? fileLines[pos + it.ctx]! : reindentLine(it.text, p, f)));
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffA: string | null;
  diffB: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function blankUSection(): USection {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffA: null,
    diffB: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

/** A `diff --git` line: the bare words or the words followed by a space and paths. */
function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function bodyLine(line: string): UBody | null {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'old', text: line.slice(1) };
  if (c === '+') return { kind: 'new', text: line.slice(1) };
  if (c === '\\') return { kind: 'bs', text: line };
  return null;
}

/** Empty lines at the end of a hunk body are not part of it. */
function stripBody(hunk: UHunk): void {
  while (hunk.body.length > 0) {
    const last = hunk.body[hunk.body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
    else break;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let curHunk: UHunk | null = null;

  const startSection = (s: USection): void => {
    if (curHunk) {
      stripBody(curHunk);
      curHunk = null;
    }
    if (cur) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  const startDiffSection = (line: string, lineNo: number): void => {
    const [a, b] = parseDiffGit(line, lineNo);
    const s = blankUSection();
    s.diffA = a;
    s.diffB = b;
    startSection(s);
  };
  const startPairSection = (oldLine: string, newLine: string): void => {
    const s = blankUSection();
    s.pairOld = headerPath(oldLine.slice(4));
    s.pairNew = headerPath(newLine.slice(4));
    startSection(s);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (curHunk) {
      if (isDiffGitLine(line)) {
        stripBody(curHunk);
        curHunk = null;
        startDiffSection(line, i + 1);
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        stripBody(curHunk);
        curHunk = null;
        startPairSection(line, lines[i + 1]!);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        stripBody(curHunk);
        curHunk = { a: parseHunkHeader(line, i + 1), body: [] };
        cur!.hunks.push(curHunk);
        continue;
      }
      const bl = bodyLine(line);
      if (bl) {
        curHunk.body.push(bl);
        continue;
      }
      stripBody(curHunk);
      curHunk = null;
      // The body ended: fall through and handle this line outside the body.
    }
    if (!cur) {
      if (isDiffGitLine(line)) {
        startDiffSection(line, i + 1);
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startPairSection(line, lines[i + 1]!);
        i += 1;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      continue;
    }
    if (inHeader) {
      if (isDiffGitLine(line)) {
        startDiffSection(line, i + 1);
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null && cur.pairNew === null) {
            cur.pairOld = headerPath(line.slice(4));
            cur.pairNew = headerPath(lines[i + 1]!.slice(4));
          }
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (line.startsWith('@@')) {
        curHunk = { a: parseHunkHeader(line, i + 1), body: [] };
        cur.hunks.push(curHunk);
        inHeader = false;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        continue;
      }
      continue;
    }
    if (isDiffGitLine(line)) {
      startDiffSection(line, i + 1);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startPairSection(line, lines[i + 1]!);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      curHunk = { a: parseHunkHeader(line, i + 1), body: [] };
      cur.hunks.push(curHunk);
      continue;
    }
  }
  if (curHunk) stripBody(curHunk);
  if (cur) sections.push(cur);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One hunk applied to the working file state; `d` is the drift of the hunks before it. */
function applyUnifiedHunk(state: FileState, hunk: UHunk, d: number, strict: boolean, path: string): void {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: '', ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: null });
    }
  }
  let lastCN = -1;
  for (let k = 0; k < hunk.body.length; k++) {
    if (hunk.body[k]!.kind === 'ctx' || hunk.body[k]!.kind === 'new') lastCN = k;
  }
  const noEol = lastCN >= 0 && hunk.body[lastCN + 1] !== undefined && hunk.body[lastCN + 1]!.kind === 'bs';
  if (o.length > 0) {
    const found = findTier(state.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const newSpan = mapNew(n, state.lines, best, found.tier, o);
    const touchesEnd = best + o.length === state.lines.length;
    state.lines = [...state.lines.slice(0, best), ...newSpan, ...state.lines.slice(best + o.length)];
    if (touchesEnd) state.final = !noEol;
  } else {
    const at = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
    const newSpan = mapNew(n, state.lines, at, 0, o);
    const touchesEnd = at === state.lines.length;
    state.lines = [...state.lines.slice(0, at), ...newSpan, ...state.lines.slice(at)];
    if (touchesEnd) state.final = !noEol;
  }
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffA;
    const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffB;
    const isCreate = sec.isCreate || oldPath === null;
    const isDelete = !isCreate && (sec.isDelete || newPath === null);
    if (isCreate) {
      const np = newPath ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const outLines: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k++) if (h.body[k]!.kind === 'new') lastPlus = k;
        if (lastPlus >= 0) {
          finalBreak = !(h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === 'bs');
        }
        for (const b of h.body) if (b.kind === 'new') outLines.push(b.text);
      }
      tree.now.set(np, outLines.length === 0 ? '' : outLines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const isMove = oldPath !== newPath;
    const op = oldPath ?? '';
    const np = newPath ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const state = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      const oLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old').length;
      const nLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'new').length;
      applyUnifiedHunk(state, h, d, strict, op);
      d += nLen - oLen;
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      moves.push({ old: op, new: np });
    } else {
      tree.now.set(op, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const state = splitFile(cur);
    const found = findTier(state.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    let newSpan: string[];
    if (found.tier === 2) {
      const p = leadingOf(oldLines[0]!);
      const f = leadingOf(state.lines[pos]!);
      newSpan = newLines.map((l) => reindentLine(l, p, f));
    } else {
      newSpan = [...newLines];
    }
    const out = [...state.lines.slice(0, pos), ...newSpan, ...state.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, state.br, state.final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewItem[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    let end = last;
    for (let j = i + 1; j < last; j++) {
      if (isSectionStart(lines[j]!)) {
        end = j;
        break;
      }
    }
    const content = lines.slice(i + 1, end);
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    const contentStart = i + 1;
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl.startsWith('+')) addLines.push(cl.slice(1));
        else if (cl === '') addLines.push('');
        else throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
      edits.push(v4aAddEdit(path, addLines));
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${contentStart + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < content.length && content[k]!.startsWith('*** Move to: ')) {
        moveTo = content[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < content.length; k++) {
        const cl = content[k]!;
        const lineNo = contentStart + k + 1;
        if (cl.startsWith('@@')) {
          pushCur();
          const anchor = cl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          continue;
        }
        if (cl.trimEnd() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          pushCur();
          continue;
        }
        if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
          if (!cur) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, eof: false, o: [], n: [] };
          }
          if (cl === '') {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          } else if (cl.startsWith(' ')) {
            cur.o.push(cl.slice(1));
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          } else if (cl.startsWith('-')) {
            cur.o.push(cl.slice(1));
          } else {
            cur.n.push({ text: cl.slice(1), ctx: null });
          }
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = end;
  }
  return edits;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = splitFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(state.lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? state.lines.length : cursor;
        const newSpan = chunk.n.map((it) => it.text);
        state.lines = [...state.lines.slice(0, at), ...newSpan, ...state.lines.slice(at)];
        cursor = at + newSpan.length;
        continue;
      }
      const found = findTier(state.lines, chunk.o, strict, cursor, chunk.eof);
      if (!found) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const newSpan = mapNew(chunk.n, state.lines, pos, found.tier, chunk.o);
      state.lines = [...state.lines.slice(0, pos), ...newSpan, ...state.lines.slice(pos + chunk.o.length)];
      cursor = pos + newSpan.length;
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const m of moves) {
    if (rOld.has(m.old) || rNew.has(m.new)) continue;
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      rOld.add(m.old);
      rNew.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
