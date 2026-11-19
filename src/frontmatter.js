/**
 * Minimal YAML-frontmatter reader/writer for the flat metadata used by skills,
 * agents and memory entries (scalars and inline lists). No dependency needed.
 */

export function parseFrontmatter(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // Folded/literal blocks (description: >- ...) used by some skills.
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = value.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
    } else if (value === '' && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
      const list = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) list.push(unquote(lines[++i].replace(/^\s+-\s+/, '')));
      meta[kv[1]] = list;
      continue;
    }
    meta[kv[1]] = parseScalar(value);
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function parseScalar(value) {
  if (/^\[.*\]$/.test(value)) {
    return value.slice(1, -1).split(',').map(unquote).filter(Boolean);
  }
  return unquote(value);
}

function formatScalar(v) {
  const s = String(v);
  return /^[\w./@ -]*$/.test(s) && !/^[\s-]|:\s|\s$/.test(s) && s !== '' ? s : JSON.stringify(s);
}

/** @param {Record<string, string|string[]|undefined|null>} meta */
export function stringifyFrontmatter(meta, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}: [${value.map(formatScalar).join(', ')}]`);
    } else lines.push(`${key}: ${formatScalar(value)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body.trim()}\n`;
}
