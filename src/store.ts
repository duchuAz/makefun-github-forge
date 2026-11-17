// The forge's in-memory store: users, repositories, git objects, refs, issues, labels and pull
// requests, plus the small git object model every surface shares (REST contents, GraphQL reads and
// the smart-HTTP protocol all read and write the same objects).
//
// Determinism: ids increment, timestamps derive from a fixed epoch plus a monotone counter, and no
// clock or randomness enters the state. Two runs that receive the same requests build the same state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- deterministic scenario identity

/** The suite's fixed scenario seed (wire.ts SCENARIO_SEED): the contest's fixed data. */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a 64-bit of a label. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64 finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return z ^ (z >> 31n);
}

/** xorshift64* generator, seeded from the scenario seed and a label. */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    this.#state = seed & U64_MASK;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The deterministic users the suite's seeded scenario builds; the viewer owns the token. */
function generateUsers(count: number): ForgeUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------- git object model

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = data;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTreeData(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = data;
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = data;
  const blank = buffer.indexOf('\n\n');
  const headerText = buffer.subarray(0, blank < 0 ? buffer.length : blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommitData(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  ident: string;
  timestampSec: number;
}): Buffer {
  const when = `${fields.ident} ${fields.timestampSec} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${when}`, `committer ${when}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- the store

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  comments: IssueComment[];
  createdAt: string;
  createdAtSec: number;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  createdAt: string;
  createdAtSec: number;
  mergedAt: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  createdAt: string;
  seq: number;
  packCache: Map<string, { pack: Buffer; shallows: string[]; unshallows: string[] }>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The fixed instant the forge's clock starts from; timestamps advance one counter tick at a time. */
const EPOCH_SEC = 1_735_689_600;

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

export class Forge {
  readonly viewer: ForgeUser;
  readonly users: Map<string, ForgeUser>;
  readonly repos: Map<string, Repo>;
  private nextUserId: number;
  private nextRepoId: number;
  private nextIssueId: number;
  private nextCommentId: number;
  private nextPullId: number;
  private clockSec: number;

  constructor() {
    const users = generateUsers(12);
    this.viewer = users[0] as ForgeUser;
    this.users = new Map(users.map((user) => [user.login, user]));
    this.repos = new Map();
    this.nextUserId = 2000;
    this.nextRepoId = 5000;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.nextPullId = 1;
    this.clockSec = EPOCH_SEC;
  }

  tick(): { sec: number; iso: string } {
    const sec = this.clockSec;
    this.clockSec += 1;
    return { sec, iso: isoOf(sec) };
  }

  newIssueId(): number {
    return this.nextIssueId++;
  }

  newPullId(): number {
    return this.nextPullId++;
  }

  newCommentId(): number {
    return this.nextCommentId++;
  }

  /** Open a new issue; 422 when any label is unknown (GitHub semantics). */
  openIssue(repo: Repo, title: string, body: string, labelNames: readonly string[] = []): Issue {
    if (title === '') throw new ApiError(422, 'the issue title is required');
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName)) throw new ApiError(422, `label ${JSON.stringify(labelName)} does not exist on ${repo.owner}/${repo.name}`);
    }
    const when = this.tick();
    const issue: Issue = {
      id: this.newIssueId(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labelNames: [...labelNames],
      comments: [],
      createdAt: when.iso,
      createdAtSec: when.sec,
      updatedAt: when.iso,
      closedAt: null,
      seq: when.sec,
    };
    repo.issues.push(issue);
    return issue;
  }

  /** Append a comment to an issue. */
  addComment(issue: Issue, body: string): { id: number; body: string; userLogin: string; createdAt: string } {
    const when = this.tick();
    const comment = { id: this.newCommentId(), body, userLogin: this.viewer.login, createdAt: when.iso };
    issue.comments.push(comment);
    issue.updatedAt = when.iso;
    return comment;
  }

  /** Open a pull request: both branches must exist. */
  openPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    if (title === '') throw new ApiError(422, 'the pull request title is required');
    if (!repo.refs.has(`refs/heads/${head}`)) throw new ApiError(422, `head branch refs/heads/${head} does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) throw new ApiError(422, `base branch refs/heads/${base} does not exist`);
    const when = this.tick();
    const pull: Pull = {
      id: this.newPullId(),
      number: repo.nextNumber++,
      title,
      body,
      headRef: head,
      baseRef: base,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      createdAt: when.iso,
      createdAtSec: when.sec,
      mergedAt: null,
      seq: when.sec,
    };
    repo.pulls.push(pull);
    return pull;
  }

  ident(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  /** The repo for an authenticated viewer request: 404 (never 403) when it belongs to someone else. */
  ownedRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (repo === null || repo.owner !== this.viewer.login) {
      throw new ApiError(404, 'Not Found');
    }
    return repo;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new ApiError(422, `the repository name ${JSON.stringify(name)} is not valid`);
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) throw new ApiError(422, 'name already exists on this account');
    const when = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      createdAt: when.iso,
      seq: when.sec,
      packCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  // ---------------------------------------------------------------- object helpers

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  commitView(repo: Repo, oid: string): CommitView | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Peel a tag reference to the commit it names (a commit peels to itself). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') current = parseTag(object.data).object;
      else return null;
    }
    return null;
  }

  /** Resolve a ref-ish name (branch, tag, full ref or raw sha) to a commit sha. */
  resolveCommitish(repo: Repo, name: string): string | null {
    if (name === '') return this.headCommit(repo);
    if (isObjectId(name)) return repo.objects.has(name) ? name : null;
    const candidates = [name, `refs/heads/${name}`, `refs/tags/${name}`, `refs/${name}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) {
        const peeled = this.peelToCommit(repo, oid);
        if (peeled !== null) return peeled;
      }
    }
    return null;
  }

  headCommit(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Every commit id reachable from `roots` (commits only, via parents). */
  ancestorCommits(repo: Repo, roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const view = this.commitView(repo, oid);
      if (view === null) continue;
      seen.add(oid);
      for (const parent of view.parents) queue.push(parent);
    }
    return seen;
  }

  isAncestor(repo: Repo, maybeAncestor: string, descendant: string): boolean {
    if (maybeAncestor === descendant) return true;
    return this.ancestorCommits(repo, [descendant]).has(maybeAncestor);
  }

  /** The first commit of `b`'s history that is also an ancestor of `a` (their merge base). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = this.ancestorCommits(repo, [a]);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const view = this.commitView(repo, oid);
      if (view === null) continue;
      for (const parent of view.parents) queue.push(parent);
    }
    return null;
  }

  /** Flatten a tree recursively into path -> {mode, oid} (gitlinks skipped). */
  flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    if (treeOid === null) return out;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = `${prefix}${entry.name}`;
      if (entry.mode === '40000') {
        for (const [childPath, child] of this.flattenTree(repo, entry.oid, `${path}/`)) out.set(childPath, child);
        out.set(`${path}/`, { mode: entry.mode, oid: entry.oid });
      } else if (entry.mode !== '160000') {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** Set `segments` to `oid` in the tree, rebuilding nested trees; null writes into nothing. */
  setTreePath(repo: Repo, treeOid: string | null, segments: readonly string[], oid: string, mode: string): string {
    const name = segments[0] as string;
    if (segments.length === 1) {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)!.data);
      const kept = entries.filter((entry) => entry.name !== name);
      kept.push({ mode, name, oid });
      return this.putObject(repo, 'tree', buildTreeData(kept));
    }
    const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)!.data);
    const existing = entries.find((entry) => entry.name === name && entry.mode === '40000');
    const childOid = this.setTreePath(repo, existing?.oid ?? null, segments.slice(1), oid, mode);
    const kept = entries.filter((entry) => entry.name !== name);
    kept.push({ mode: '40000', name, oid: childOid });
    return this.putObject(repo, 'tree', buildTreeData(kept));
  }

  /** Remove `segments` from the tree; empty parent directories vanish, as on GitHub. */
  removeTreePath(repo: Repo, treeOid: string | null, segments: readonly string[]): string | null {
    if (treeOid === null) return null;
    const entries = parseTree(repo.objects.get(treeOid)!.data);
    const name = segments[0] as string;
    const kept: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name !== name) {
        kept.push(entry);
        continue;
      }
      if (segments.length > 1 && entry.mode === '40000') {
        const child = this.removeTreePath(repo, entry.oid, segments.slice(1));
        if (child !== null) kept.push({ mode: '40000', name: entry.name, oid: child });
      }
      // a one-segment removal (or an emptied subtree) just drops the entry
    }
    return this.putObject(repo, 'tree', buildTreeData(kept));
  }

  /** Walk `segments` from a tree: the entry found, or null. */
  treeEntryAt(repo: Repo, treeOid: string, segments: readonly string[]): TreeEntry | null {
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /**
   * Three-way tree merge (base, ours, theirs at the commit level). Returns the merged root tree oid,
   * or null on a conflict.
   */
  mergeTrees(repo: Repo, baseTree: string | null, ourTree: string | null, theirTree: string | null): string | null {
    const read = (oid: string | null): Map<string, TreeEntry> => {
      if (oid === null) return new Map();
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return new Map();
      return new Map(parseTree(object.data).map((entry) => [entry.name, entry]));
    };
    const base = read(baseTree);
    const ours = read(ourTree);
    const theirs = read(theirTree);
    const names = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged: TreeEntry[] = [];
    for (const name of names) {
      const b = base.get(name);
      const o = ours.get(name);
      const t = theirs.get(name);
      const oOid = o?.oid ?? null;
      const tOid = t?.oid ?? null;
      const bOid = b?.oid ?? null;
      if (oOid === tOid) {
        if (o !== undefined) merged.push(o);
        continue;
      }
      if (bOid !== null && o !== undefined && t !== undefined && o.mode === '40000' && t.mode === '40000' && (b?.mode === '40000' || b === undefined)) {
        const sub = this.mergeTrees(repo, bOid, oOid, tOid);
        if (sub === null) return null;
        merged.push({ mode: '40000', name, oid: sub });
        continue;
      }
      if (oOid === bOid) {
        if (t !== undefined) merged.push(t);
        continue;
      }
      if (tOid === bOid) {
        if (o !== undefined) merged.push(o);
        continue;
      }
      return null;
    }
    return this.putObject(repo, 'tree', buildTreeData(merged));
  }

  /** Commit a merged or squashed tree onto `baseTip` and move the ref. */
  commitOnto(repo: Repo, branch: string, treeOid: string, parent: string | null, message: string): string {
    const when = this.tick();
    const data = buildCommitData({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      ident: this.ident(),
      timestampSec: when.sec,
    });
    const sha = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.packCache.clear();
    return sha;
  }

  // ---------------------------------------------------------------- line diffs (pull files)

  lineCounts(oldBytes: Buffer | null, newBytes: Buffer | null): { additions: number; deletions: number } {
    const lines = (bytes: Buffer | null): Set<Buffer> => {
      const out = new Set<Buffer>();
      if (bytes === null) return out;
      let start = 0;
      for (let index = 0; index <= bytes.length; index += 1) {
        if (index === bytes.length || bytes[index] === 0x0a) {
          if (index > start) out.add(bytes.subarray(start, index));
          start = index + 1;
        }
      }
      return out;
    };
    const oldLines = lines(oldBytes);
    const newLines = lines(newBytes);
    let shared = 0;
    for (const line of oldLines) if (newLines.has(line)) shared += 1;
    return { additions: newLines.size - shared, deletions: oldLines.size - shared };
  }

  /** The changed paths between two trees: filename, status and change counts. */
  diffTrees(repo: Repo, fromTree: string | null, toTree: string | null): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const from = this.flattenTree(repo, fromTree);
    const to = this.flattenTree(repo, toTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...from.keys(), ...to.keys()]);
    for (const path of paths) {
      if (path.endsWith('/')) continue;
      const before = from.get(path);
      const after = to.get(path);
      if (before?.oid === after?.oid && before !== undefined && after !== undefined) continue;
      const oldBytes = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
      const newBytes = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
      const counts = this.lineCounts(oldBytes, newBytes);
      const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
      out.push({
        filename: path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }
}
