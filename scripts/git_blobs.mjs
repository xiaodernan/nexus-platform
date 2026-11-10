#!/usr/bin/env node
/**
 * NEXUS D891 — one implementation of batched git blob reads for the citation readers.
 *
 * D888 (check_citation_supports_sentence.mjs) and D890 (check_line_cite_drift.mjs) each wrote their
 * own `git cat-file --batch` record parser. Two copies of a byte-offset walker is exactly the kind
 * of divergence that looks green until somebody fixes only one of them. This module owns:
 *
 *   headTree(repo)             the HEAD blob tree, parsed from the NUL-delimited ls-tree output
 *   catFileBatch(repo, exprs)  ONE child process for a list of object expressions (a blob sha, or
 *                              a `rev:path` spelling), returning raw Buffers
 *
 * THE CONTRACT, stated so a caller does not grow a third parser. `catFileBatch` returns a Map keyed
 * by the request string. A value is a Buffer of the object's bytes, or null when git reported the
 * object missing. A request the parser did NOT reach is ABSENT from the map, which is different
 * from missing: the caller must fall back to its own slow path instead of concluding that the
 * object does not exist. Header lines, payload sizes and the one newline after each record are
 * parsed here and nowhere else.
 *
 * WHAT THIS DOES NOT DO. No caching policy (callers own their caches), no eol normalisation, no
 * text decoding: a Buffer out, so both readers keep their exact stdout. `stdio` keeps stdin as a
 * pipe because the request list IS the payload — the `ignore` + `input` combination that silently
 * delivers nothing on node is the defect DECISIONS §253 censused. Nothing here writes to the tree.
 */
import { execFileSync } from 'node:child_process';

/**
 * Map<path, blobSha> for every blob at HEAD. `ls-tree -r -z` is used rather than a newline split
 * so a path containing a newline cannot masquerade as two records. An unreadable tree returns an
 * empty map: every lookup then stays unresolved rather than guessed at.
 */
export function headTree(repo) {
  const map = new Map();
  let raw;
  try {
    raw = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
      cwd: repo, maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return map; }
  let off = 0;
  while (off < raw.length) {
    const nul = raw.indexOf(0, off);
    const end = nul < 0 ? raw.length : nul;
    const rec = raw.subarray(off, end).toString('utf8');
    if (rec) {
      const tab = rec.indexOf('\t');
      if (tab >= 0) {
        const meta = rec.slice(0, tab).split(' ');
        if (meta.length >= 3 && meta[1] === 'blob') map.set(rec.slice(tab + 1), meta[2]);
      }
    }
    if (nul < 0) break;
    off = nul + 1;
  }
  return map;
}

/**
 * Read every requested object through ONE `git cat-file --batch`. Missing objects are recorded as
 * null; a truncated or unparseable stream simply stops adding records, leaving the tail absent so
 * callers can fall back. A failed child returns an empty map rather than a verdict.
 */
export function catFileBatch(repo, requests) {
  const out = new Map();
  if (!requests.length) return out;
  let buf;
  try {
    buf = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repo, input: `${requests.join('\n')}\n`, maxBuffer: 1 << 28,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { return out; }
  let off = 0;
  for (const req of requests) {
    const nl = buf.indexOf(10, off);
    if (nl < 0) break;
    const header = buf.subarray(off, nl).toString('utf8');
    off = nl + 1;
    if (header.endsWith(' missing')) { out.set(req, null); continue; }
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size) || size < 0 || off + size > buf.length) break;
    out.set(req, buf.subarray(off, off + size));
    off += size + 1; // every --batch record ends with one newline after the payload
  }
  return out;
}
