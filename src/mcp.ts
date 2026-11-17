// The MCP surface: POST /mcp, JSON-RPC 2.0 over Streamable HTTP. Both discovery eras are served:
// the modern `server/discover` handshake (revision 2026-07-28, supportedVersions advertised) and the
// legacy `initialize` handshake (the requested protocolVersion echoed back). Tools operate on the
// same forge store as REST and GraphQL.

import { Forge, ApiError, type Repo, type Issue, type Pull } from './store.ts';
import { mergePull } from './graphql.ts';

export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25'];
export const MCP_SERVER_NAME = 'makefun-forge';
export const MCP_SERVER_VERSION = '1.0.0';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, { type: string; description: string; required?: boolean }>>,
): ToolSpec => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { type: value.type, description: value.description }])),
    required: Object.entries(properties).filter(([, value]) => value.required === true).map(([key]) => key),
  },
});

/** The tool list is a stable, byte-identical constant across calls. */
export const TOOLS: readonly ToolSpec[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated account. Returns the repository as JSON.',
    {
      name: { type: 'string', description: 'The repository name (letters, digits, dot, dash, underscore).', required: true },
      description: { type: 'string', description: 'A short human-readable description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  ),
  tool(
    'get_repo',
    'Get one repository by owner and name. Returns the repository as JSON, including its full_name.',
    {
      owner: { type: 'string', description: 'The login that owns the repository.', required: true },
      repo: { type: 'string', description: 'The repository name.', required: true },
    },
  ),
  tool(
    'create_issue',
    'Open an issue on a repository. Returns the issue as JSON, including its number and title.',
    {
      owner: { type: 'string', description: 'The login that owns the repository.', required: true },
      repo: { type: 'string', description: 'The repository name.', required: true },
      title: { type: 'string', description: 'The issue title.', required: true },
      body: { type: 'string', description: 'The issue body in plain text or Markdown.' },
    },
  ),
  tool(
    'list_issues',
    'List issues of a repository, most recently created first. Returns an array of issue JSON.',
    {
      owner: { type: 'string', description: 'The login that owns the repository.', required: true },
      repo: { type: 'string', description: 'The repository name.', required: true },
      state: { type: 'string', description: 'Filter by state: open, closed or all. Defaults to open.' },
    },
  ),
  tool(
    'create_pull_request',
    'Open a pull request from an existing head branch onto a base branch. Returns the pull request as JSON.',
    {
      owner: { type: 'string', description: 'The login that owns the repository.', required: true },
      repo: { type: 'string', description: 'The repository name.', required: true },
      title: { type: 'string', description: 'The pull request title.', required: true },
      head: { type: 'string', description: 'The name of the branch the changes come from.', required: true },
      base: { type: 'string', description: 'The name of the branch the changes merge into.', required: true },
      body: { type: 'string', description: 'The pull request body in plain text or Markdown.' },
    },
  ),
  tool(
    'merge_pull_request',
    'Squash-merge an open pull request onto its base branch. Returns { merged: true, sha } as JSON.',
    {
      owner: { type: 'string', description: 'The login that owns the repository.', required: true },
      repo: { type: 'string', description: 'The repository name.', required: true },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.', required: true },
      merge_method: { type: 'string', description: 'The merge method: squash (the default) or merge.' },
    },
  ),
]);

export interface McpOutcome {
  status: number;
  body: unknown;
}

interface JsonRpcErrorBody {
  code: number;
  message: string;
}

function success(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function failure(id: unknown, error: JsonRpcErrorBody, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id, error } };
}

/** Handle one MCP request. `body` is the parsed JSON (or a string when it never parsed). */
export function mcpHandler(forge: Forge, raw: string, parsed: unknown): McpOutcome {
  if (typeof parsed === 'undefined') {
    return failure(null, { code: -32700, message: 'Parse error: the request body is not JSON' }, 400);
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed.map((entry) => mcpHandler(forge, raw, entry));
    const errors = outcomes.find((outcome) => outcome.status !== 200);
    if (errors !== undefined && outcomes.length === 1) return outcomes[0] as McpOutcome;
    return { status: 200, body: outcomes.map((outcome) => outcome.body) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return failure(null, { code: -32600, message: 'the request is not a JSON-RPC 2.0 message' }, 400);
  }
  const message = parsed as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') {
    return failure(message.id ?? null, { code: -32600, message: 'the request must carry jsonrpc: "2.0"' }, 200);
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id ?? null;
  const isNotification = !('id' in message);
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    return success(id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
      instructions: 'A GitHub-compatible forge: repositories, issues, labels, pull requests.',
    });
  }
  if (method === 'initialize') {
    const requested = typeof message.params === 'object' && message.params !== null
      ? (message.params as Record<string, unknown>).protocolVersion
      : undefined;
    const version = typeof requested === 'string' && MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0];
    return success(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions: 'A GitHub-compatible forge: repositories, issues, labels, pull requests.',
    });
  }
  if (method === 'ping') return success(id, {});
  if (method === 'tools/list') {
    return success(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    return toolsCall(forge, id, message.params);
  }
  return failure(id, { code: -32601, message: `method not found: ${method || '(none)'}` });
}

function toolsCall(forge: Forge, id: unknown, params: unknown): McpOutcome {
  const record = params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const toolSpec = TOOLS.find((candidate) => candidate.name === name);
  if (toolSpec === undefined) {
    return failure(id, { code: -32602, message: `unknown tool: ${name === '' ? '(none)' : name}` });
  }
  const args = record.arguments !== null && typeof record.arguments === 'object' ? (record.arguments as Record<string, unknown>) : {};
  for (const required of toolSpec.inputSchema.required) {
    if (args[required] === undefined) {
      return failure(id, { code: -32602, message: `missing required argument '${required}' for tool ${name}` });
    }
  }
  try {
    const payload = runTool(forge, name, args);
    return success(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload });
  } catch (err) {
    if (err instanceof ApiError) {
      return success(id, {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        structuredContent: { error: err.message },
      });
    }
    return success(id, {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      structuredContent: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  return forge.ownedRepo(owner, name);
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(
        String(args.name ?? ''),
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(repoOf(forge, args));
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      const issue = forge.openIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return issues.map((issue) => issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const title = String(args.title ?? '');
      const pull = forge.openPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return pullJson(repo, pull, {
        headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? '',
        baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '',
      });
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) throw new ApiError(404, `pull request ${number} not found on ${repo.owner}/${repo.name}`);
      if (pull.merged) throw new ApiError(405, `pull request ${number} is already merged`);
      const merged = mergePull(forge, repo, pull);
      if (!merged) throw new ApiError(405, `pull request ${number} cannot be merged cleanly`);
      return { merged: true, sha: pull.mergeCommitSha, number: pull.number, message: 'Pull Request successfully merged' };
    }
    default:
      throw new ApiError(400, `tool ${name} is not implemented`);
  }
}

// ---------------------------------------------------------------- JSON views shared with REST

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `gid:repo:${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id * 2, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    size: repo.objects.size,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `gid:issue:${repo.id}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: repo.owner, type: 'User' },
    labels: issue.labelNames.map((labelName) => ({
      id: labelName.length * 7919,
      name: labelName,
      color: repo.labels.get(labelName)?.color ?? 'ededed',
      default: false,
    })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://forge.invalid/_comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull, refs: { headSha: string; baseSha: string }): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `gid:pull:${repo.id}:${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.mergedAt ?? pull.createdAt,
    head: { ref: pull.headRef, sha: refs.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: refs.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}
