// main.ts is mend, the CLI SPEC.md specifies. Fresh rewrite: sections 1 to 4, 9 and 10
// (command line, output and exit codes, safe paths, format detection, JSON edits and the
// all-or-nothing write, including R lines for moves) plus sections 5 to 8 written new here:
// line matching at three tiers (section 5) and the unified diff (6), SEARCH/REPLACE (7) and
// V4A (8) readers. Each of the three readers is an explicit state machine: it walks the
// patch lines once, in one named state at a time, and only that state's transitions run.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

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
  readonly moves: Array<{ old: string; nu: string }> = [];
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

// ---------------------------------------------------------------------------
// Section 3: a file's lines. The break is CRLF when the file's first line feed
// follows a carriage return, LF otherwise; lines are the text split at that
// break only, so a bare LF inside a CRLF file stays inside its line.
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers, and building the replacement.
// ---------------------------------------------------------------------------

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position at or after `from` where O occurs in F at `tier`. */
function occurrences(O: string[], F: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const want = O.map((l) => normLine(l, tier));
  const start = Math.max(0, from);
  for (let i = start; i + O.length <= F.length; i++) {
    if (eofOnly && i + O.length !== F.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(F[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions. */
function findFirstTier(O: string[], F: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  for (const t of tierList(strict)) {
    const p = occurrences(O, F, t, from, eofOnly);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the lines that replace a match at `pos` (tier `tier`): a context line is
 * written as the file's own matched line; at tier 2 every other non-blank line
 * that starts with O's first line's leading whitespace has it replaced by the
 * file's first matched line's leading whitespace; all other lines as they are.
 */
function buildN(O: string[], N: NLine[], F: string[], pos: number, tier: number): string[] {
  const pfx = O.length > 0 ? leadingWs(O[0]!) : '';
  const fpfx = O.length > 0 ? leadingWs(F[pos]!) : '';
  return N.map((nl) => {
    if (nl.ctx !== null) return F[pos + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(pfx)) return fpfx + nl.text.slice(pfx.length);
    return nl.text;
  });
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      O.push(e.text);
      N.push({ text: e.text, ctx: O.length - 1 });
    } else if (e.kind === 'old') {
      O.push(e.text);
    } else if (e.kind === 'new') {
      N.push({ text: e.text, ctx: null });
    }
  }
  return { O, N };
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastNBackslash(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === 'bs';
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs. State machine over the patch lines.
// States: outside (no section yet, or between sections after a body),
//   header (inside a section, before its first hunk), body (inside a hunk),
//   after (inside a section, after a hunk body ended).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : parseInt(m[1]!, 10);
}

/** The path after `--- ` / `+++ `: text after four characters, up to a tab, trimmed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type State = 'outside' | 'header' | 'body' | 'after';
  interface Draft {
    pairOld: string | null;
    pairNew: string | null;
    renFrom: string | null;
    renTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    create: boolean;
    remove: boolean;
    hunks: Hunk[];
  }
  const newDraft = (): Draft => ({ pairOld: null, pairNew: null, renFrom: null, renTo: null, diffOld: null, diffNew: null, create: false, remove: false, hunks: [] });
  const sections: Draft[] = [];
  let state: State = 'outside';
  let cur: Draft | null = null;
  let hunk: { a: number; raw: string[] } | null = null;

  const endBody = (): void => {
    if (hunk === null || cur === null) {
      hunk = null;
      return;
    }
    const raw = hunk.raw;
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    const body: BodyLine[] = raw.map((l) => {
      if (l === '') return { kind: 'ctx' as const, text: '' };
      if (l.startsWith(' ')) return { kind: 'ctx' as const, text: l.slice(1) };
      if (l.startsWith('-')) return { kind: 'old' as const, text: l.slice(1) };
      if (l.startsWith('+')) return { kind: 'new' as const, text: l.slice(1) };
      return { kind: 'bs' as const, text: l.slice(1) };
    });
    cur.hunks.push({ a: hunk.a, body });
    hunk = null;
  };
  const startSection = (d: Draft): void => {
    endBody();
    cur = d;
    sections.push(d);
    state = 'header';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const d = newDraft();
      d.diffOld = dg[0];
      d.diffNew = dg[1];
      startSection(d);
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (state === 'header' && cur !== null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(next);
      } else {
        const d = newDraft();
        d.pairOld = headerPath(line);
        d.pairNew = headerPath(next);
        startSection(d);
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'outside' || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      endBody();
      hunk = { a, raw: [] };
      state = 'body';
      continue;
    }
    if (state === 'body') {
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk!.raw.push(line);
        continue;
      }
      endBody();
      state = 'after';
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        continue;
      }
      continue;
    }
    // outside / after: any other line is ignored prose.
  }
  endBody();

  const resolve = (s: Draft): UniSection => {
    const oldP =
      s.pairOld !== null ? (s.pairOld === '/dev/null' ? null : stripAB(s.pairOld)) : s.renFrom !== null ? s.renFrom : s.diffOld;
    const newP =
      s.pairNew !== null ? (s.pairNew === '/dev/null' ? null : stripAB(s.pairNew)) : s.renTo !== null ? s.renTo : s.diffNew;
    return { oldP, newP, create: s.create, remove: s.remove, hunks: s.hunks };
  };

  return sections.map((d) => uniEdit(resolve(d), strict));
}

/** Apply a section's hunks in order to a file's lines; returns the new lines and final-break flag. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length > 0) {
      const found = findFirstTier(O, lines, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEof = best + O.length === lines.length;
      const built = buildN(O, N, lines, best, found.tier);
      lines = [...lines.slice(0, best), ...built, ...lines.slice(best + O.length)];
      if (atEof) final = !lastNBackslash(h.body);
    } else {
      const ins = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = ins === lines.length;
      const built = buildN(O, N, lines, ins, 0);
      lines = [...lines.slice(0, ins), ...built, ...lines.slice(ins)];
      if (atEnd) final = !lastNBackslash(h.body);
    }
    d += N.length - O.length;
  }
  return { lines, br: f.br, final };
}

/** The created file's text: every `+` line of every hunk, in order. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let lastBs = false;
  for (const h of hunks) {
    let lastPlus = -1;
    for (let i = 0; i < h.body.length; i++) {
      if (h.body[i]!.kind === 'new') {
        plus.push(h.body[i]!.text);
        lastPlus = i;
      }
    }
    if (lastPlus >= 0) lastBs = h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === 'bs';
  }
  return joinFile(plus, '\n', plus.length > 0 ? !lastBs : false);
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    if (s.oldP !== null && !safe(s.oldP)) throw new Fail('unsafe', s.oldP);
    if (s.newP !== null && !safe(s.newP)) throw new Fail('unsafe', s.newP);
    if (s.create || s.oldP === null) {
      if (s.newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(s.newP) !== null) throw new Fail('exists', s.newP);
      tree.now.set(s.newP, creationText(s.hunks));
      return;
    }
    if (s.remove || s.newP === null) {
      if (s.oldP === null) throw new Fail('missing', '/dev/null');
      if (tree.get(s.oldP) === null) throw new Fail('missing', s.oldP);
      tree.now.set(s.oldP, null);
      return;
    }
    if (s.oldP !== s.newP) {
      const content = tree.get(s.oldP);
      if (content === null) throw new Fail('missing', s.oldP);
      if (tree.get(s.newP) !== null) throw new Fail('exists', s.newP);
      const r = applyHunks(splitFile(content), s.hunks, strict, s.oldP);
      tree.now.set(s.oldP, null);
      tree.now.set(s.newP, joinFile(r.lines, r.br, r.final));
      tree.moves.push({ old: s.oldP, nu: s.newP });
      return;
    }
    const content = tree.get(s.oldP);
    if (content === null) throw new Fail('missing', s.oldP);
    const r = applyHunks(splitFile(content), s.hunks, strict, s.oldP);
    tree.now.set(s.oldP, joinFile(r.lines, r.br, r.final));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks. State machine over the patch lines.
// States: outside (between blocks), inOld (old lines), inNew (new lines).
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  type State = 'outside' | 'inOld' | 'inNew';
  const blocks: SRBlock[] = [];
  let state: State = 'outside';
  let cur: { path: string; searchLine: number; oldLines: string[]; newLines: string[] } | null = null;
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trimEnd();
    if (state === 'outside') {
      if (t === '<<<<<<< SEARCH') {
        let path: string | null = null;
        for (let j = i - 1; j >= prevEnd; j--) {
          const l = lines[j]!;
          if (blank(l)) continue;
          if (l.trim().startsWith('```')) continue;
          path = l.trim();
          break;
        }
        if (path === null) {
          if (prevPath !== null) path = prevPath;
          else throw new Exit2(`error: parse ${i + 1}`);
        }
        cur = { path, searchLine: i + 1, oldLines: [], newLines: [] };
        state = 'inOld';
      }
      continue;
    }
    if (state === 'inOld') {
      if (t === '=======') {
        state = 'inNew';
        continue;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${cur!.searchLine}`);
      cur!.oldLines.push(line);
      continue;
    }
    if (t === '>>>>>>> REPLACE') {
      blocks.push({ path: cur!.path, oldLines: cur!.oldLines, newLines: cur!.newLines });
      prevPath = cur!.path;
      prevEnd = i + 1;
      cur = null;
      state = 'outside';
      continue;
    }
    if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${cur!.searchLine}`);
    cur!.newLines.push(line);
  }
  if (state !== 'outside') throw new Exit2(`error: parse ${cur!.searchLine}`);
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile(b.newLines, '\n', true));
      return;
    }
    const content = tree.get(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const f = splitFile(content);
    const found = findFirstTier(b.oldLines, f.lines, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const built = buildN(b.oldLines, N, f.lines, pos, found.tier);
    const lines = [...f.lines.slice(0, pos), ...built, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile(lines, f.br, f.final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches. Two state machines: the outer one walks sections
// between `*** Begin Patch` and `*** End Patch`; the inner one walks an Update
// File section's lines. Inner states: start (before the first chunk),
// chunk (inside a chunk), afterEof (after `*** End of File`, only `@@` or the
// section's end may follow).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
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
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
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
    const secLineNo = i + 1;
    i++;
    const raw: Array<{ no: number; text: string }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ no: i + 1, text: l });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push(finishVSection(kind, path, secLineNo, raw));
  }
  return sections.map((s) => vEdit(s, strict));
}

function finishVSection(kind: 'add' | 'delete' | 'update', path: string, lineNo: number, raw: Array<{ no: number; text: string }>): VSection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
      else if (r.text === '') addLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return { kind, path, lineNo, moveTo: null, addLines, chunks: [] };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return { kind, path, lineNo, moveTo: null, addLines: [], chunks: [] };
  }
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  type UState = 'start' | 'chunk' | 'afterEof';
  let st: UState = 'start';
  for (let idx = 0; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      st = 'chunk';
      continue;
    }
    if (l === '*** End of File') {
      if (st !== 'chunk' || cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      cur = null;
      st = 'afterEof';
      continue;
    }
    if (l.startsWith('*** Move to: ') && idx === 0 && st === 'start' && moveTo === null) {
      moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (st === 'afterEof') throw new Exit2(`error: parse ${r.no}`);
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      st = 'chunk';
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return { kind, path, lineNo, moveTo, addLines: [], chunks };
}

function vEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile(s.addLines, '\n', true));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const content = tree.get(s.path);
    if (content === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(content);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      // The anchor is the chunk's landmark line: O is searched from the anchor
      // line itself, because the chunk's first context line may be that very
      // line (a chunk anchored at `a` whose body opens with ` a` edits from
      // `a` on). An empty O, though, is inserted at the cursor, which the
      // anchor moves past the anchor line.
      let searchFrom = cursor;
      let insertAt = cursor;
      if (ch.anchor !== null) {
        const found = findFirstTier([ch.anchor], lines, strict, cursor, false);
        if (found === null) throw new Fail('no-match', s.path);
        searchFrom = found.positions[0]!;
        insertAt = found.positions[0]! + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length > 0) {
        const found = findFirstTier(O, lines, strict, searchFrom, ch.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.positions[0]!;
        const built = buildN(O, N, lines, pos, found.tier);
        lines = [...lines.slice(0, pos), ...built, ...lines.slice(pos + O.length)];
        cursor = pos + N.length;
      } else {
        const ins = ch.eof ? lines.length : insertAt;
        const built = buildN(O, N, lines, ins, 0);
        lines = [...lines.slice(0, ins), ...built, ...lines.slice(ins)];
        cursor = ins + N.length;
      }
    }
    const text = joinFile(lines, f.br, f.final);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push({ old: s.path, nu: s.moveTo });
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
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
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
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
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { key: string; line: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    if (
      tree.original(m.old) !== null &&
      tree.original(m.nu) === null &&
      tree.get(m.old) === null &&
      tree.get(m.nu) !== null &&
      changed.has(m.old) &&
      changed.has(m.nu)
    ) {
      changed.delete(m.old);
      changed.delete(m.nu);
      changed.set(`R:${m.nu}`, { key: m.nu, line: `R ${m.old} -> ${m.nu}` });
    }
  }
  const rows = [...changed.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))).map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
