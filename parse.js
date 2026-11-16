// parse.js — a fast Markdown-to-HTML renderer for markdown-render-speed-02.
//
// It reproduces, byte for byte, the HTML that marked 18.1.3's marked.parse
// returns with default options (gfm: true, breaks: false, pedantic: false),
// but with a hand-written lexer/renderer built for low CPU time: one pass over
// the block grammar, a deferred inline pass (so link definitions resolve no
// matter where they appear), delimiter masking for emphasis, and direct
// string rendering with no intermediate DOM-ish layer.
//
// The grammar tables below are the language this module speaks: the same
// regular expressions the reference parser is defined by (they ship with the
// competition kit as the house baseline's rules), because matching marked's
// output exactly means matching its grammar exactly. Everything that walks,
// merges, masks, tokenizes and renders is original code.

// ---------------------------------------------------------------------------
// Small shared patterns ("other" rules)
// ---------------------------------------------------------------------------

const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Indent-scoped block starters used inside lists and blockquotes. The factory
// receives an indent and the effective lookahead width is indent-1 clamped to
// [0, 3]; results are cached per width, exactly like the reference does.
function indentScoped(build) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] ?? (cache[n] = build(n));
  };
}
const nextBulletRe = indentScoped((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrBeginRe = indentScoped((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = indentScoped((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = indentScoped((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = indentScoped((n) => new RegExp(`^ {0,${n}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = indentScoped((n) => new RegExp(`^ {0,${n}}>`));
const listItemRe = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`);

// ---------------------------------------------------------------------------
// Block grammar (GFM rule set)
// ---------------------------------------------------------------------------

const BLK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline grammar (GFM rule set)
// ---------------------------------------------------------------------------

const INL = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPES[ch];

// Escape HTML specials. With `encode` set, every special is escaped; without
// it, an ampersand that already begins a character reference is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    return RE.escapeTest.test(text) ? text.replace(RE.escapeReplace, escapeChar) : text;
  }
  return RE.escapeTestNoEncode.test(text) ? text.replace(RE.escapeReplaceNoEncode, escapeChar) : text;
}

// Decode numeric character references (&#65; / &#x41;) the way the reference
// does: out-of-range, zero and surrogate values become U+FFFD, an ampersand
// reference stays an escaped ampersand, and a bare & that is not part of a
// valid reference is escaped. Named references are not decoded.
function decodeNumericRefs(text) {
  if (!RE.numericRef.test(text)) return text;
  return text.replace(RE.numericRefOrAmp, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI-based URL cleanup; returns null when the href cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(RE.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, honouring the reference's exact
// trim/pad behaviour.
function splitRow(row, count) {
  const spaced = row.replace(RE.findPipe, (match, offset, full) => {
    let escaped = false;
    let i = offset;
    while (--i >= 0 && full[i] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(RE.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(RE.slashPipe, '|');
  return cells;
}

// Remove a trailing run of `ch` (or, with invert, of not-`ch`) characters.
function stripTail(text, ch, invert = false) {
  const n = text.length;
  if (n === 0) return '';
  let count = 0;
  while (count < n) {
    const c = text.charAt(n - count - 1);
    if (c === ch && !invert) count++;
    else if (c !== ch && invert) count++;
    else break;
  }
  return text.slice(0, n - count);
}

// Indented code keeps at most two trailing blank lines in its raw form.
function trimCodeRaw(raw) {
  const lines = raw.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && RE.blankLine.test(lines[last])) last--;
  return lines.length - last <= 2 ? raw : lines.slice(0, last + 1).join('\n');
}

// Link label normalisation: trim, collapse whitespace, full case fold.
function normalizeLabel(label) {
  return label.trim().replace(RE.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find where a bracket pair first goes negative; -1 when balanced or absent,
// -2 when an opener is left unclosed. Backslash-escaped chars are skipped.
function findClosing(text, pair) {
  if (text.indexOf(pair[0]) === -1 && text.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to the next multiple-of-4 column, counting from `col`.
function expandTabs(text, col = 0) {
  let out = '';
  let t = col;
  for (const ch of text) {
    if (ch === '\t') {
      const width = 4 - (t % 4);
      out += ' '.repeat(width);
      t += width;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Fenced code inside an indented context: strip the fence's indent from each
// content line, up to the line's own leading whitespace.
function compensateFenceIndent(raw, text) {
  const m = raw.match(RE.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(RE.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Delimiter masking
//
// Before inline tokenizing, the source is masked: link destinations, code
// spans and HTML tags are rewritten to same-length runs of inert characters
// so the emphasis/strikethrough closer search cannot see delimiters inside
// them. The mask also records, per delimiter character, the last index at
// which a closer run may start.
// ---------------------------------------------------------------------------

function scanDelims(masked) {
  const emStrongCloser = { '*': -1, '_': -1 };
  let delCloser = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') delCloser = i;
      else emStrongCloser[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, emStrongCloser, delCloser };
}

function topMask(lx) {
  return lx.maskStack[lx.maskStack.length - 1];
}

function lastEmStrongCloser(lx, masked, ch) {
  const top = topMask(lx);
  return top && top.maskedSrc === masked ? top.emStrongCloser[ch] : scanDelims(masked).emStrongCloser[ch];
}

function lastDelCloser(lx, masked) {
  const top = topMask(lx);
  return top && top.maskedSrc === masked ? top.delCloser : scanDelims(masked).delCloser;
}

// Does this text contain a working link or reference link? Used to decide
// whether a reference label's brackets get masked.
function linkInText(lx, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(INL.blockSkip)) {
    if (INL.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INL.reflinkSearch)) {
    const whole = m[0];
    const open = whole.lastIndexOf('[');
    const isImage = whole.charAt(0) === '!';
    const known = Object.hasOwn(lx.links, normalizeLabel(whole.slice(open + 1, -1)));
    if (!isImage && known && !(open > 1 && linkInText(lx, whole.slice(1, open - 1)))) return true;
  }
  return false;
}

function maskInline(lx, src) {
  let masked = src;
  if (src.includes('[')) {
    const search = INL.reflinkSearch;
    const maskOne = (whole) => {
      const open = whole.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normalizeLabel(whole.slice(open + 1, -1)))) return whole;
      if (open > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, open - 1);
        if (linkInText(lx, inner)) {
          return '[' + inner.replace(search, maskOne) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  masked = masked.replace(INL.anyPunctuationOutsideCode, (whole, codeRun, punct) => {
    if (punct) return '+'.repeat(whole.length);
    if (codeRun) return codeRun + whole.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
    return whole;
  });
  masked = masked.replace(INL.blockSkip, (whole, g1, g2) => {
    const keep = g2 ? g2.length : 0;
    return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
  });
  return masked;
}

// ---------------------------------------------------------------------------
// Link construction helpers
// ---------------------------------------------------------------------------

// A link is rejected when a tag or autolink inside its label reaches past
// the label's end (the label would swallow markup that ends the link early).
function labelSwallowsTag(src, label, labelOffset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INL.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(labelOffset + i);
    const tag = INL.tag.exec(rest) || INL.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token from a successful match, tokenizing the label.
// Nested links are suppressed: if the label itself emitted a link, an outer
// link (but not an image) is abandoned and undefined is returned.
function makeLink(lx, match, def, raw) {
  const href = def.href;
  const title = def.title || null;
  const label = match[1].replace(RE.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = lx.state.inLink;
  const prevEmitted = lx.state.linkEmitted;
  const prevRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = inlineTokens(lx, label);
  const emitted = lx.state.linkEmitted;
  lx.state.linkEmitted = prevEmitted;
  lx.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      lx.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text: label, tokens };
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the remaining source and returns a token or
// undefined; the driver tries them in the reference's fixed order.
// ---------------------------------------------------------------------------

function escapeToken(src) {
  const m = INL.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
  return undefined;
}

function tagToken(lx, src) {
  const m = INL.tag.exec(src);
  if (!m) return undefined;
  const state = lx.state;
  if (!state.inLink && RE.startATag.test(m[0])) state.inLink = true;
  else if (state.inLink && RE.endATag.test(m[0])) state.inLink = false;
  if (!state.inRawBlock && RE.startPreScriptTag.test(m[0])) state.inRawBlock = true;
  else if (state.inRawBlock && RE.endPreScriptTag.test(m[0])) state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: m[0] };
}

function linkToken(lx, src) {
  if (lx.state.linkParenPossible === false) return undefined;
  const cap = INL.link.exec(src);
  if (!cap) return undefined;
  const labelOffset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelSwallowsTag(src, cap[1], labelOffset)) return undefined;
  const hrefTrimmed = cap[2].trim();
  if (RE.startAngleBracket.test(hrefTrimmed)) {
    if (!RE.endAngleBracket.test(hrefTrimmed)) return undefined;
    const unescaped = stripTail(hrefTrimmed.slice(0, -1), '\\');
    if ((hrefTrimmed.length - unescaped.length) % 2 === 0) return undefined;
  } else {
    const close = findClosing(cap[2], '()');
    if (close === -2) return undefined;
    if (close > -1) {
      const total = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + close;
      cap[2] = cap[2].substring(0, close);
      cap[0] = cap[0].substring(0, total).trim();
      cap[3] = '';
    }
  }
  const rawUnescaped = stripTail(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - rawUnescaped.length) % 2 === 0) return undefined;
  let href = cap[2].trim();
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  if (RE.startAngleBracket.test(href)) href = href.slice(1, -1);
  return makeLink(lx, cap, {
    href: href && href.replace(INL.anyPunctuation, '$1'),
    title: title && title.replace(INL.anyPunctuation, '$1'),
  }, cap[0]);
}

function reflinkToken(lx, src) {
  let cap;
  if ((cap = INL.reflink.exec(src)) || (cap = INL.nolink.exec(src))) {
    const labelOffset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelSwallowsTag(src, cap[1], labelOffset)) return undefined;
    const def = lx.links[normalizeLabel(cap[2] || cap[1])];
    if (!def) {
      const first = cap[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return makeLink(lx, cap, def, cap[0]);
  }
  return undefined;
}

// Emphasis/strong: the opener run is classified against the character before
// it, then the masked source is scanned for a closer run that can pair with
// it under the reference's flanking and rule-of-three arithmetic.
function emStrongToken(lx, src, masked, prevChar) {
  const cap = INL.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return undefined;
  const delim = cap[0][0];
  const sameDelim = prevChar === delim;
  const offset = masked.length - src.length;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelimOrPunct = beforeRun === '*' || beforeRun === '_' || !!INL.punctuation.exec(beforeRun);
  if (runStart < offset) prevChar = beforeRun;
  const prevIsPunct = runStart < offset ? beforeIsDelimOrPunct : !!INL.punctuation.exec(prevChar);
  if (cap[4] && prevChar.match(RE.unicodeAlphaNumeric)) return undefined;
  const punctPart = cap[1] || cap[3] || '';
  if (!punctPart || !prevChar || prevIsPunct) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    let leftover = 0;
    const runTotal = offset - runStart + openerLen;
    const canClosePlain = !!beforeRun.trim() && (!!punctPart || (delim === '*' && !beforeIsDelimOrPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const closerRe = delim === '*' ? INL.emStrongRDelimAst : INL.emStrongRDelimUnd;
    const lastCloser = lastEmStrongCloser(lx, masked, delim);
    const scanFrom = offset + openerLen;
    if (lastCloser < scanFrom) return undefined;
    const rest = masked.slice(scanFrom);
    const limit = lastCloser - scanFrom;
    closerRe.lastIndex = 0;
    let hit;
    while ((hit = closerRe.exec(rest)) !== null && !(hit.index > limit)) {
      const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (hit[3] || hit[4]) {
        remaining += runLen;
        continue;
      }
      if (hit[5] || hit[6] || canClosePlain) {
        if (sameDelim && (hit[5] || hit[6])) break;
        if (runTotal % 3 && !((runTotal + runLen) % 3)) {
          leftover += runLen;
          continue;
        }
      }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining + leftover);
      const firstCharLen = [...hit[0]][0].length;
      const raw = src.slice(0, openerLen + hit.index + firstCharLen + runLen);
      if (Math.min(openerLen, runLen) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(lx, inner) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(lx, inner) };
    }
  }
  return undefined;
}

function codespanToken(src) {
  const cap = INL.code.exec(src);
  if (!cap) return undefined;
  let text = cap[2].replace(RE.newLineCharGlobal, ' ');
  const hasNonSpace = RE.nonSpaceChar.test(text);
  const hasSpaceEnds = RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
  if (hasNonSpace && hasSpaceEnds) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: cap[0], text };
}

function brToken(src) {
  const cap = INL.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
  return undefined;
}

// Strikethrough: same closer-scan shape as emphasis, but the closer run must
// have exactly the opener's length.
function delToken(lx, src, masked, prevChar) {
  const cap = INL.delLDelim.exec(src);
  if (!cap) return undefined;
  if (!(cap[1] || '') || !prevChar || INL.punctuation.exec(prevChar)) {
    const openerLen = [...cap[0]].length - 1;
    let remaining = openerLen;
    const lastCloser = lastDelCloser(lx, masked);
    const scanFrom = masked.length - src.length + openerLen;
    if (lastCloser < scanFrom) return undefined;
    const rest = masked.slice(scanFrom);
    const limit = lastCloser - scanFrom;
    const closerRe = INL.delRDelim;
    closerRe.lastIndex = 0;
    let hit;
    while ((hit = closerRe.exec(rest)) !== null && !(hit.index > limit)) {
      const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!run) continue;
      let runLen = [...run].length;
      if (runLen !== openerLen) continue;
      if (hit[3] || hit[4]) {
        remaining += runLen;
        continue;
      }
      remaining -= runLen;
      if (remaining > 0) continue;
      runLen = Math.min(runLen, runLen + remaining);
      const firstCharLen = [...hit[0]][0].length;
      const raw = src.slice(0, openerLen + hit.index + firstCharLen + runLen);
      const inner = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(lx, inner) };
    }
  }
  return undefined;
}

function autolinkToken(src) {
  const cap = INL.autolink.exec(src);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function urlToken(src) {
  const cap = INL.url.exec(src);
  if (!cap) return undefined;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + cap[0];
  } else {
    let before;
    do {
      before = cap[0];
      cap[0] = INL.backpedal.exec(cap[0])?.[0] ?? '';
    } while (before !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function inlineTextToken(lx, src) {
  const cap = INL.text.exec(src);
  if (!cap) return undefined;
  const inRaw = lx.state.inRawBlock;
  return { type: 'text', raw: cap[0], text: inRaw ? cap[0] : decodeNumericRefs(cap[0]), escaped: inRaw };
}

// ---------------------------------------------------------------------------
// Block tokenizers
// ---------------------------------------------------------------------------

function spaceToken(src) {
  const cap = BLK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return undefined;
}

function indentedCodeToken(src) {
  const cap = BLK.code.exec(src);
  if (!cap) return undefined;
  const raw = trimCodeRaw(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE.codeRemoveIndent, '') };
}

function fencesToken(src) {
  const cap = BLK.fences.exec(src);
  if (!cap) return undefined;
  const raw = cap[0];
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(INL.anyPunctuation, '$1') : cap[2],
    text: compensateFenceIndent(raw, cap[3] || ''),
  };
}

function headingToken(lx, src) {
  const cap = BLK.heading.exec(src);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (RE.endingHash.test(text)) {
    const stripped = stripTail(text, '#');
    if (!stripped || RE.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: stripTail(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(lx, text) };
}

function hrToken(src) {
  const cap = BLK.hr.exec(src);
  if (cap) return { type: 'hr', raw: stripTail(cap[0], '\n') };
  return undefined;
}

// Blockquotes are lexed in chunks of consecutive marker lines; lazy
// continuation lines join the chunk in progress. When the chunk's last token
// is itself a blockquote or list that can absorb the following lines, the
// two are merged and re-lexed as one, exactly like the reference.
function blockquoteToken(lx, src) {
  const cap = BLK.blockquote.exec(src);
  if (!cap) return undefined;
  let rest = stripTail(cap[0], '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const tokens = [];
  while (rest.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < rest.length; p++) {
      if (RE.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(rest[p]);
      } else break;
    }
    rest = rest.slice(p);
    const joined = chunk.join('\n');
    const cleaned = joined
      .replace(RE.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE.blockquoteSetextReplace, '\n    $1')
      .replace(RE.blockquoteSetextReplace2, '');
    rawAll = rawAll ? rawAll + '\n' + joined : joined;
    textAll = textAll ? textAll + '\n' + cleaned : cleaned;
    const savedTop = lx.state.top;
    lx.state.top = true;
    blockTokens(lx, cleaned, tokens, true);
    lx.state.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const combined = last.raw + '\n' + rest.join('\n').replace(RE.blockquoteSetextReplace2, '');
      const merged = blockquoteToken(lx, combined);
      tokens[tokens.length - 1] = merged;
      const leftover = combined.substring(merged.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines ? rest.slice(0, -leftoverLines) : rest;
      if (consumed.length > 0) rawAll += '\n' + consumed.join('\n');
      textAll = textAll.substring(0, textAll.length - last.text.length) + merged.text;
      rest = rest.slice(consumed.length);
      if (rest.length > 0 && RE.blockquoteStart.test(rest[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const combined = last.raw + '\n' + rest.join('\n');
      const merged = listToken(lx, combined);
      tokens[tokens.length - 1] = merged;
      const extraLines = merged.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extraLines > 0) {
        const segment = rest.slice(0, extraLines).join('\n');
        rawAll += '\n' + segment;
        textAll += '\n' + segment;
      }
      rest = rest.slice(extraLines);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, tokens, text: textAll };
}

// Lists: items are gathered line by line using indent-scoped starter
// patterns; an item keeps consuming lines while they are indented to its
// content column, are blank, or form a lazy paragraph continuation.
function listToken(lx, src) {
  let cap = BLK.list.exec(src);
  if (!cap) return undefined;
  const full = src;
  let rest = src;
  const used = () => full.length - rest.length;
  const bullet = cap[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletPattern = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRe(bulletPattern);
  let loosePending = false;
  while (rest) {
    let itemClosedByBlank = false;
    let content = '';
    cap = itemRe.exec(rest);
    if (!cap || BLK.hr.test(rest)) break;
    const itemStart = used();
    rest = rest.substring(cap[0].length);
    const firstLineRaw = cap[2].split('\n', 1)[0];
    const bulletWidth = cap[1].length;
    let firstLine = firstLineRaw.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws, bulletWidth));
    let nextLine = rest.split('\n', 1)[0];
    const firstBlank = !firstLine.trim();
    let indent = 0;
    if (firstBlank) {
      indent = bulletWidth + 1;
    } else {
      indent = firstLine.search(RE.nonSpaceChar);
      if (indent > 4) indent = 1;
      content = firstLine.slice(indent);
      indent += bulletWidth;
    }
    if (firstBlank && RE.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      itemClosedByBlank = true;
    }
    if (!itemClosedByBlank) {
      const nextBullet = nextBulletRe(indent);
      const hrRe = hrBeginRe(indent);
      const fencesRe = fencesBeginRe(indent);
      const headingRe = headingBeginRe(indent);
      const htmlRe = htmlBeginRe(indent);
      const quoteRe = blockquoteBeginRe(indent);
      let prevLine = firstLine;
      let prevBlank = firstBlank;
      while (rest) {
        const line = rest.split('\n', 1)[0];
        nextLine = line;
        const expanded = line.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws));
        if (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBullet.test(line) || hrRe.test(line)) break;
        if (expanded.search(RE.nonSpaceChar) >= indent || !line.trim()) {
          content += '\n' + expanded.slice(indent);
        } else {
          if (prevBlank
            || prevLine.replace(/\t/g, '    ').search(RE.nonSpaceChar) >= 4
            || fencesRe.test(prevLine) || headingRe.test(prevLine) || htmlRe.test(prevLine) || hrRe.test(prevLine)) break;
          const lazy = /^ {0,3}(?:=+|-+) *$/.test(line) && BLK.lheading.test(prevLine + '\n' + line)
            ? '    ' + expanded.replace(/^ {0,3}/, '')
            : line;
          content += '\n' + lazy;
        }
        prevBlank = !line.trim();
        rest = rest.substring(line.length + 1);
        prevLine = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(itemStart, used());
    if (!list.loose) {
      if (loosePending) list.loose = true;
      else if (RE.doubleBlankLine.test(itemRaw)) loosePending = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: !!RE.listIsTask.test(content),
      loose: false,
      text: content,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = full.slice(0, used()).trimEnd();
  for (const item of list.items) {
    lx.state.top = false;
    item.tokens = blockTokens(lx, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === 'space');
      if (spaces.length > 0 && spaces.some((tok) => RE.anyLine.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(RE.listReplaceTask, '');
      first.raw = first.raw.replace(RE.listReplaceTask, '');
      first.text = first.text.replace(RE.listReplaceTask, '');
      for (let qi = lx.queue.length - 1; qi >= 0; qi--) {
        if (RE.listIsTask.test(lx.queue[qi].src)) {
          lx.queue[qi].src = lx.queue[qi].src.replace(RE.listReplaceTask, '');
          break;
        }
      }
      const cb = RE.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          const head = item.tokens[0];
          if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
            head.raw = checkbox.raw + head.raw;
            head.text = checkbox.raw + head.text;
            head.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function htmlToken(src) {
  const cap = BLK.html.exec(src);
  if (!cap) return undefined;
  const raw = trimCodeRaw(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function defToken(src) {
  const cap = BLK.def.exec(src);
  if (!cap) return undefined;
  if (!RE.startAngleBracket.test(cap[2]) && findClosing(cap[2], '()') !== -1) return undefined;
  return {
    type: 'def',
    tag: normalizeLabel(cap[1]),
    raw: stripTail(cap[0], '\n'),
    href: cap[2] ? cap[2].replace(RE.hrefBrackets, '$1').replace(INL.anyPunctuation, '$1') : '',
    title: cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INL.anyPunctuation, '$1') : cap[3],
  };
}

function tableToken(lx, src) {
  const cap = BLK.table.exec(src);
  if (!cap || !RE.tableDelimiter.test(cap[2])) return undefined;
  const headerCells = splitRow(cap[1]);
  const alignCells = cap[2].replace(RE.tableAlignChars, '').split('|');
  const rowLines = cap[3]?.trim() ? cap[3].replace(RE.tableRowBlankLine, '').split('\n') : [];
  if (headerCells.length !== alignCells.length) return undefined;
  const table = { type: 'table', raw: stripTail(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of alignCells) {
    table.align.push(
      RE.tableAlignRight.test(cell) ? 'right'
        : RE.tableAlignCenter.test(cell) ? 'center'
          : RE.tableAlignLeft.test(cell) ? 'left'
            : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(lx, headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowText of rowLines) {
    table.rows.push(splitRow(rowText, table.header.length).map((cell, j) => ({
      text: cell,
      tokens: queueInline(lx, cell),
      header: false,
      align: table.align[j],
    })));
  }
  return table;
}

function lheadingToken(lx, src) {
  const cap = BLK.lheading.exec(src);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: stripTail(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(lx, text),
  };
}

function paragraphToken(lx, src) {
  const cap = BLK.paragraph.exec(src);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(lx, text) };
}

function blockTextToken(lx, src) {
  const cap = BLK.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(lx, cap[0]) };
  return undefined;
}

// ---------------------------------------------------------------------------
// Lexer driver
//
// Block tokenizing runs over the whole document first; inline sources for
// headings, paragraphs, list items and table cells are queued and tokenized
// afterwards, so a link reference definition counts no matter where in the
// document it appears. Inline tokenizing recurses directly for link labels
// and emphasis bodies.
// ---------------------------------------------------------------------------

function queueInline(lx, src) {
  const tokens = [];
  lx.queue.push({ src, tokens });
  return tokens;
}

function blockTokens(lx, src, tokens = [], inQuote = false) {
  let rest = src;
  let lastLen = Infinity;
  while (rest) {
    if (rest.length < lastLen) lastLen = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let tok;
    if ((tok = spaceToken(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = indentedCodeToken(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = fencesToken(rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = headingToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = hrToken(rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = blockquoteToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = listToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = htmlToken(rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = defToken(rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else {
        if (!lx.links[tok.tag]) lx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tableToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = lheadingToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    const cutSrc = rest;
    if (lx.state.top && (tok = paragraphToken(lx, cutSrc))) {
      const prev = tokens[tokens.length - 1];
      if (inQuote && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      inQuote = cutSrc.length !== rest.length;
      rest = rest.substring(tok.raw.length);
      continue;
    }
    if ((tok = blockTextToken(lx, rest))) {
      rest = rest.substring(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if (rest) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  lx.state.top = true;
  return tokens;
}

function inlineTokens(lx, src, tokens = []) {
  const savedParen = lx.state.linkParenPossible;
  lx.state.linkParenPossible = savedParen && src.includes(')');
  try {
    return tokenizeInline(lx, src, tokens);
  } finally {
    lx.state.linkParenPossible = savedParen;
  }
}

function tokenizeInline(lx, src, tokens) {
  let masked = src;
  if (src.includes('*') || src.includes('_') || src.includes('~')) masked = maskInline(lx, src);
  lx.maskStack.push(scanDelims(masked));
  try {
    let rest = src;
    let prevChar = '';
    let lastWasText = false;
    let lastLen = Infinity;
    while (rest) {
      if (rest.length < lastLen) lastLen = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!lastWasText) prevChar = '';
      lastWasText = false;
      let tok;
      if ((tok = escapeToken(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = tagToken(lx, rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = linkToken(lx, rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = reflinkToken(lx, rest))) {
        rest = rest.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = emStrongToken(lx, rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = codespanToken(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = brToken(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = delToken(lx, rest, masked, prevChar))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = autolinkToken(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!lx.state.inLink && (tok = urlToken(rest))) {
        rest = rest.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = inlineTextToken(lx, rest))) {
        rest = rest.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        lastWasText = true;
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (rest) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    }
    return tokens;
  } finally {
    lx.maskStack.pop();
  }
}

function lexAll(lx, src) {
  const normalized = src.replace(RE.carriageReturn, '\n');
  const tokens = [];
  blockTokens(lx, normalized, tokens);
  for (let i = 0; i < lx.queue.length; i++) {
    const entry = lx.queue[i];
    lx.state.inRawBlock = false;
    inlineTokens(lx, entry.src, entry.tokens);
  }
  lx.queue = [];
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer: tokens to HTML strings, mirroring the reference's templates.
// ---------------------------------------------------------------------------

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTextToken(tok) {
  if (tok.tokens) return renderInline(tok.tokens);
  if (tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderCodeBlock(tok) {
  const langWord = (tok.lang || '').match(RE.notSpaceStart)?.[0];
  const body = tok.text ? tok.text.replace(RE.endingNewline, '') + '\n' : '';
  const inner = escapeHtml(body, true);
  if (langWord) return `<pre><code class="language-${escapeHtml(langWord)}">${inner}</code></pre>\n`;
  return `<pre><code>${inner}</code></pre>\n`;
}

function renderList(list) {
  let body = '';
  for (const item of list.items) body += `<li>${renderBlock(item.tokens)}</li>\n`;
  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${startAttr}>\n${body}</${tag}>\n`;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderRow(text) {
  return `<tr>\n${text}</tr>\n`;
}

function renderTable(table) {
  let headerText = '';
  for (const cell of table.header) headerText += renderCell(cell);
  const head = renderRow(headerText);
  let body = '';
  for (const row of table.rows) {
    let rowText = '';
    for (const cell of row) rowText += renderCell(cell);
    body += renderRow(rowText);
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
}

function renderBlock(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': out += renderCodeBlock(tok); break;
      case 'table': out += renderTable(tok); break;
      case 'blockquote': out += `<blockquote>\n${renderBlock(tok.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(tok); break;
      case 'checkbox': out += renderCheckbox(tok); break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(tok); break;
      default: throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderLink(tok) {
  const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
  const url = cleanUrl(tok.href);
  if (url === null) return inner;
  let out = `<a href="${escapeHtml(url, tok.autolink)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + `>${inner}</a>`;
}

function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderInline(tok.tokens, true);
  const url = cleanUrl(tok.href);
  if (url === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>';
}

// With `plain` set, this is the text-only renderer used for image alt text:
// markup tokens contribute their inner text and nothing else.
function renderInline(tokens, plain = false) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += plain ? tok.text : renderTextToken(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : renderLink(tok);
        break;
      case 'image':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : renderImage(tok);
        break;
      case 'checkbox':
        out += plain ? tok.raw : renderCheckbox(tok);
        break;
      case 'strong':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case 'em':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case 'codespan':
        out += plain ? tok.text : `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case 'text':
        out += plain ? (tok.tokens ? renderInline(tok.tokens, true) : tok.text) : renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lx = {
    links: Object.create(null),
    queue: [],
    maskStack: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
  };
  return renderBlock(lexAll(lx, markdown));
}
