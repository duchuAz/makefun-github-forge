// The git smart-HTTP server: pkt-line framing, pack reading and writing, and the two services —
// upload-pack (v2 and v0, side-band-64k, shallow depth negotiation) and receive-pack (report-status,
// side-band-64k, delete-refs, fast-forward enforcement).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Forge, type Repo, type GitObjectType, hashObject, parseCommit, parseTree } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** A pkt-line's on-the-wire length (the 4-byte prefix + payload) tops out at 65520. */
const MAX_TOTAL = 65520;
const MAX_PAYLOAD = MAX_TOTAL - 4;

// ---------------------------------------------------------------- pkt-line codec

/** Encode one pkt-line: a 4-byte hex length prefix (payload + 4) then the payload. */
export function pkt(payload: string | Uint8Array): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (bytes.length > MAX_PAYLOAD) throw new Error(`pkt-line payload of ${bytes.length} bytes is too long`);
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0'), 'ascii'), bytes]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktLine {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a full pkt-line stream into packets (throws on a short or malformed frame). */
export function decodePktLines(input: Uint8Array): PktLine[] {
  const view = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (view.length % 1 !== 0) throw new Error('bad view');
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < view.length) {
    if (view.length - offset < 4) throw new Error('truncated pkt-line length prefix');
    const hex = view.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`invalid pkt-line length prefix ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > MAX_TOTAL) throw new Error(`pkt-line length ${length} is out of range`);
    if (view.length - offset < length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: view.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** One side-band-64k frame: band byte + payload, pkt-line wrapped. */
function sideband(band: number, chunk: Uint8Array): Buffer {
  const body = Buffer.alloc(chunk.length + 1);
  body[0] = band;
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(body, 1);
  return pkt(body);
}

/** Split a byte stream into sideband band-1 chunks (band byte + payload fits one pkt-line). */
function sidebandStream(data: Uint8Array): Buffer {
  const source = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const parts: Buffer[] = [];
  const chunkSize = MAX_PAYLOAD - 1;
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    parts.push(sideband(1, source.subarray(offset, Math.min(source.length, offset + chunkSize))));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- zlib stream boundary

interface Inflated {
  data: Buffer;
  consumed: number;
}

/**
 * Inflate one zlib stream that starts at `start` and report how many bytes it consumed. With
 * `{ info: true }` inflateSync exposes the engine's byte count, which stops exactly at the stream's
 * adler-32 trailer; anything after it (the next entry, the pack trailer) is ignored.
 */
function inflateAt(view: Buffer, start: number): Inflated {
  const result = inflateSync(view.subarray(start), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`the zlib stream at ${start} consumed no bytes`);
  return { data: result.buffer, consumed };
}

// ---------------------------------------------------------------- pack reading

export interface PackEntry {
  readonly type: GitObjectType | 'ofs_delta' | 'ref_delta';
  readonly data: Buffer;
  /** The entry's start offset in the pack (delta bases may point here). */
  readonly offset: number;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

export interface ReadPackResult {
  entries: PackEntry[];
  trailerOk: boolean;
  objectCount: number;
}

/** Parse a packfile v2 (objects may be deltas; the caller resolves them). */
export function readPack(pack: Uint8Array): ReadPackResult {
  const trace = process.env.DEBUG_PACK === '1';
  const view = Buffer.isBuffer(pack) ? pack : Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.length < 32) throw new Error('pack is shorter than its header and trailer');
  if (view.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = view.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = view.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  const objectEnd = view.length - 20;
  for (let index = 0; index < count; index += 1) {
    if (offset >= objectEnd) throw new Error('pack truncated inside its objects');
    const entryStart = offset;
    const first = view[offset] as number;
    const typeBits = (first >> 4) & 7;
    let size = first & 15;
    let cursor = offset + 1;
    if ((first & 0x80) !== 0) {
      // the header continues: every size byte contributes 7 bits, the one without the MSB is last
      let shift = 4;
      for (;;) {
        if (cursor >= objectEnd) throw new Error('pack truncated inside an object header');
        const byte = view[cursor] as number;
        cursor += 1;
        size += (byte & 0x7f) << shift;
        shift += 7;
        if ((byte & 0x80) === 0) break;
      }
    }
    if (typeBits === 0 || typeBits === 5) throw new Error(`invalid pack object type ${typeBits}`);
    let type: GitObjectType | 'ofs_delta' | 'ref_delta';
    if (typeBits === 1) type = 'commit';
    else if (typeBits === 2) type = 'tree';
    else if (typeBits === 3) type = 'blob';
    else if (typeBits === 4) type = 'tag';
    else if (typeBits === 6) {
      let value = view[cursor] as number;
      cursor += 1;
      while ((value & 0x80) !== 0) {
        value = ((value & 0x7f) << 7) | (view[cursor] as number);
        cursor += 1;
      }
      type = 'ofs_delta';
      if (trace) console.error(`[pack] entry ${index} off=${entryStart} OFS_DELTA base=${value} cursor=${cursor} head=${view.subarray(cursor, cursor + 4).toString('hex')}`);
      const inflated = inflateAt(view, cursor);
      entries.push({ type, data: inflated.data, offset: entryStart, baseOffset: value });
      offset = cursor + inflated.consumed;
      continue;
    } else {
      const baseOid = view.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
      type = 'ref_delta';
      if (trace) console.error(`[pack] entry ${index} off=${entryStart} REF_DELTA base=${baseOid} cursor=${cursor} head=${view.subarray(cursor, cursor + 4).toString('hex')}`);
      const inflated = inflateAt(view, cursor);
      entries.push({ type, data: inflated.data, offset: entryStart, baseOid });
      offset = cursor + inflated.consumed;
      continue;
    }
    const inflated = inflateAt(view, cursor);
    if (trace) console.error(`[pack] entry ${index} off=${entryStart} type=${type} size=${size} cursor=${cursor} consumed=${inflated.consumed}`);
    if (inflated.data.length !== size) throw new Error(`object inflates to ${inflated.data.length} bytes, header says ${size}`);
    entries.push({ type, data: inflated.data, offset: entryStart });
    offset = cursor + inflated.consumed;
  }
  const running = createHash('sha1');
  running.update(view.subarray(0, objectEnd));
  const expected = running.digest('hex');
  const stored = view.subarray(objectEnd).toString('hex');
  return { entries, trailerOk: expected === stored, objectCount: count };
}

// ---------------------------------------------------------------- pack writing

/** Build a packfile v2 holding `objects`, non-delta, with a valid SHA-1 trailer. */
export function writePack(objects: ReadonlyArray<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const head: number[] = [((typeBits(object.type) << 4) | (size & 15)) & 0xff];
    let rest = size >> 4;
    while (rest > 0) {
      head[head.length - 1] = (head[head.length - 1] as number) | 0x80;
      head.push(rest & 0x7f);
      rest >>= 7;
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const running = createHash('sha1');
  const body = Buffer.concat(parts);
  running.update(body);
  return Buffer.concat([body, running.digest()]);
}

function typeBits(type: GitObjectType): number {
  if (type === 'commit') return 1;
  if (type === 'tree') return 2;
  if (type === 'blob') return 3;
  return 4;
}

// ---------------------------------------------------------------- object selection

export interface Selection {
  readonly objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>;
  readonly shallows: string[];
  readonly unshallows: string[];
}

/**
 * Choose the objects a fetch needs: everything reachable from `wants` that the client does not
 * already hold (reachable from its `haves`), honouring a depth cut. Cut commits are reported as
 * shallow; a client-shallow commit whose parents are now all included is reported as unshallowed.
 */
export function selectObjects(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): Selection {
  const haveSet = new Set(haves.filter((oid) => repo.objects.has(oid)));
  const haveReachable = forge.ancestorCommits(repo, [...haveSet]);
  // The objects the client already holds: the haves' commits, trees and blobs, so a fetch never
  // re-sends a tree or blob the new commit shares with the old tip.
  const held = new Set<string>();
  const collectHeld = (oid: string): void => {
    if (held.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    held.add(oid);
    if (object.type === 'commit') collectHeld(parseCommit(object.data).tree);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) collectHeld(entry.oid);
  };
  for (const oid of haveSet) collectHeld(oid);
  const clientShallowSet = new Set(clientShallow);
  const walk: Array<{ oid: string; level: number }> = [];
  const seenCommits = new Set<string>();
  const keptTags = new Set<string>();
  for (const want of wants) {
    if (!repo.objects.has(want)) continue;
    const root = forge.peelToCommit(repo, want) ?? want;
    if (root !== want) keptTags.add(want);
    if (!repo.objects.has(root)) continue;
    if ((depth === null && haveReachable.has(root)) || seenCommits.has(root)) continue;
    walk.push({ oid: root, level: 1 });
    seenCommits.add(root);
  }
  const keep = new Set<string>(keptTags);
  const boundary = new Set<string>();
  const unshallowed = new Set<string>();
  while (walk.length > 0) {
    const node = walk.pop() as { oid: string; level: number };
    const view = forge.commitView(repo, node.oid);
    if (view === null) continue;
    keep.add(node.oid);
    if (depth !== null && node.level >= depth) {
      boundary.add(node.oid);
      continue;
    }
    if (clientShallowSet.has(node.oid)) unshallowed.add(node.oid);
    for (const parent of view.parents) {
      if (seenCommits.has(parent) || (depth === null && haveReachable.has(parent)) || !repo.objects.has(parent)) continue;
      seenCommits.add(parent);
      walk.push({ oid: parent, level: node.level + 1 });
    }
  }
  const referenced = new Set<string>();
  const collect = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    if (object.type === 'commit') {
      collect(parseCommit(object.data).tree);
      return;
    }
    if (object.type === 'tree') {
      if (referenced.has(oid)) return;
      referenced.add(oid);
      for (const entry of parseTree(object.data)) collect(entry.oid);
      return;
    }
    referenced.add(oid);
  };
  for (const oid of keep) collect(oid);
  const objects: Array<{ oid: string; type: GitObjectType; data: Buffer }> = [];
  const push = (oid: string): void => {
    if (held.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    objects.push({ oid, type: object.type, data: object.data });
  };
  for (const oid of keep) push(oid);
  for (const oid of referenced) push(oid);
  const shallows = [...boundary].filter((oid) => !clientShallowSet.has(oid));
  return { objects, shallows, unshallows: [...unshallowed] };
}

/** Build (and memoize) the pack bytes plus shallow metadata for a fetch. */
export function buildPack(forge: Forge, repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, clientShallow: readonly string[]): { pack: Buffer; shallows: string[]; unshallows: string[] } {
  const key = [String(repo.refsGen), wants.join(','), haves.join(','), depth === null ? '' : String(depth), clientShallow.join(',')].join('|');
  const hit = repo.packCache.get(key);
  if (hit !== undefined) return hit;
  const selection = selectObjects(forge, repo, wants, haves, depth, clientShallow);
  const entry = { pack: writePack(selection.objects), shallows: selection.shallows, unshallows: selection.unshallows };
  if (repo.packCache.size > 8) repo.packCache.clear();
  repo.packCache.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------- ref advertisement

const UPLOAD_PACK_CAPS = 'multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=makefun-forge/1.0';
const RECEIVE_PACK_CAPS = 'report-status report-status-v2 side-band-64k quiet delete-refs atomic ofs-delta agent=makefun-forge/1.0';

export interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** Sorted refs of a repo: HEAD first (when born), heads, then tags with peeled lines. */
export function advertisedRefs(forge: Forge, repo: Repo): AdvertisedRef[] {
  const heads: AdvertisedRef[] = [];
  const tags: AdvertisedRef[] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) heads.push({ name: ref, oid });
    else if (ref.startsWith('refs/tags/')) {
      const peeled = forge.peelToCommit(repo, oid);
      tags.push({ name: ref, oid, peeled: peeled !== null && peeled !== oid ? peeled : undefined });
    }
  }
  heads.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  tags.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: AdvertisedRef[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid !== undefined) out.push({ name: 'HEAD', oid: headOid });
  out.push(...heads, ...tags);
  return out;
}

/** The v0 advertisement (upload-pack or receive-pack per `service`). */
export function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
  const refs = advertisedRefs(forge, repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`), FLUSH);
    return Buffer.concat(parts);
  }
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index] as AdvertisedRef;
    const line = index === 0 ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pkt(line));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack (constant: built once). */
const V2_ADVERTISEMENT = Buffer.concat([
  pkt('# service=git-upload-pack\n'),
  FLUSH,
  pkt('version 2\n'),
  pkt('agent=makefun-forge/1.0\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

/** The v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The v2 ls-refs response. */
export function lsRefs(forge: Forge, repo: Repo, args: ReadonlyMap<string, readonly string[]>): Buffer {
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const prefixes: string[] = [];
  for (const [key, values] of args) if (key === 'ref-prefix') prefixes.push(...values);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid === undefined) {
    if (wantUnborn && matches('HEAD')) {
      parts.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  } else if (matches('HEAD')) {
    parts.push(pkt(`${headOid} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (ref.name === 'HEAD' || !matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 fetch response. */
export function v2Fetch(forge: Forge, repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, clientShallow: readonly string[]): Buffer {
  const { pack, shallows, unshallows } = buildPack(forge, repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  if (shallows.length > 0 || unshallows.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallows) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallows) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandStream(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch response: shallow/unshallow lines, NAK, then the sideband pack. */
export function v0Fetch(forge: Forge, repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, clientShallow: readonly string[]): Buffer {
  const { pack, shallows, unshallows } = buildPack(forge, repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  for (const oid of shallows) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallows) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(sidebandStream(pack));
  return Buffer.concat(parts);
}

/**
 * The fully framed fetch reply for one request, cached. Two identical requests (the clone workload's
 * 50 concurrent depth-1 clones, or a client retrying) share one Buffer instead of re-framing the
 * pack. Content depends only on the requested object ids, depth and boundaries plus the repo's
 * objects (append-only), so a cache hit can never be stale; ref updates still clear it.
 */
export function cachedFetchReply(forge: Forge, repo: Repo, protocol: 'v0' | 'v2', wants: readonly string[], haves: readonly string[], depth: number | null, clientShallow: readonly string[]): Buffer {
  const key = `${protocol}|${wants.join(',')}|${haves.join(',')}|${depth === null ? '' : depth}|${clientShallow.join(',')}`;
  const hit = repo.replyCache.get(key);
  if (hit !== undefined) return hit;
  const reply = protocol === 'v2'
    ? v2Fetch(forge, repo, wants, haves, depth, clientShallow)
    : v0Fetch(forge, repo, wants, haves, depth, clientShallow);
  if (repo.replyCache.size > 16) repo.replyCache.clear();
  repo.replyCache.set(key, reply);
  return reply;
}

/** The refs a v0 advertisement depends on, as one cheap signature string. */
function refsSignature(repo: Repo): string {
  let signature = repo.defaultBranch;
  for (const [name, oid] of repo.refs) signature += `\u0000${name}\u0001${oid}`;
  return signature;
}

/** The v0 advertisement, cached while the repository's refs (the only thing it reads) are unchanged. */
export function cachedV0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const key = `adv|${service}|${refsSignature(repo)}`;
  const hit = repo.replyCache.get(key);
  if (hit !== undefined) return hit;
  const reply = v0Advertisement(forge, repo, service);
  if (repo.replyCache.size > 16) repo.replyCache.clear();
  repo.replyCache.set(key, reply);
  return reply;
}

// ---------------------------------------------------------------- receive-pack
export interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ParsedReceiveRequest {
  commands: ReceiveCommand[];
  capabilities: ReadonlySet<string>;
  pack: Uint8Array | null;
}

/** Parse a receive-pack request body: pkt-line commands up to the flush, then the raw packfile. */
export function parseReceiveRequest(body: Uint8Array): ParsedReceiveRequest {
  const view = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const commands: ReceiveCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= view.length) {
    const hex = view.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`invalid pkt-line length prefix ${JSON.stringify(hex)}`);
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > MAX_TOTAL) throw new Error(`pkt-line length ${length} is out of range`);
    if (view.length - offset < length) throw new Error('truncated pkt-line payload');
    const text = view.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = text.indexOf('\u0000');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) for (const cap of text.slice(nul + 1).trim().split(' ')) if (cap) capabilities.add(cap);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(head);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (!sawFlush && commands.length === 0) throw new Error('receive-pack request has no commands and no flush');
  const pack = view.length > offset ? view.subarray(offset) : null;
  return { commands, capabilities, pack };
}

export interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Apply receive-pack commands to the repo. Returns the per-ref report in command order. */
export function applyReceiveCommands(forge: Forge, repo: Repo, parsed: ParsedReceiveRequest): { report: RefReport[]; unpackOk: boolean } {
  let unpackOk = true;
  if (parsed.pack !== null && parsed.pack.length > 0) {
    try {
      const result = readPack(parsed.pack);
      if (!result.trailerOk) {
        unpackOk = false;
      } else {
        indexPack(forge, repo, result);
      }
    } catch {
      unpackOk = false;
    }
    if (!unpackOk) {
      return {
        report: parsed.commands.map((command) => ({ ref: command.ref, ok: false, reason: 'n/a (unpacker error)' })),
        unpackOk,
      };
    }
  }
  const report: RefReport[] = [];
  let refsChanged = false;
  for (const command of parsed.commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      if (current === null || command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'failed to delete' });
        continue;
      }
      repo.refs.delete(command.ref);
      refsChanged = true;
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    if (current === null) {
      if (command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'failed to update ref' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      refsChanged = true;
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'fetch first' });
      continue;
    }
    if (!forge.isAncestor(repo, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
    report.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (refsChanged) {
    repo.refsGen += 1;
    if (repo.packCache.size > 0) repo.packCache.clear();
    if (repo.replyCache.size > 0) repo.replyCache.clear();
  }
  return { report, unpackOk };
}

/** Index a parsed pack into the repo's object store, resolving deltas against earlier entries. */
function indexPack(forge: Forge, repo: Repo, result: ReadPackResult): void {
  let hasDelta = false;
  for (const entry of result.entries) {
    if (entry.type === 'ofs_delta' || entry.type === 'ref_delta') {
      hasDelta = true;
      break;
    }
  }
  // The common push carries only whole objects: index them without building the delta maps.
  if (!hasDelta) {
    for (const entry of result.entries) {
      const oid = hashObject(entry.type as GitObjectType, entry.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type as GitObjectType, data: entry.data });
    }
    return;
  }
  const byOffset = new Map<number, PackEntry>();
  const resolved = new Map<number, string>();
  for (const entry of result.entries) byOffset.set(entry.offset, entry);
  const pending = result.entries.filter((entry) => entry.type === 'ofs_delta' || entry.type === 'ref_delta');
  for (const entry of result.entries) {
    if (entry.type === 'ofs_delta' || entry.type === 'ref_delta') continue;
    const oid = hashObject(entry.type, entry.data);
    resolved.set(entry.offset, oid);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type, data: entry.data });
  }
  for (let round = 0; round < 64 && pending.length > 0; round += 1) {
    const still: PackEntry[] = [];
    for (const entry of pending) {
      let baseOid: string | null = null;
      let baseType: GitObjectType | null = null;
      let baseData: Buffer | null = null;
      if (entry.type === 'ofs_delta') {
        const baseOidAt = resolved.get(entry.baseOffset as number);
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseOidAt !== undefined) {
          baseOid = baseOidAt;
          const object = repo.objects.get(baseOid);
          if (object !== undefined) {
            baseType = object.type;
            baseData = object.data;
          }
        } else if (baseEntry !== undefined && baseEntry.type !== 'ofs_delta' && baseEntry.type !== 'ref_delta') {
          baseType = baseEntry.type;
          baseData = baseEntry.data;
        }
      } else {
        const object = repo.objects.get(entry.baseOid as string);
        if (object !== undefined) {
          baseOid = entry.baseOid as string;
          baseType = object.type;
          baseData = object.data;
        }
      }
      if (baseType === null || baseData === null) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(baseData, entry.data);
      const oid = baseOid ?? hashObject(baseType, data);
      resolved.set(entry.offset, oid);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: baseType, data });
    }
    if (still.length === pending.length) break;
    pending.length = 0;
    pending.push(...still);
  }
  void forge;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Uint8Array): Buffer {
  const view = Buffer.isBuffer(delta) ? delta : Buffer.from(delta.buffer, delta.byteOffset, delta.byteLength);
  let offset = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = view[offset] as number;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  const baseSize = varint();
  const resultSize = varint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match base of ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < view.length) {
    const op = view[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= (view[offset++] as number) << 0;
      if (op & 0x02) copyOffset |= (view[offset++] as number) << 8;
      if (op & 0x04) copyOffset |= (view[offset++] as number) << 16;
      if (op & 0x08) copyOffset |= (view[offset++] as number) << 24;
      if (op & 0x10) copySize |= (view[offset++] as number) << 0;
      if (op & 0x20) copySize |= (view[offset++] as number) << 8;
      if (op & 0x40) copySize |= (view[offset++] as number) << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(Buffer.from(base.subarray(copyOffset, copyOffset + copySize)));
      produced += copySize;
    } else {
      const length = op & 0x7f;
      if (length === 0) throw new Error('delta insert of length 0');
      out.push(Buffer.from(view.subarray(offset, offset + length)));
      produced += length;
      offset += length;
    }
  }
  if (produced !== resultSize) throw new Error(`delta produced ${produced} bytes, expected ${resultSize}`);
  return Buffer.concat(out);
}

/** The report-status stream for a receive-pack push, sideband-framed when the client asked. */
export function receiveReport(report: ReadonlyArray<RefReport>, unpackOk: boolean, sideband: boolean): Buffer {
  const lines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n'];
  for (const entry of report) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const body = Buffer.concat(lines.map((line) => pkt(line)));
  if (!sideband) return Buffer.concat([body, FLUSH]);
  return Buffer.concat([sidebandStream(body), FLUSH]);
}
