// Independent test reader: handles quoted/unquoted fields, doubled quotes,
// embedded CR/LF and an optional final record terminator. No formatter imports.
export function parseCsv(text) {
  const records = [];
  let row = []; let field = ''; let quoted = false; let closed = false; let started = false;
  const endField = () => { row.push(field); field = ''; closed = false; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[++i] !== '\n') throw new Error('Bare CR outside a field');
      endField(); records.push(row); row = [];
    } else if (c === '"' && !started && !closed) { quoted = true; started = true; }
    else {
      if (closed || c === '"') throw new Error('Unexpected character outside quotes');
      field += c; started = true;
    }
  }
  if (quoted) throw new Error('Unclosed quoted field');
  if (started || closed || row.length) { endField(); records.push(row); }
  return records;
}
