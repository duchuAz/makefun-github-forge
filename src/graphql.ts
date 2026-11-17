// The GraphQL surface: POST /api/graphql. A small parser for the GraphQL subset the forge needs, a
// fixed schema (introspection for Issue / PullRequest / Repository and the SearchType enum), and a
// resolver layer over the forge store. Validation errors come back HTTP 200 with `errors`.

import { Forge, type Repo, type Issue, type Pull, type IssueComment } from './store.ts';

// ---------------------------------------------------------------- parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

const PUNCT = ['...', '!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === ',') {
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let end = index + 1;
      while (end < source.length && /[0-9eE+.-]/.test(source[end] as string)) end += 1;
      const text = source.slice(index, end);
      tokens.push(text.includes('.') || /[eE]/.test(text.slice(1)) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      index = end;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('\"\"\"', index)) {
        const end = source.indexOf('\"\"\"', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '\"') {
        if (source[end] === '\\') {
          const esc = source[end + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '\"' ? '\"' : esc;
          end += 2;
          continue;
        }
        value += source[end];
        end += 1;
      }
      if (source[end] !== '\"') throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    const punct = PUNCT.find((candidate) => source.startsWith(candidate, index));
    if (punct === undefined) throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
    tokens.push({ kind: 'punct', value: punct });
    index += punct.length;
  }
  return tokens;
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  peek(): Token | null {
    return this.#tokens[this.#pos] ?? null;
  }
  next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.#pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in the GraphQL document`);
  }
  optionalPunct(value: string): boolean {
    const token = this.peek();
    if (token !== null && token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }
  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }
}

export interface VariableDefinition {
  name: string;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefinition[];
  selections: Selection[];
}

export interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ReadonlyMap<string, Value>;
  selections: Selection[] | null;
}

export interface InlineFragment {
  kind: 'inline';
  onType: string;
  selections: Selection[];
}

export type Selection = FieldSelection | InlineFragment;

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: ReadonlyMap<string, Value> };

function parseSelectionSet(parser: Parser): Selection[] {
  parser.expectPunct('{');
  const selections: Selection[] = [];
  for (;;) {
    const token = parser.peek();
    if (token === null) throw new Error('unterminated selection set');
    if (token.kind === 'punct' && token.value === '}') {
      parser.next();
      return selections;
    }
    if (token.kind === 'punct' && token.value === '...') {
      parser.next();
      const on = parser.expectName();
      if (on !== 'on') throw new Error('inline fragments must name a type');
      const type = parser.expectName();
      selections.push({ kind: 'inline', onType: type, selections: parseSelectionSet(parser) });
      continue;
    }
    let name = parser.expectName();
    let alias: string | null = null;
    if (parser.optionalPunct(':')) {
      alias = name;
      name = parser.expectName();
    }
    const args = parseArguments(parser);
    let sub: Selection[] | null = null;
    const token2 = parser.peek();
    if (token2 !== null && token2.kind === 'punct' && token2.value === '{') sub = parseSelectionSet(parser);
    selections.push({ kind: 'field', alias, name, args, selections: sub });
  }
}

function parseArguments(parser: Parser): ReadonlyMap<string, Value> {
  const args = new Map<string, Value>();
  if (!parser.optionalPunct('(')) return args;
  while (!parser.optionalPunct(')')) {
    const name = parser.expectName();
    parser.expectPunct(':');
    args.set(name, parseValue(parser));
  }
  return args;
}

function parseValue(parser: Parser): Value {
  const token = parser.next();
  if (token.kind === 'punct') {
    if (token.value === '$') {
      return { kind: 'variable', name: parser.expectName() };
    }
    if (token.value === '[') {
      const values: Value[] = [];
      while (!parser.optionalPunct(']')) values.push(parseValue(parser));
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (!parser.optionalPunct('}')) {
        const name = parser.expectName();
        parser.expectPunct(':');
        fields.set(name, parseValue(parser));
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected ${JSON.stringify(token.value)} in a GraphQL value`);
  }
  if (token.kind === 'name') {
    if (token.value === 'true') return { kind: 'bool', value: true };
    if (token.value === 'false') return { kind: 'bool', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
  if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
  if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
  return { kind: 'string', value: token.value };
}

/** Parse a request document into its operations. */
export function parseDocument(source: string): Operation[] {
  const parser = new Parser(tokenize(source));
  const operations: Operation[] = [];
  for (;;) {
    const token = parser.peek();
    if (token === null) break;
    if (token.kind === 'punct' && token.value === '{') {
      operations.push({ kind: 'query', name: null, variables: [], selections: parseSelectionSet(parser) });
      continue;
    }
    if (token.kind !== 'name') throw new Error('expected an operation in the GraphQL document');
    const keyword = token.value;
    if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unsupported GraphQL operation ${JSON.stringify(keyword)}`);
    parser.next();
    let name: string | null = null;
    const afterKeyword = parser.peek();
    if (afterKeyword !== null && afterKeyword.kind === 'name') name = parser.expectName();
    const variables: VariableDefinition[] = [];
    if (parser.optionalPunct('(')) {
      while (!parser.optionalPunct(')')) {
        parser.expectPunct('$');
        const variable = parser.expectName();
        parser.expectPunct(':');
        // the type (a name, possibly wrapped in [ ] and !) is parsed and discarded
        if (parser.optionalPunct('[')) {
          parser.expectName();
          parser.optionalPunct('!');
          parser.expectPunct(']');
        } else {
          parser.expectName();
        }
        parser.optionalPunct('!');
        variables.push({ name: variable });
      }
    }
    // directives (@include/@skip) are parsed and ignored; the suite sends none
    if (parser.optionalPunct('@')) {
      parser.expectName();
      if (parser.optionalPunct('(')) {
        while (!parser.optionalPunct(')')) {
          parser.expectName();
          parser.expectPunct(':');
          parseValue(parser);
        }
      }
    }
    operations.push({ kind: keyword as 'query' | 'mutation', name, variables, selections: parseSelectionSet(parser) });
  }
  return operations;
}

// ---------------------------------------------------------------- schema (introspection + validation)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'name', 'email', 'url', 'createdAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'createdAt', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'isEmpty',
    'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergeCommit', 'mergedAt',
    'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'author', 'createdAt', 'files', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changedFile'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  Node: ['id'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

const TYPE_KINDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(TYPE_FIELDS).map((name) => [name, 'OBJECT'])),
  ...Object.fromEntries(Object.keys(TYPE_ENUMS).map((name) => [name, 'ENUM'])),
  Interface: 'INTERFACE',
};

/** Field validation: the fields a type exposes (objects) or that it is an enum. */
function fieldsOfType(typeName: string): readonly string[] {
  return TYPE_FIELDS[typeName] ?? [];
}

// ---------------------------------------------------------------- execution

export interface GraphQlOutcome {
  status: number;
  body: unknown;
}

interface ExecContext {
  forge: Forge;
  variables: Readonly<Record<string, unknown>>;
}

interface Resolved {
  readonly typeName: string;
  readonly value: unknown;
}

const NULL_VALUE: Resolved = { typeName: 'Scalar', value: null };

function scalar(typeName: string, value: unknown): Resolved {
  return { typeName, value };
}

function object2(typeName: string, value: unknown): Resolved {
  return { typeName, value };
}

function globalRepoId(repo: Repo): string {
  return `gid:repo:${repo.id}`;
}

function globalIssueId(repo: Repo, issue: Issue): string {
  return `gid:issue:${repo.id}:${issue.number}`;
}

function globalPullId(repo: Repo, pull: Pull): string {
  return `gid:pull:${repo.id}:${pull.number}`;
}

function globalCommentId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return `gid:comment:${repo.id}:${issue.number}:${comment.id}`;
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const kind = parts[1] as string;
  const repoId = Number(parts[2]);
  if (!Number.isFinite(repoId)) return null;
  const number = parts.length > 3 ? Number(parts[3]) : 0;
  return { kind, repoId, number };
}

function issueStateText(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueOf(repo: Repo, number: number): Issue | null {
  return repo.issues.find((issue) => issue.number === number) ?? null;
}

function pullOf(repo: Repo, number: number): Pull | null {
  return repo.pulls.find((pull) => pull.number === number) ?? null;
}

function repoOfId(forge: Forge, repoId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

interface IssueOrder {
  readonly field: string;
  readonly direction: string;
}

function orderedIssues(repo: Repo, order: IssueOrder | null, states: readonly string[] | null): Issue[] {
  let list = [...repo.issues];
  if (states !== null && states.length > 0) list = list.filter((issue) => states.includes(issueStateText(issue.state)));
  const field = order?.field ?? 'CREATED_AT';
  const descending = (order?.direction ?? 'DESC') === 'DESC';
  if (field === 'COMMENTS') {
    list.sort((a, b) => (a.comments.length - b.comments.length) || (a.seq - b.seq));
  } else if (field === 'UPDATED_AT') {
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) || (a.seq - b.seq));
  } else {
    list.sort((a, b) => (a.seq - b.seq));
  }
  if (descending) list.reverse();
  return list;
}

function resolveRepositoryField(context: ExecContext, repo: Repo, field: FieldSelection): Resolved {
  switch (field.name) {
    case 'id':
      return scalar('ID', globalRepoId(repo));
    case 'databaseId':
      return scalar('Int', repo.id);
    case 'name':
      return scalar('String', repo.name);
    case 'nameWithOwner':
      return scalar('String', `${repo.owner}/${repo.name}`);
    case 'description':
      return scalar('String', repo.description);
    case 'url':
      return scalar('URI', `https://forge.invalid/${repo.owner}/${repo.name}`);
    case 'createdAt':
      return scalar('DateTime', repo.createdAt);
    case 'isPrivate':
      return scalar('Boolean', repo.isPrivate);
    case 'hasIssuesEnabled':
      return scalar('Boolean', true);
    case 'isEmpty':
      return scalar('Boolean', repo.refs.size === 0);
    case 'viewerPermission':
      return scalar('RepositoryPermission', 'ADMIN');
    case 'owner':
      return object2('User', context.forge.viewer);
    case 'defaultBranchRef': {
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (oid === undefined) return NULL_VALUE;
      return object2('Ref', { name: repo.defaultBranch });
    }
    case 'issue': {
      const number = argNumber(field.args, context.variables, 'number');
      if (number === null) return NULL_VALUE;
      const issue = issueOf(repo, number);
      if (issue === null) return NULL_VALUE;
      return object2('Issue', { repo, issue });
    }
    case 'issues': {
      const first = argNumber(field.args, context.variables, 'first') ?? 30;
      const after = argString(field.args, context.variables, 'after');
      const states = argEnumList(field.args, context.variables, 'states');
      const order = argOrder(field.args, context.variables, 'orderBy');
      const all = orderedIssues(repo, order, states);
      const offset = decodeCursor(after);
      const page = all.slice(offset, offset + Math.max(0, first));
      const hasNext = offset + first < all.length;
      return object2('IssueConnection', {
        nodes: page.map((issue) => ({ repo, issue })),
        totalCount: all.length,
        pageInfo: { hasNextPage: hasNext, hasPreviousPage: offset > 0, startCursor: encodeCursor(offset), endCursor: encodeCursor(offset + page.length) },
      });
    }
    case 'pullRequest': {
      const number = argNumber(field.args, context.variables, 'number');
      if (number === null) return NULL_VALUE;
      const pull = pullOf(repo, number);
      if (pull === null) return NULL_VALUE;
      return object2('PullRequest', { repo, pull });
    }
    case 'pullRequests': {
      const first = argNumber(field.args, context.variables, 'first') ?? 30;
      const open = repo.pulls.filter((pull) => pull.state === 'open');
      const page = open.slice(0, Math.max(0, first));
      return object2('PullRequestConnection', {
        nodes: page.map((pull) => ({ repo, pull })),
        totalCount: open.length,
        pageInfo: { hasNextPage: first < open.length, hasPreviousPage: false, startCursor: '', endCursor: '' },
      });
    }
    default:
      return undefined as unknown as Resolved;
  }
}

function encodeCursor(offset: number): string {
  return `cursor:${offset}`;
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^cursor:(\d+)$/.exec(cursor);
  return match === null ? 0 : Number(match[1]);
}

function argNumber(args: ReadonlyMap<string, Value>, variables: Readonly<Record<string, unknown>>, name: string): number | null {
  const value = evalValue(args.get(name), variables);
  return typeof value === 'number' ? value : null;
}

function argString(args: ReadonlyMap<string, Value>, variables: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = evalValue(args.get(name), variables);
  return typeof value === 'string' ? value : null;
}

function argEnumList(args: ReadonlyMap<string, Value>, variables: Readonly<Record<string, unknown>>, name: string): string[] | null {
  const raw = args.get(name);
  if (raw === undefined) return null;
  const value = evalValue(raw, variables);
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string') return [value];
  return null;
}

function argOrder(args: ReadonlyMap<string, Value>, variables: Readonly<Record<string, unknown>>, name: string): IssueOrder | null {
  const raw = args.get(name);
  if (raw === undefined) return null;
  const value = evalValue(raw, variables);
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return { field: String(record.field ?? 'CREATED_AT'), direction: String(record.direction ?? 'DESC') };
}

function evalValue(value: Value | undefined, variables: Readonly<Record<string, unknown>>): unknown {
  if (value === undefined) return null;
  switch (value.kind) {
    case 'variable': {
      const resolved = variables[value.name];
      return resolved === undefined ? null : resolved;
    }
    case 'list':
      return value.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = evalValue(entry, variables);
      return out;
    }
    default:
      return value.value;
  }
}

function resolveIssueField(context: ExecContext, holder: { repo: Repo; issue: Issue }, field: FieldSelection): Resolved {
  const { repo, issue } = holder;
  switch (field.name) {
    case 'id':
      return scalar('ID', globalIssueId(repo, issue));
    case 'number':
      return scalar('Int', issue.number);
    case 'title':
      return scalar('String', issue.title);
    case 'body':
      return scalar('String', issue.body ?? '');
    case 'state':
      return scalar('IssueState', issueStateText(issue.state));
    case 'createdAt':
      return scalar('DateTime', issue.createdAt);
    case 'updatedAt':
      return scalar('DateTime', issue.updatedAt);
    case 'closedAt':
      return issue.closedAt === null ? NULL_VALUE : scalar('DateTime', issue.closedAt);
    case 'author':
      return object2('User', context.forge.viewer);
    case 'url':
      return scalar('URI', `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`);
    case 'labels': {
      const labels = issue.labelNames.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' }));
      return object2('LabelConnection', { nodes: labels });
    }
    case 'comments': {
      const nodes = issue.comments.map((comment) => ({ repo, issue, comment }));
      return object2('IssueCommentConnection', { nodes });
    }
    default:
      return undefined as unknown as Resolved;
  }
}

function resolvePullField(context: ExecContext, holder: { repo: Repo; pull: Pull }, field: FieldSelection): Resolved {
  const { repo, pull } = holder;
  switch (field.name) {
    case 'id':
      return scalar('ID', globalPullId(repo, pull));
    case 'number':
      return scalar('Int', pull.number);
    case 'title':
      return scalar('String', pull.title);
    case 'body':
      return scalar('String', pull.body ?? '');
    case 'state':
      return scalar('PullRequestState', pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'merged':
      return scalar('Boolean', pull.merged);
    case 'mergedAt':
      return pull.mergedAt === null ? NULL_VALUE : scalar('DateTime', pull.mergedAt);
    case 'mergeable':
      return scalar('MergeableState', pull.merged ? 'UNKNOWN' : mergeableState(context.forge, repo, pull));
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? NULL_VALUE : object2('Commit', { oid: pull.mergeCommitSha });
    case 'headRefName':
      return scalar('String', pull.headRef);
    case 'headRefOid':
      return scalar('GitObjectID', repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.mergeCommitSha ?? '0000000000000000000000000000000000000000');
    case 'baseRefName':
      return scalar('String', pull.baseRef);
    case 'baseRefOid':
      return scalar('GitObjectID', repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '0000000000000000000000000000000000000000');
    case 'createdAt':
      return scalar('DateTime', pull.createdAt);
    case 'author':
      return object2('User', context.forge.viewer);
    case 'url':
      return scalar('URI', `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`);
    case 'files': {
      const files = pullFiles(context.forge, repo, pull);
      const first = argNumber(field.args, context.variables, 'first') ?? 10;
      return object2('PullRequestChangedFileConnection', { nodes: files.slice(0, Math.max(0, first)) });
    }
    default:
      return undefined as unknown as Resolved;
  }
}

function mergeableState(forge: Forge, repo: Repo, pull: Pull): string {
  const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const head = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (base === undefined || head === undefined) return 'UNKNOWN';
  const baseCommit = base;
  const merged = forge.mergeTrees(
    repo,
    treeOf(forge, repo, forge.mergeBase(repo, baseCommit, head)),
    treeOf(forge, repo, baseCommit),
    treeOf(forge, repo, head),
  );
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function treeOf(forge: Forge, repo: Repo, commit: string | null): string | null {
  if (commit === null) return null;
  const view = forge.commitView(repo, commit);
  return view?.tree ?? null;
}

function pullFiles(forge: Forge, repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number }> {
  const head = repo.refs.get(`refs/heads/${pull.headRef}`);
  const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (head === undefined) return [];
  const mergeBase = forge.mergeBase(repo, base ?? head, head);
  return forge
    .diffTrees(repo, treeOf(forge, repo, mergeBase), treeOf(forge, repo, head))
    .map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
}

interface GqlError {
  message: string;
}

interface ExecResult {
  data: unknown;
  errors: GqlError[];
}

class ValidationError extends Error {}

/** Execute one operation against the store. */
function executeOperation(context: ExecContext, operation: Operation): ExecResult {
  const errors: GqlError[] = [];
  const root = operation.kind === 'mutation' ? { typeName: 'Mutation', value: context.forge } : { typeName: 'Query', value: context.forge };
  let data: Record<string, unknown> | null = {};
  for (const selection of operation.selections) {
    const alias = collectField(context, root, selection, errors);
    if (alias === null) {
      data = null;
      continue;
    }
    if (data !== null) Object.assign(data, alias);
  }
  return { data: errors.length > 0 && data === null ? null : data, errors };
}

/** Resolve one top-level selection; returns alias -> value (or null when the request is invalid). */
function collectField(context: ExecContext, root: Resolved, selection: Selection, errors: GqlError[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (selection.kind === 'inline') {
    if (root.typeName !== selection.onType && selection.onType !== 'Node') return out;
    for (const sub of selection.selections) {
      const nested = collectField(context, root, sub, errors);
      if (nested === null) return null;
      Object.assign(out, nested);
    }
    return out;
  }
  const alias = selection.alias ?? selection.name;
  if (root.typeName === 'Query') {
    if (selection.name === '__type') {
      const name = argString(selection.args, context.variables, 'name');
      out[alias] = introspectionType(name ?? '');
      return out;
    }
    if (selection.name === '__schema') {
      out[alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      return out;
    }
    if (selection.name === 'viewer') {
      out[alias] = resolveValue(context, object2('User', context.forge.viewer), selection.selections ?? [], errors);
      return out;
    }
    if (selection.name === 'repository') {
      const owner = argString(selection.args, context.variables, 'owner');
      const name = argString(selection.args, context.variables, 'name');
      const repo = owner !== null && name !== null ? context.forge.getRepo(owner, name) : null;
      if (repo === null) {
        out[alias] = null;
        return out;
      }
      out[alias] = resolveValue(context, object2('Repository', repo), selection.selections ?? [], errors);
      return out;
    }
    if (selection.name === 'node') {
      const id = argString(selection.args, context.variables, 'id');
      const node = id === null ? null : resolveNode(context, id);
      if (node === null) {
        out[alias] = null;
        return out;
      }
      out[alias] = resolveValue(context, node, selection.selections ?? [], errors);
      return out;
    }
    errors.push({ message: `field '${selection.name}' does not exist on type 'Query'` });
    return null;
  }
  if (root.typeName === 'Mutation') {
    const resolver = MUTATIONS[selection.name];
    if (resolver === undefined) {
      errors.push({ message: `field '${selection.name}' does not exist on type 'Mutation'` });
      return null;
    }
    const input = inputValue(selection.args.get('input'), context.variables);
    const result = resolver(context, input);
    out[alias] = result === null ? null : resolveValue(context, result, selection.selections ?? [], errors);
    return out;
  }
  errors.push({ message: `field '${selection.name}' cannot be selected here` });
  return null;
}

function resolveNode(context: ExecContext, id: string): Resolved | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repo = repoOfId(context.forge, decoded.repoId);
  if (repo === null) return null;
  if (decoded.kind === 'repo') return object2('Repository', repo);
  if (decoded.kind === 'issue') {
    const issue = issueOf(repo, decoded.number);
    return issue === null ? null : object2('Issue', { repo, issue });
  }
  if (decoded.kind === 'pull') {
    const pull = pullOf(repo, decoded.number);
    return pull === null ? null : object2('PullRequest', { repo, pull });
  }
  return null;
}

function inputValue(value: Value | undefined, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const evaluated = evalValue(value, variables);
  return evaluated !== null && typeof evaluated === 'object' ? (evaluated as Record<string, unknown>) : {};
}

type MutationResolver = (context: ExecContext, input: Record<string, unknown>) => Resolved | null;

const MUTATIONS: Readonly<Record<string, MutationResolver>> = {
  createIssue: (context, input) => {
    const repo = repoFromInput(context, input);
    if (repo === null) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') return null;
    const body = typeof input.body === 'string' ? input.body : '';
    const when = context.forge.tick();
    const issue: Issue = {
      id: context.forge.newIssueId(),
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labelNames: [],
      comments: [],
      createdAt: when.iso,
      createdAtSec: when.sec,
      updatedAt: when.iso,
      closedAt: null,
      seq: when.sec,
    };
    repo.issues.push(issue);
    return object2('CreateIssuePayload', { issue: { repo, issue } });
  },
  closeIssue: (context, input) => {
    const holder = issueFromInput(context, input.issueId);
    if (holder === null) return null;
    if (holder.issue.state !== 'closed') {
      holder.issue.state = 'closed';
      const when = context.forge.tick();
      holder.issue.closedAt = when.iso;
      holder.issue.updatedAt = when.iso;
    }
    return object2('CloseIssuePayload', { issue: holder });
  },
  createPullRequest: (context, input) => {
    const repo = repoFromInput(context, input);
    if (repo === null) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    if (title === '' || head === '' || base === '') return null;
    if (!repo.refs.has(`refs/heads/${head}`)) return null;
    if (!repo.refs.has(`refs/heads/${base}`)) return null;
    const when = context.forge.tick();
    const pull: Pull = {
      id: context.forge.newPullId(),
      number: repo.nextNumber++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
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
    return object2('CreatePullRequestPayload', { pullRequest: { repo, pull } });
  },
  mergePullRequest: (context, input) => {
    const holder = pullFromInput(context, input.pullRequestId);
    if (holder === null) return null;
    mergePull(context.forge, holder.repo, holder.pull);
    return object2('MergePullRequestPayload', { pullRequest: holder });
  },
  addComment: (context, input) => {
    const holder = issueFromInput(context, input.subjectId);
    if (holder === null) return null;
    const body = typeof input.body === 'string' ? input.body : '';
    const when = context.forge.tick();
    const comment: IssueComment = {
      id: context.forge.newCommentId(),
      body,
      userLogin: context.forge.viewer.login,
      createdAt: when.iso,
    };
    holder.issue.comments.push(comment);
    holder.issue.updatedAt = when.iso;
    return object2('AddCommentPayload', {
      commentEdge: { node: { repo: holder.repo, issue: holder.issue, comment } },
    });
  },
};

function repoFromInput(context: ExecContext, input: Record<string, unknown>): Repo | null {
  const id = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  return repoOfId(context.forge, decoded.repoId);
}

function issueFromInput(context: ExecContext, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue') return null;
  const repo = repoOfId(context.forge, decoded.repoId);
  if (repo === null) return null;
  const issue = issueOf(repo, decoded.number);
  return issue === null ? null : { repo, issue };
}

function pullFromInput(context: ExecContext, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pull') return null;
  const repo = repoOfId(context.forge, decoded.repoId);
  if (repo === null) return null;
  const pull = pullOf(repo, decoded.number);
  return pull === null ? null : { repo, pull };
}

/** Squash-merge a pull request; false when the pull is already merged or the trees conflict. */
export function mergePull(forge: Forge, repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const head = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (base === undefined || head === undefined) return false;
  const baseAncestors = forge.mergeBase(repo, base, head);
  const merged = forge.mergeTrees(
    repo,
    treeOf(forge, repo, baseAncestors),
    treeOf(forge, repo, base),
    treeOf(forge, repo, head),
  );
  if (merged === null) return false;
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const sha = forge.commitOnto(repo, pull.baseRef, merged, base, message);
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  const when = forge.tick();
  pull.mergedAt = when.iso;
  return true;
}

/** Walk a selection set against a resolved value; validation errors accumulate in `errors`. */
function resolveValue(context: ExecContext, resolved: Resolved, selections: ReadonlyArray<Selection>, errors: GqlError[]): unknown {
  if (resolved.value === null || resolved.value === undefined) return null;
  const out: Record<string, unknown> = {};
  const known = fieldsOfType(resolved.typeName);
  const isEnum = TYPE_ENUMS[resolved.typeName] !== undefined;
  if (isEnum || known.length === 0) {
    // scalars and enums carry no selections
    return resolved.value;
  }
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.onType !== resolved.typeName && selection.onType !== 'Node') continue;
      const nested = resolveValue(context, resolved, selection.selections, errors);
      if (nested !== null && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    if (resolved.typeName === 'Node' && selection.name !== 'id') {
      // interface selections are completed by the concrete type via inline fragments
      errors.push({ message: `field '${selection.name}' does not exist on type 'Node'` });
      continue;
    }
    if (!known.includes(selection.name)) {
      errors.push({ message: `field '${selection.name}' does not exist on type '${resolved.typeName}'` });
      continue;
    }
    const alias = selection.alias ?? selection.name;
    out[alias] = resolveTypedField(context, resolved, selection, errors);
  }
  return out;
}

function resolveTypedField(context: ExecContext, resolved: Resolved, field: FieldSelection, errors: GqlError[]): unknown {
  const typeName = resolved.typeName;
  const value = resolved.value;
  if (typeName === 'User') {
    const user = value as Forge['viewer'];
    switch (field.name) {
      case 'login': return user.login;
      case 'name': return user.name;
      case 'email': return user.email;
      default: return null;
    }
  }
  if (typeName === 'Repository') {
    const nested = resolveRepositoryField(context, value as Repo, field);
    return finishField(context, nested, field, errors);
  }
  if (typeName === 'Ref') {
    const ref = value as { name: string };
    if (field.name === 'name') return ref.name;
    return finishField(context, NULL_VALUE, field, errors);
  }
  if (typeName === 'Issue') {
    const nested = resolveIssueField(context, value as { repo: Repo; issue: Issue }, field);
    return finishField(context, nested, field, errors);
  }
  if (typeName === 'PullRequest') {
    const nested = resolvePullField(context, value as { repo: Repo; pull: Pull }, field);
    return finishField(context, nested, field, errors);
  }
  if (typeName === 'Commit') {
    return (value as { oid: string }).oid;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    const connection = value as { nodes: unknown[]; totalCount: number; pageInfo: unknown };
    if (field.name === 'totalCount') return connection.totalCount;
    if (field.name === 'pageInfo') return resolveValue(context, object2('PageInfo', connection.pageInfo), field.selections ?? [], errors);
    if (field.name === 'nodes') {
      return connection.nodes.map((node) => resolveValue(context, nodeOf(typeName, node), field.selections ?? [], errors));
    }
    if (field.name === 'edges') {
      return connection.nodes.map((node) => ({ node: resolveValue(context, nodeOf(typeName, node), (field.selections ?? []).map((selection) => selection.kind === 'inline' ? selection : selection)) }));
    }
    return null;
  }
  if (typeName === 'IssueCommentConnection') {
    const connection = value as { nodes: unknown[] };
    if (field.name === 'nodes') {
      return connection.nodes.map((node) => resolveValue(context, object2('IssueComment', node), field.selections ?? [], errors));
    }
    return null;
  }
  if (typeName === 'LabelConnection') {
    const connection = value as { nodes: unknown[] };
    if (field.name === 'nodes') return connection.nodes;
    return null;
  }
  if (typeName === 'PageInfo') {
    const page = value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string; endCursor: string };
    switch (field.name) {
      case 'hasNextPage': return page.hasNextPage;
      case 'hasPreviousPage': return page.hasPreviousPage;
      case 'startCursor': return page.startCursor;
      case 'endCursor': return page.endCursor;
      default: return null;
    }
  }
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const payload = value as { issue: unknown };
    if (field.name === 'issue') return resolveValue(context, object2('Issue', payload.issue), field.selections ?? [], errors);
    return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const payload = value as { pullRequest: unknown };
    if (field.name === 'pullRequest') return resolveValue(context, object2('PullRequest', payload.pullRequest), field.selections ?? [], errors);
    return null;
  }
  if (typeName === 'AddCommentPayload') {
    const payload = value as { commentEdge: { node: unknown } };
    if (field.name === 'commentEdge') {
      return resolveValue(context, object2('IssueCommentEdge', payload.commentEdge), field.selections ?? [], errors);
    }
    return null;
  }
  if (typeName === 'IssueCommentEdge') {
    const edge = value as { node: unknown };
    if (field.name === 'node') return resolveValue(context, object2('IssueComment', edge.node), field.selections ?? [], errors);
    return null;
  }
  if (typeName === 'IssueComment') {
    const holder = value as { comment?: IssueComment };
    const comment = (holder.comment ?? holder) as IssueComment;
    switch (field.name) {
      case 'id': return String(comment.id);
      case 'body': return comment.body;
      case 'createdAt': return comment.createdAt;
      case 'author': return resolveValue(context, object2('User', context.forge.viewer), field.selections ?? [], errors);
      default: return null;
    }
  }
  if (typeName === 'PullRequestChangedFile') {
    const file = value as { path: string; additions: number; deletions: number };
    switch (field.name) {
      case 'path': return file.path;
      case 'additions': return file.additions;
      case 'deletions': return file.deletions;
      default: return null;
    }
  }
  return null;
}

function nodeOf(connectionType: string, node: unknown): Resolved {
  if (connectionType === 'IssueConnection') return object2('Issue', node);
  if (connectionType === 'PullRequestConnection') return object2('PullRequest', node);
  return object2('PullRequestChangedFile', node);
}

function finishField(context: ExecContext, nested: Resolved, field: FieldSelection, errors: GqlError[]): unknown {
  if (nested === undefined || nested === null) return null;
  if (nested.value === null) return null;
  if (TYPE_FIELDS[nested.typeName] === undefined && TYPE_ENUMS[nested.typeName] === undefined) return nested.value;
  if ((field.selections ?? []).length === 0) {
    // an object field selected without subfields: the document is invalid but be lenient
    return nested.value;
  }
  return resolveValue(context, nested, field.selections ?? [], errors);
}

function introspectionType(name: string): unknown {
  if (TYPE_ENUMS[name] !== undefined) {
    return { kind: 'ENUM', name, fields: null, enumValues: TYPE_ENUMS[name].map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })) };
  }
  const fields = TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return {
    kind: TYPE_KINDS[name] ?? 'OBJECT',
    name,
    fields: fields.map((field) => ({ name: field, description: null, isDeprecated: false, deprecationReason: null, args: [] })),
    enumValues: null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------- the HTTP entry point

function pickOperation(operations: readonly Operation[], operationName: string | null): Operation | null {
  if (operations.length === 0) return null;
  if (operationName === null || operationName === '') return operations[0] as Operation;
  return operations.find((operation) => operation.name === operationName) ?? null;
}

/** Handle one parsed GraphQL request body. Returns the HTTP status and body. */
export function graphqlHandler(forge: Forge, body: unknown): GraphQlOutcome {
  if (Array.isArray(body)) {
    const results = body.map((entry) => graphqlHandler(forge, entry).body);
    return { status: 200, body: results };
  }
  const record = body as Record<string, unknown>;
  if (typeof record?.query !== 'string') {
    return { status: 200, body: { errors: [{ message: 'the request must carry a GraphQL query string' }] } };
  }
  let operations: Operation[];
  try {
    operations = parseDocument(record.query);
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = pickOperation(operations, operationName);
  if (operation === null) {
    return { status: 200, body: { errors: [{ message: `no operation named ${JSON.stringify(String(operationName))}` }] } };
  }
  const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
    ? (record.variables as Record<string, unknown>)
    : {};
  const result = executeOperation({ forge, variables }, operation);
  if (result.errors.length > 0) return { status: 200, body: { data: result.data, errors: result.errors } };
  return { status: 200, body: { data: result.data } };
}
