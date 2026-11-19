/**
 * Just enough TOML for Codex agent files: top-level string keys only
 * (basic, literal and their multi-line forms). Tables and other types are ignored.
 */
export function parseTomlStrings(text) {
  const out = {};
  let i = 0;
  const src = text.replace(/\r\n/g, '\n');
  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, lineEnd);
    if (/^\s*\[/.test(line)) break; // first table: stop, only top-level keys matter
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*/);
    if (!m) {
      i = lineEnd + 1;
      continue;
    }
    const key = m[1];
    let j = i + m[0].length;
    const rest = src.slice(j);
    let value;
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      const q = rest.slice(0, 3);
      const end = src.indexOf(q, j + 3);
      if (end === -1) break;
      value = src.slice(j + 3, end).replace(/^\n/, '');
      if (q === '"""') value = unescapeBasic(value.replace(/\\\n\s*/g, ''));
      j = end + 3;
    } else if (rest.startsWith('"')) {
      const mm = rest.match(/^"((?:[^"\\\n]|\\.)*)"/);
      value = mm ? unescapeBasic(mm[1]) : undefined;
      j += mm ? mm[0].length : 0;
    } else if (rest.startsWith("'")) {
      const mm = rest.match(/^'([^'\n]*)'/);
      value = mm?.[1];
      j += mm ? mm[0].length : 0;
    }
    if (value !== undefined) out[key] = value;
    const next = src.indexOf('\n', j);
    i = next === -1 ? src.length : next + 1;
  }
  return out;
}

function unescapeBasic(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[e] ?? e;
  });
}

export function tomlString(s) {
  return JSON.stringify(String(s)); // JSON escapes are valid TOML basic-string escapes
}

/** Multi-line value: literal ''' when possible so backslashes in prompts survive untouched. */
export function tomlMultiline(s) {
  const body = String(s).trim();
  if (!body.includes("'''") && !body.endsWith("'")) return `'''\n${body}\n'''`;
  return `"""\n${body.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')}\n"""`;
}
