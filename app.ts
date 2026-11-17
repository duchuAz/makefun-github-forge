// The forge's HTTP surface: /healthz, REST v3 under /api/v3, git smart HTTP at /{owner}/{repo}.git,
// GraphQL at /api/graphql and MCP at /mcp — one process, one in-memory store. app.ts is deliberately
// separate from main.ts: this is the server, the file you grow; main.ts is the entry <-> env
// lifecycle and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, ApiError, type Repo, type Issue, type Pull, hashObject, parseTree, parseCommit, isObjectId } from './src/store.ts';
import {
  ZERO_OID, pkt, FLUSH, decodePktLines, v0Advertisement, v2Advertisement, lsRefs, v0Fetch, v2Fetch,
  parseReceiveRequest, applyReceiveCommands, receiveReport, advertisedRefs, type PktLine,
} from './src/gitproto.ts';
import { graphqlHandler } from './src/graphql.ts';
import { mcpHandler, repoJson, issueJson, issueJsonText, commentJson, pullJson } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const forge = new Forge();
let requestIdCounter = 1;

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestIdCounter++}`,
    ...headers,
  });
  res.end(text);
}

/** Answer one request with already-serialized JSON text; headers and framing match sendJson. */
function sendJsonText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  const body = `${text}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': `req-${requestIdCounter++}`,
    ...headers,
  });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole body of a request as a Buffer (bounded to keep one bad client from ballooning). */
function readBody(req: IncomingMessage, limitBytes = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new ApiError(413, 'the request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string).trim();
}

/** The token every authenticated call presents. When MAKEFUN_SHOP_TOKEN is unset (local dev) any token is accepted. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const presented = bearerToken(req);
  if (presented === null) return false;
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

// ---------------------------------------------------------------- REST

/** REST replies share GitHub's JSON error shape. */
function restError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function repoUrl(repo: Repo): string {
  return `/api/v3/repos/${repo.owner}/${repo.name}`;
}

function branchSha(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function resolveRefInput(repo: Repo, input: string | null): string | null {
  if (input === null || input === '') return forge.headCommit(repo);
  return forge.resolveCommitish(repo, input);
}

function refJson(name: string, sha: string): Record<string, unknown> {
  return { ref: name, node_id: `gid:ref:${sha}`, url: `/api/v3/repos/_/git/refs/${name}`, object: { sha, type: 'commit', url: `/api/v3/repos/_/git/commits/${sha}` } };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  return { id: name.length * 7919, node_id: `gid:label:${repo.id}:${name}`, name, color: repo.labels.get(name)?.color ?? 'ededed', default: false, url: `${repoUrl(repo)}/labels/${name}` };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const view = forge.commitView(repo, sha);
  const parents = view?.parents ?? [];
  const parseIdent = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (match === null) return { name: ident, email: '', date: new Date(0).toISOString() };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  const author = parseIdent(view?.author ?? forge.ident());
  const committer = parseIdent(view?.committer ?? forge.ident());
  return {
    sha,
    node_id: `gid:commit:${sha}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `${repoUrl(repo)}/commits/${sha}`,
    commit: {
      message: (view?.message ?? '').replace(/\n+$/, ''),
      author: { ...author, date: author.date },
      committer: { ...committer, date: committer.date },
      tree: { sha: view?.tree ?? '', url: `${repoUrl(repo)}/git/trees/${view?.tree ?? ''}` },
      url: `${repoUrl(repo)}/git/commits/${sha}`,
    },
    author,
    committer,
    parents: parents.map((parent) => ({ sha: parent, url: `${repoUrl(repo)}/commits/${parent}` })),
  };
}

function fileJson(repo: Repo, path: string, oid: string, data: Buffer, refName: string): Record<string, unknown> {
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size: data.length,
    url: `${repoUrl(repo)}/contents/${path}?ref=${refName}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${refName}/${path}`,
    git_url: `${repoUrl(repo)}/git/blobs/${oid}`,
    type: 'file',
    content: data.toString('base64'),
    encoding: 'base64',
    _links: { self: `${repoUrl(repo)}/contents/${path}?ref=${refName}`, git: `${repoUrl(repo)}/git/blobs/${oid}`, html: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${refName}/${path}` },
  };
}

function treeJson(repo: Repo, path: string, oid: string, refName: string): Record<string, unknown> {
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    url: `${repoUrl(repo)}/contents/${path}?ref=${refName}`,
    git_url: `${repoUrl(repo)}/git/trees/${oid}`,
    type: 'dir',
  };
}

/** One contents write: blob, tree rebuild, commit, ref move. The caller validates the sha rules. */
function commitFile(repo: Repo, branch: string, path: string, base64Content: string, message: string): { commitSha: string; blobOid: string; blobData: Buffer } {
  const blobData = Buffer.from(base64Content, 'base64');
  const blobOid = forge.putObject(repo, 'blob', blobData);
  const tip = branchSha(repo, branch);
  const segments = path.split('/').filter((segment) => segment !== '');
  const baseTree = tip === null ? null : parseCommit(forge.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree;
  const treeOid = forge.setTreePath(repo, baseTree, segments, blobOid, '100644');
  const commitSha = forge.commitOnto(repo, branch, treeOid, tip, message);
  return { commitSha, blobOid, blobData };
}

/** DELETE one file: rebuild the tree without it and commit. */
function deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string; blobOid: string } {
  const tip = branchSha(repo, branch);
  if (tip === null) throw new ApiError(404, `${path} does not exist on ${branch}`);
  const segments = path.split('/').filter((segment) => segment !== '');
  const commitView = parseCommit(forge.getObject(repo, tip)?.data ?? Buffer.alloc(0));
  const entry = forge.treeEntryAt(repo, commitView.tree, segments);
  if (entry === null) throw new ApiError(404, `${path} does not exist on ${branch}`);
  const newTree = forge.removeTreePath(repo, commitView.tree, segments);
  if (newTree === null) throw new ApiError(422, `deleting ${path} would empty the tree of ${branch}`);
  const commitSha = forge.commitOnto(repo, branch, newTree, tip, message);
  return { commitSha, blobOid: entry.oid };
}

function squashMerge(repo: Repo, pull: Pull): { ok: boolean; sha: string | null } {
  const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const head = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (base === undefined || head === undefined) return { ok: false, sha: null };
  const baseAncestors = forge.mergeBase(repo, base, head);
  const treeOf = (commit: string | null): string | null => (commit === null ? null : (forge.commitView(repo, commit)?.tree ?? null));
  const merged = forge.mergeTrees(repo, treeOf(baseAncestors), treeOf(base), treeOf(head));
  if (merged === null) return { ok: false, sha: null };
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const sha = forge.commitOnto(repo, pull.baseRef, merged, base, message);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.mergedAt = new Date(forge.tick().sec * 1000).toISOString();
  return { ok: true, sha };
}

function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams, body: Buffer): Promise<void> | void {
  if (!authorized(req)) return restError(res, 401, 'Requires authentication');

  // -- root + meta + user -------------------------------------------------
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return sendJson(res, 200, { installed_version: 'makefun-forge 1.0.0' });
  }
  if (method === 'GET' && path === '/api/v3/user') {
    return sendJson(res, 200, {
      login: forge.viewer.login,
      id: forge.viewer.id,
      node_id: `gid:user:${forge.viewer.id}`,
      name: forge.viewer.name,
      email: forge.viewer.email,
      type: 'User',
      created_at: new Date(0).toISOString(),
    });
  }

  // -- repositories --------------------------------------------------------
  if (path === '/api/v3/user/repos' && method === 'POST') {
    const input = parseJsonBody(body);
    const name = typeof input.name === 'string' ? input.name : '';
    const repo = forge.createRepo(name, typeof input.description === 'string' ? input.description : '', input.private === true);
    return sendJson(res, 201, repoJson(repo));
  }
  if (path === '/api/v3/user/repos' && method === 'GET') {
    const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
    const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
    const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage);
    const origin = originOf(req);
    const links: string[] = [];
    if (start + perPage < all.length) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    if (page > 1) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, page - 1)}>; rel="prev"`);
    links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
    if (all.length > 0) links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, Math.ceil(all.length / perPage))}>; rel="last"`);
    return sendJson(res, 200, items.map(repoJson), links.length > 0 ? { link: links.join(', ') } : {});
  }
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (repoMatch !== null) {
    const owner = decodeURIComponent(repoMatch[1] as string);
    const name = decodeURIComponent(repoMatch[2] as string);
    const sub = (repoMatch[3] ?? '').replace(/\/+$/, '');
    const segments = sub === '' ? [] : sub.split('/').map((segment) => decodeURIComponent(segment));

    // Repository CRUD (the sub path is empty)
    if (sub === '') {
      const repo = forge.getRepo(owner, name);
      if (repo === null || repo.owner !== forge.viewer.login) return restError(res, 404, 'Not Found');
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') {
        const input = parseJsonBody(body);
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.repos.delete(`${owner}/${name}`.toLowerCase());
        res.writeHead(204, { 'x-github-request-id': `req-${requestIdCounter++}` });
        res.end();
        return;
      }
    }

    if (segments.length > 0) {
      const head = segments[0] as string;
      const repo = forge.getRepo(owner, name);
      if (repo === null || repo.owner !== forge.viewer.login) return restError(res, 404, 'Not Found');

      // -- branches and refs -------------------------------------------------
      if (head === 'branches') {
        if (method === 'GET' && segments.length === 1) {
          const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
          return sendJson(res, 200, branches.map((ref) => {
            const branchName = ref.slice('refs/heads/'.length);
            return { name: branchName, commit: { sha: repo.refs.get(ref), url: `${repoUrl(repo)}/commits/${repo.refs.get(ref)}` }, protected: false };
          }));
        }
        if (method === 'GET' && segments.length === 2) {
          const branchName = segments[1] as string;
          const sha = branchSha(repo, branchName);
          if (sha === null) return restError(res, 404, 'branch not found');
          return sendJson(res, 200, { name: branchName, commit: { sha, commit: commitJson(repo, sha), url: `${repoUrl(repo)}/commits/${sha}` }, protected: false });
        }
      }
      if (head === 'git' && segments[1] === 'refs' && method === 'POST' && segments.length <= 3) {
        const input = parseJsonBody(body);
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return restError(res, 422, 'the ref must start with refs/heads/ or refs/tags/');
        if (!isObjectId(sha) || !repo.objects.has(sha)) return restError(res, 422, `the object ${sha} does not exist`);
        if (repo.refs.has(ref)) return restError(res, 422, 'reference already exists');
        repo.refs.set(ref, sha);
        repo.packCache.clear();
        return sendJson(res, 201, refJson(ref, sha));
      }
      if (head === 'git' && segments[1] === 'refs' && method === 'GET' && segments.length >= 4) {
        const refName = `refs/${segments.slice(2).join('/')}`;
        const sha = repo.refs.get(refName) ?? repo.refs.get(`refs/${segments.slice(2).join('/')}`);
        if (sha === undefined) return restError(res, 404, 'reference not found');
        return sendJson(res, 200, refJson(refName, sha));
      }
      if (head === 'git' && segments[1] === 'commits' && method === 'GET' && segments.length === 3) {
        const sha = segments[2] as string;
        if (!repo.objects.has(sha)) return restError(res, 404, 'commit not found');
        return sendJson(res, 200, commitJson(repo, sha));
      }
      if (head === 'commits' && method === 'GET') {
        const tip = resolveRefInput(repo, query.get('sha'));
        if (tip === null) return sendJson(res, 200, []);
        const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
        const walk: string[] = [];
        const seen = new Set<string>();
        let cursor: string | null = tip;
        while (cursor !== null && !seen.has(cursor) && walk.length < perPage) {
          seen.add(cursor);
          walk.push(cursor);
          cursor = forge.commitView(repo, cursor)?.parents[0] ?? null;
        }
        return sendJson(res, 200, walk.map((sha) => commitJson(repo, sha)));
      }

      // -- contents ------------------------------------------------------------
      if (head === 'contents') {
        const refParam = query.get('ref');
        const filePath = segments.slice(1).join('/');
        if (method === 'GET') {
          const tip = resolveRefInput(repo, refParam);
          if (tip === null) return restError(res, 404, 'no commits on this repository');
          const commitView = parseCommit(forge.getObject(repo, tip)?.data ?? Buffer.alloc(0));
          const segmentsPath = filePath.split('/').filter((segment) => segment !== '');
          if (segmentsPath.length === 0) {
            const entries = parseTree(forge.getObject(repo, commitView.tree)?.data ?? Buffer.alloc(0));
            return sendJson(res, 200, entries.map((entry) => entry.mode === '40000' ? treeJson(repo, entry.name, entry.oid, refParam ?? repo.defaultBranch) : fileJson(repo, entry.name, entry.oid, forge.getObject(repo, entry.oid)?.data ?? Buffer.alloc(0), refParam ?? repo.defaultBranch)));
          }
          const entry = forge.treeEntryAt(repo, commitView.tree, segmentsPath);
          if (entry === null) return restError(res, 404, `${filePath} does not exist`);
          if (entry.mode === '40000') {
            const entries = parseTree(forge.getObject(repo, entry.oid)?.data ?? Buffer.alloc(0));
            return sendJson(res, 200, entries.map((child) => child.mode === '40000' ? treeJson(repo, [...segmentsPath, child.name].join('/'), child.oid, refParam ?? repo.defaultBranch) : fileJson(repo, [...segmentsPath, child.name].join('/'), child.oid, forge.getObject(repo, child.oid)?.data ?? Buffer.alloc(0), refParam ?? repo.defaultBranch)));
          }
          const data = forge.getObject(repo, entry.oid)?.data ?? Buffer.alloc(0);
          return sendJson(res, 200, fileJson(repo, filePath, entry.oid, data, refParam ?? repo.defaultBranch));
        }
        if (method === 'PUT') {
          const input = parseJsonBody(body);
          const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Set ${filePath}`;
          const content = typeof input.content === 'string' ? input.content : '';
          const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
          const existingTip = branchSha(repo, branch);
          if (existingTip === null && branch !== repo.defaultBranch) return restError(res, 404, `branch ${branch} does not exist`);
          const segmentsPath = filePath.split('/').filter((segment) => segment !== '');
          const entry = existingTip === null ? null : forge.treeEntryAt(repo, parseCommit(forge.getObject(repo, existingTip)?.data ?? Buffer.alloc(0)).tree, segmentsPath);
          const replace = typeof input.sha === 'string' && input.sha !== '';
          if (replace) {
            if (entry === null) return restError(res, 409, `${filePath} does not exist on ${branch}`);
            if (entry.oid !== input.sha) return restError(res, 409, `${filePath} does not have the given sha (the file changed since you read it)`);
          } else if (entry !== null) {
            return restError(res, 422, `${filePath} already exists on ${branch} and a sha was not supplied`);
          }
          const written = commitFile(repo, branch, filePath, content, message);
          const status = replace ? 200 : 201;
          return sendJson(res, status, {
            content: fileJson(repo, filePath, written.blobOid, written.blobData, branch),
            commit: commitJson(repo, written.commitSha),
          });
        }
        if (method === 'DELETE') {
          const input = parseJsonBody(body);
          const message = typeof input.message === 'string' && input.message !== '' ? input.message : `Remove ${filePath}`;
          const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
          const tip = branchSha(repo, branch);
          if (tip === null) return restError(res, 404, `${filePath} does not exist on ${branch}`);
          const entry = forge.treeEntryAt(repo, parseCommit(forge.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree, filePath.split('/').filter((segment) => segment !== ''));
          if (entry === null) return restError(res, 404, `${filePath} does not exist on ${branch}`);
          if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== entry.oid) {
            return restError(res, 409, `${filePath} does not have the given sha (the file changed since you read it)`);
          }
          const removed = deleteFile(repo, branch, filePath, message);
          return sendJson(res, 200, {
            content: null,
            commit: commitJson(repo, removed.commitSha),
          });
        }
      }

      // -- labels ---------------------------------------------------------------
      if (head === 'labels') {
        if (method === 'POST' && segments.length === 1) {
          const input = parseJsonBody(body);
          const labelName = typeof input.name === 'string' ? input.name : '';
          if (labelName === '') return restError(res, 422, 'the label name is required');
          const color = typeof input.color === 'string' && input.color !== '' ? input.color : 'ededed';
          repo.labels.set(labelName, { name: labelName, color });
          return sendJson(res, 201, labelJson(repo, labelName));
        }
        if (method === 'GET' && segments.length === 1) {
          return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label.name)));
        }
        if (method === 'GET' && segments.length === 2) {
          const label = repo.labels.get(segments[1] as string);
          if (label === undefined) return restError(res, 404, 'label not found');
          return sendJson(res, 200, labelJson(repo, label.name));
        }
      }

      // -- issues -----------------------------------------------------------------
      if (head === 'issues') {
        if (method === 'POST' && segments.length === 1) {
          const input = parseJsonBody(body);
          const title = typeof input.title === 'string' ? input.title : '';
          const labels = Array.isArray(input.labels) ? input.labels.map((entry) => typeof entry === 'string' ? entry : String((entry as Record<string, unknown>)?.name ?? '')).filter((entry) => entry !== '') : [];
          const issue = forge.openIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
          return sendJson(res, 201, issueJson(repo, issue));
        }
        if (method === 'GET' && segments.length === 1) {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          if (sort === 'comments') list.sort((a, b) => a.comments.length - b.comments.length);
          else if (sort === 'updated') list.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
          else list.sort((a, b) => a.createdAtSec - b.createdAtSec);
          if (direction === 'desc') list.reverse();
          const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
          const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
          return sendJson(res, 200, list.slice((page - 1) * perPage, (page - 1) * perPage + perPage).map((issue) => issueJson(repo, issue)));
        }
        const issueNumber = Number(segments[1]);
        if (Number.isFinite(issueNumber) && segments.length >= 2) {
          const issue = repo.issues.find((candidate) => candidate.number === issueNumber);
          if (segments.length === 2) {
            if (issue === undefined) return restError(res, 404, 'issue not found');
            if (method === 'GET') return sendJsonText(res, 200, issueJsonText(repo, issue));
            if (method === 'PATCH') {
              const input = parseJsonBody(body);
              if (typeof input.title === 'string' && input.title !== '') issue.title = input.title;
              if (typeof input.body === 'string') issue.body = input.body;
              if (input.state === 'open' || input.state === 'closed') {
                if (issue.state !== input.state) {
                  issue.state = input.state;
                  issue.closedAt = input.state === 'closed' ? new Date(forge.tick().sec * 1000).toISOString() : null;
                }
              }
              issue.updatedAt = new Date(forge.tick().sec * 1000).toISOString();
              return sendJson(res, 200, issueJson(repo, issue));
            }
          }
          if (segments[2] === 'comments') {
            if (issue === undefined) return restError(res, 404, 'issue not found');
            if (method === 'GET') {
              return sendJson(res, 200, issue.comments.map(commentJson));
            }
            if (method === 'POST') {
              const input = parseJsonBody(body);
              const text = typeof input.body === 'string' ? input.body : '';
              if (text === '') return restError(res, 422, 'the comment body is required');
              const comment = forge.addComment(issue, text);
              return sendJson(res, 201, commentJson(comment));
            }
          }
        }
      }

      // -- pulls --------------------------------------------------------------------
      if (head === 'pulls') {
        if (method === 'POST' && segments.length === 1) {
          const input = parseJsonBody(body);
          const pull = forge.openPull(
            repo,
            typeof input.title === 'string' ? input.title : '',
            typeof input.body === 'string' ? input.body : '',
            typeof input.head === 'string' ? input.head : '',
            typeof input.base === 'string' ? input.base : '',
          );
          return sendJson(res, 201, pullJson(repo, pull, { headSha: branchSha(repo, pull.headRef) ?? ZERO_OID, baseSha: branchSha(repo, pull.baseRef) ?? ZERO_OID }));
        }
        if (method === 'GET' && segments.length === 1) {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.filter((pull) => state === 'all' || (state === 'open' ? pull.state === 'open' : pull.state === 'closed'));
          list = [...list].sort((a, b) => b.seq - a.seq);
          const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
          return sendJson(res, 200, list.slice(0, perPage).map((pull) => pullJson(repo, pull, { headSha: branchSha(repo, pull.headRef) ?? ZERO_OID, baseSha: branchSha(repo, pull.baseRef) ?? ZERO_OID })));
        }
        const pullNumber = Number(segments[1]);
        if (Number.isFinite(pullNumber) && segments.length >= 2) {
          const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
          if (segments.length === 2) {
            if (pull === undefined) return restError(res, 404, 'pull request not found');
            if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull, { headSha: branchSha(repo, pull.headRef) ?? ZERO_OID, baseSha: branchSha(repo, pull.baseRef) ?? ZERO_OID }));
          }
          if (segments[2] === 'files' && method === 'GET') {
            if (pull === undefined) return restError(res, 404, 'pull request not found');
            const head = branchSha(repo, pull.headRef);
            const base = branchSha(repo, pull.baseRef);
            const files = head === null ? [] : forge.diffTrees(repo, treeOfCommit(repo, base === null ? null : (forge.mergeBase(repo, base, head))), treeOfCommit(repo, head));
            return sendJson(res, 200, files.map((file) => ({
              sha: hashObject('blob', Buffer.from(file.filename)),
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              blob_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${pull.baseRef}/${file.filename}`,
              raw_url: `https://forge.invalid/${repo.owner}/${repo.name}/raw/${pull.baseRef}/${file.filename}`,
            })));
          }
          if (segments[2] === 'merge' && method === 'PUT') {
            if (pull === undefined) return restError(res, 404, 'pull request not found');
            const input = parseJsonBody(body);
            if (pull.merged) return restError(res, 405, `pull request ${pull.number} is already merged`);
            const result = squashMerge(repo, pull);
            if (!result.ok || result.sha === null) {
              return restError(res, 405, `pull request ${pull.number} has conflicts with ${pull.baseRef}`);
            }
            return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
          }
        }
      }
    }
  }

  return restError(res, 404, 'Not Found');
}

function treeOfCommit(repo: Repo, commit: string | null): string | null {
  if (commit === null) return null;
  return forge.commitView(repo, commit)?.tree ?? null;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'forge.invalid';
  return `http://${host}`;
}

function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new ApiError(400, 'the request body must be a JSON object');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'the request body is not valid JSON');
  }
}

// ---------------------------------------------------------------- git smart HTTP

interface GitRoute {
  readonly owner: string;
  readonly repo: string;
  readonly service: 'git-upload-pack' | 'git-receive-pack' | null;
}

/** Parse /{owner}/{repo}.git[/info/refs|/git-upload-pack|/git-receive-pack]; null when it is not one. */
function gitRoute(path: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+?)\.git(?:\/(info\/refs|git-upload-pack|git-receive-pack))?$/.exec(path);
  if (match === null) return null;
  return {
    owner: decodeURIComponent(match[1] as string),
    repo: decodeURIComponent(match[2] as string),
    service: match[3] === undefined ? null : (match[3] === 'info/refs' ? null : (match[3] as 'git-upload-pack' | 'git-receive-pack')),
  };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const route = gitRoute(path);
  if (route === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = forge.getRepo(route.owner, route.repo);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const gitProtocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = String(gitProtocol).includes('version=2');

  try {
    // GET info/refs: the capability advertisement.
    if (route.service === null) {
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'the info/refs request needs a service parameter' });
        return;
      }
      const advertisement = service === 'git-upload-pack' && wantsV2
        ? v2Advertisement()
        : v0Advertisement(forge, repo, service);
      res.writeHead(200, {
        'content-type': `application/x-${service}-advertisement`,
        'cache-control': 'no-cache',
        'content-length': advertisement.length,
      });
      res.end(advertisement);
      return;
    }

    // POST git-upload-pack: v2 (command request) or v0 (want/have/done).
    if (route.service === 'git-upload-pack') {
      if (wantsV2) {
        const packets = decodePktLines(body);
        const args = new Map<string, string[]>();
        let command = '';
        let inCommandSection = true;
        for (const packet of packets) {
          if (packet.kind === 'delim') {
            inCommandSection = false;
            continue;
          }
          if (packet.kind === 'flush' || packet.kind === 'data') {
            if (packet.kind !== 'data') continue;
            const text = packet.payload.toString('utf8').replace(/\n$/, '');
            if (inCommandSection && text.startsWith('command=')) {
              command = text.slice('command='.length);
              continue;
            }
            if (inCommandSection && text.startsWith('object-format=')) continue;
            if (inCommandSection && text.startsWith('agent=')) continue;
            inCommandSection = false;
            const space = text.indexOf(' ');
            const key = space < 0 ? text : text.slice(0, space);
            const value = space < 0 ? '' : text.slice(space + 1);
            const list = args.get(key);
            if (list === undefined) args.set(key, [value]);
            else list.push(value);
          }
        }
        if (command === 'ls-refs') {
          const reply = lsRefs(forge, repo, args);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
          res.end(reply);
          return;
        }
        if (command === 'fetch') {
          const wants: string[] = args.get('want') ?? [];
          const haves: string[] = args.get('have') ?? [];
          const shallow: string[] = args.get('shallow') ?? [];
          const deepen = args.get('deepen');
          let depth: number | null = deepen === undefined ? null : Number(deepen[deepen.length - 1]);
          const done = args.has('done');
          if (args.has('deepen-since') || args.has('deepen-not')) depth = null;
          if (wants.length === 0) {
            const reply = Buffer.concat([pkt('packfile\n'), FLUSH]);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
            res.end(reply);
            return;
          }
          if (!done) {
            const reply = Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), DELIM, FLUSH]);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
            res.end(reply);
            return;
          }
          const reply = v2Fetch(forge, repo, wants, haves, depth, shallow);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
          res.end(reply);
          return;
        }
        sendJson(res, 400, { message: `unknown upload-pack v2 command ${command || '(none)'}` });
        return;
      }

      // v0 fetch
      const packets = decodePktLines(body);
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      let section = 'wants';
      for (const packet of packets) {
        if (packet.kind === 'flush') {
          section = 'haves';
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8').replace(/\n$/, '');
        const space = text.indexOf(' ');
        const key = space < 0 ? text : text.slice(0, space);
        const rest = space < 0 ? '' : text.slice(space + 1);
        if (key === 'want') wants.push(rest.split(' ')[0] as string);
        else if (key === 'have') haves.push(rest.split(' ')[0] as string);
        else if (key === 'shallow') shallow.push(rest);
        else if (key === 'deepen') depth = Number(rest);
        else if (key === 'done') section = 'done';
      }
      if (wants.length === 0) {
        sendJson(res, 400, { message: 'the fetch has no wants' });
        return;
      }
      const reply = v0Fetch(forge, repo, wants, haves, depth, shallow);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
      res.end(reply);
      return;
    }

    // POST git-receive-pack
    if (route.service === 'git-receive-pack') {
      const parsed = parseReceiveRequest(body);
      const sideband = parsed.capabilities.has('side-band-64k');
      const applied = applyReceiveCommands(forge, repo, parsed);
      const reply = receiveReport(applied.report, applied.unpackOk, sideband);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': reply.length });
      res.end(reply);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------- GraphQL + MCP

async function handleGraphql(res: ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.length === 0 ? 'null' : body.toString('utf8'));
  } catch {
    parsed = null;
  }
  const outcome = graphqlHandler(forge, parsed ?? { query: '' });
  sendJson(res, outcome.status, outcome.body);
}

function handleMcp(res: ServerResponse, raw: string, parsed: unknown): void {
  const outcome = mcpHandler(forge, raw, parsed);
  if (outcome.status === 202) {
    res.writeHead(202, { 'x-github-request-id': `req-${requestIdCounter++}` });
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.body);
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err: unknown) => {
      try {
        const status = err instanceof ApiError ? err.status : 500;
        sendJson(res, status, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        res.destroy();
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // git smart HTTP first: /{owner}/{repo}.git[...]
  const git = gitRoute(path);
  if (git !== null) {
    await handleGit(req, res, path, queryOf(req));
    return;
  }

  // GraphQL and MCP read bodies themselves.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    await handleGraphql(res, body);
    return;
  }
  if (path === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    handleMcp(res, raw, parsed);
    return;
  }

  // REST: buffer the body once, then dispatch.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = await readBody(req);
    try {
      await handleRest(req, res, method, path, queryOf(req), body);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      sendJson(res, status, { message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
