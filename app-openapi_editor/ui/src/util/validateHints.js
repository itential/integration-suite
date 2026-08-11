// Best-effort enrichment of validateModel()'s plain error message strings
// (from @apidevtools/swagger-parser, via the cog) with (a) an approximate
// line number in the CURRENT editor text and (b) a severity guess, so the
// UI can point at roughly the right spot instead of just showing a wall of
// text. This is deliberately heuristic, not exact - swagger-parser reports
// errors as plain strings, not structured {instancePath, line, column}
// objects, so there's no exact source-map back to the original document.
//
// Line-locating strategy: pull every /slash/separated/pointer-looking or
// dotted.path-looking token out of the message, take its most specific
// (last) segment, and search the raw JSON text for that segment used as an
// object key ("segment":) - report the first match's line number. Falls
// back to no line if nothing matches (still shows the message).
//
// Severity strategy: swagger-parser/AJV error text has a handful of
// recognizable phrasings for "the document doesn't strictly conform, but
// this specific field just isn't recognized/used, functionality is
// unaffected" (extra/unknown properties, unused $refs) vs. genuine
// structural problems (missing required fields, invalid types, unresolved
// $ref, invalid enum) that would actually break rendering/parsing/use of
// the model. This is a best guess, not a guarantee - always read the full
// message.
const MINOR_PATTERNS = [
  /should not have additional properties/i,
  /must not have additional properties/i,
  /is not allowed to have additional properties/i,
  /is not used anywhere/i,
  /unused/i,
];

const BLOCKING_PATTERNS = [
  /required/i,
  /must be equal to one of the allowed values/i,
  /can't resolve reference/i,
  /cannot resolve reference/i,
  /is not of a type/i,
  /must be (a|an)/i,
  /invalid/i,
];

function classifySeverity(message) {
  if (MINOR_PATTERNS.some((re) => re.test(message))) return 'minor';
  if (BLOCKING_PATTERNS.some((re) => re.test(message))) return 'blocking';
  return 'unknown';
}

function extractPathSegments(message) {
  const tokens = message.match(/[#./]?[\w-]+(?:[./][\w-]+)+/g) || [];
  const segments = [];
  tokens.forEach((token) => {
    const parts = token.split(/[./]/).filter(Boolean);
    if (parts.length) segments.push(parts[parts.length - 1]);
  });
  return segments;
}

// Was: searched for `"segment"` (segment wrapped in its own quotes), which
// only matches when the segment is itself a standalone JSON key or string
// value. Confirmed broken against a real "can't resolve reference" error:
// the offending segment is the tail of a $ref pointer
// ("#/components/schemas/some-schema-name"), which appears in the document
// as part of one longer quoted string ("$ref": "#/components/schemas/
// some-schema-name") - the segment is followed by a closing quote but
// preceded by "/", never by an opening quote, so the old `"segment"` search
// never matched anywhere and no line was ever found, even though the
// segment (and the real problem) was right there in the text. Plain
// substring search catches both this and the original standalone-key case.
function findLineForSegment(lines, segment) {
  if (!segment) return null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(segment)) return i + 1; // 1-based, matches editor gutter
  }
  return null;
}

export function annotateValidationErrors(errors, text) {
  const lines = String(text || '').split('\n');
  return (errors || []).map((message) => {
    const segments = extractPathSegments(message);
    let line = null;
    for (const segment of segments) {
      line = findLineForSegment(lines, segment);
      if (line) break;
    }
    return {
      message,
      line,
      severity: classifySeverity(message),
    };
  });
}
