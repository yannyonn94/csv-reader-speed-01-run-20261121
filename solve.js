// Fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// {columns, rows, errors} for {text, header}, as the reference does.
//
// Written from the reference's stated policy (not copied from it): BOM drop,
// LF/CRLF record ends, lone CR outside quotes dropped (stray_cr), quoted
// fields with "" escapes and CR/CRLF -> LF inside, junk after a closing
// quote appended (quote_junk), unterminated quotes re-read as unquoted
// (unterminated_quote), ragged rows padded/cut (short_row/long_row).
//
// Speed: the reference builds every field one character at a time. This
// parser instead finds each field's end with native indexOf scans and
// extracts fields with slice, so the common unquoted field costs one
// indexOf pass and one slice, with no per-character concatenation. Quoted
// fields are found with indexOf('"') and only fall back to segment
// transformation when they actually contain a newline, a CR, or a doubled
// quote. No regex runs in the hot path (one tiny replace only on a quoted
// segment that contains a CR, which is rare).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // Shared result holder for the field readers below, so no result object
  // is allocated per field. Callers read res.v / res.e / res.a at once.
  const res = { v: '', e: 0, a: 0 };

  // Append one quoted segment text[a..b) to a value, counting lines and
  // turning every CRLF / lone CR inside it into LF. Returns the segment
  // (transformed only when it holds a CR; LF-only segments are returned
  // as a plain slice). Updates `line`.
  function quotedSegment(a, b) {
    if (a >= b) return '';
    const cr = text.indexOf('\r', a);
    if (cr === -1 || cr >= b) {
      const nl = text.indexOf('\n', a);
      if (nl === -1 || nl >= b) return text.slice(a, b);
      let cnt = 0;
      let idx = a;
      while (true) {
        idx = text.indexOf('\n', idx);
        if (idx === -1 || idx >= b) break;
        cnt += 1;
        idx += 1;
      }
      line += cnt;
      return text.slice(a, b);
    }
    const seg = text.slice(a, b).replace(/\r\n?/g, '\n');
    let cnt = 0;
    let idx = 0;
    while (true) {
      idx = seg.indexOf('\n', idx);
      if (idx === -1) break;
      cnt += 1;
      idx += 1;
    }
    line += cnt;
    return seg;
  }

  // Read an unquoted field starting at `pos`, with `init` as its starting
  // value ('' normally, the quoted value for quote-junk, '"' for an
  // unterminated quote). Sets res.v (value), res.e (COMMA/LINE_BREAK/END)
  // and res.a (characters kept after `init`). Drops lone CRs (stray_cr).
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    let dirty = false;
    while (true) {
      const comma = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      let end = -1;
      let kind = 0; // 1: comma, 2: LF, 0: EOF
      if (comma !== -1) { end = comma; kind = 1; }
      if (nl !== -1 && (end === -1 || nl < end)) { end = nl; kind = 2; }
      if (end === -1) { end = n; kind = 0; }
      // A CR can only matter inside this field's span [pos, end): scan
      // just that span (a few characters) instead of indexOf('\r') over
      // the rest of the file, which on LF files scans thousands of chars.
      let crPos = -1;
      for (let i = pos; i < end; i++) {
        if (text.charCodeAt(i) === 13) { crPos = i; break; }
      }
      if (crPos !== -1) {
        if (crPos + 1 === nl) {
          // CRLF: the field ends at the CR, the record at the LF.
          const len = crPos - start;
          if (!dirty && init === '') value = text.slice(start, crPos);
          else if (len > 0) value += text.slice(start, crPos);
          added += len;
          pos = nl + 1;
          line += 1;
          res.v = value; res.e = LINE_BREAK; res.a = added;
          return res;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const len = crPos - start;
        if (!dirty && init === '') value = text.slice(start, crPos);
        else if (len > 0) value += text.slice(start, crPos);
        added += len;
        dirty = true;
        pos = crPos + 1;
        start = pos;
        continue;
      }
      if (kind === 0) {
        const len = n - start;
        if (!dirty && init === '') value = text.slice(start, n);
        else if (len > 0) value += text.slice(start, n);
        added += len;
        pos = n;
        res.v = value; res.e = END; res.a = added;
        return res;
      }
      const len = end - start;
      if (!dirty && init === '') value = text.slice(start, end);
      else if (len > 0) value += text.slice(start, end);
      added += len;
      if (kind === 1) {
        pos = end + 1;
        res.v = value; res.e = COMMA; res.a = added;
        return res;
      }
      pos = end + 1;
      line += 1;
      res.v = value; res.e = LINE_BREAK; res.a = added;
      return res;
    }
  }

  // Read a quoted field whose opening quote is at `pos`. Sets res like
  // readUnquoted (res.a is only meaningful for the junk path's caller).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let parts = null;
    let segStart = pos;
    let closed = false;
    let closePos = -1;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        const seg = quotedSegment(segStart, q);
        if (parts === null) parts = [seg, '"'];
        else { parts.push(seg, '"'); }
        pos = q + 2;
        segStart = pos;
        continue;
      }
      closed = true;
      closePos = q;
      break;
    }
    if (!closed) {
      // The quote never closes: literal character, text after it re-read
      // as unquoted, line restored to the opening quote's line.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    const seg = quotedSegment(segStart, closePos);
    let val;
    if (parts === null) val = seg;
    else { parts.push(seg); val = parts.join(''); }
    pos = closePos + 1;
    if (pos >= n) {
      res.v = val; res.e = END; res.a = 0;
      return res;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      res.v = val; res.e = COMMA; res.a = 0;
      return res;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      res.v = val; res.e = LINE_BREAK; res.a = 0;
      return res;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      res.v = val; res.e = LINE_BREAK; res.a = 0;
      return res;
    }
    // Junk after the closing quote, appended as it stands.
    const r = readUnquoted(val);
    if (r.a > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return r;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole record on one line with no quote and no stray
    // CR. Most records are like this. Split the line on commas with
    // indexOf only (no per-field LF/CR scans, no field-reader calls).
    // Any quote or stray CR in the line falls through to the general
    // field parser below, which handles multiline quoted fields.
    {
      const nlIdx = text.indexOf('\n', pos);
      const hasLF = nlIdx !== -1;
      const le = hasLF ? nlIdx : n;
      const contentEnd = hasLF && le > pos && text.charCodeAt(le - 1) === 13 ? le - 1 : le;
      if (hasLF && contentEnd === pos && text.charCodeAt(pos) === 13) {
        // A line holding only a stray CR: no record, error stays.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = le + 1;
        line += 1;
        continue;
      }
      const qIdx = text.indexOf('"', pos);
      const crIdx = text.indexOf('\r', pos);
      if ((qIdx === -1 || qIdx >= le) && (crIdx === -1 || crIdx >= contentEnd)) {
        const fields = [];
        let start = pos;
        while (true) {
          const comma = text.indexOf(',', start);
          if (comma === -1 || comma >= contentEnd) {
            fields.push(text.slice(start, contentEnd));
            break;
          }
          fields.push(text.slice(start, comma));
          start = comma + 1;
        }
        pos = hasLF ? le + 1 : n;
        if (hasLF) line += 1;
        if (fields.length === 1 && fields[0] === '') continue;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
          continue;
        }
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    let ended;
    do {
      if (pos < n && text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted('');
      }
      fields.push(res.v);
      ended = res.e;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
