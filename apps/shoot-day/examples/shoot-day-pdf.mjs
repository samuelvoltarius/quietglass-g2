/**
 * Shoot Day: a small, dependency-free PDF text extractor and the storyboard
 * proposal (PDF text → language model → scenes) used by shoot-day-server.mjs.
 *
 * What the extractor can do
 *   - uncompressed and FlateDecode content streams (zlib, Node's own);
 *   - objects inside object streams (/Type /ObjStm, PDF 1.5+);
 *   - the page tree in reading order, inherited /Resources, Form XObjects (Do);
 *   - text operators Tj, TJ, ' and " with Tf (font), BT/ET, Td, TD, T-star and Tm (line breaks);
 *   - Unicode through a font's /ToUnicode CMap (bfchar and bfrange) — this is
 *     how Canva, Word and most layout programs write text (Type0 / Identity-H);
 *   - simple fonts without a ToUnicode map as Windows-1252.
 *
 * What it cannot do (and says so: the text simply comes back empty or partial)
 *   - encrypted PDFs, scanned pages (pictures of text — that needs OCR),
 *     filters other than FlateDecode (LZW, ASCII85 …), Type3 fonts and custom
 *     /Encoding /Differences without a ToUnicode map, exact reading order of
 *     multi-column layouts (lines come in the order they were drawn).
 *
 * Every step is capped (objects, inflated bytes, nesting, output length), so
 * a broken or hostile file cannot make the server run out of memory.
 */
import { inflateSync, constants as zlibConstants } from "node:zlib";

export const PDF_LIMITS = Object.freeze({
  /** Bytes one stream may inflate to. */
  streamBytes: 16 * 1024 * 1024,
  /** Objects looked at. */
  objects: 50_000,
  /** Pages read. */
  pages: 500,
  /** Characters of text returned. */
  text: 200_000,
  /** Nesting of page tree and form XObjects. */
  depth: 12,
});

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/** Reads the object table by scanning for "n g obj" (works without a valid xref). */
function readObjects(buffer) {
  const src = buffer.toString("latin1");
  const objects = new Map();
  const head = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  let count = 0;
  while ((match = head.exec(src)) && count++ < PDF_LIMITS.objects) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const end = src.indexOf("endobj", start);
    if (end < 0) break;
    let body = src.slice(start, end);
    let stream = null;
    const streamAt = findStreamKeyword(body);
    if (streamAt >= 0) {
      let dataStart = start + streamAt + "stream".length;
      if (src[dataStart] === "\r") dataStart++;
      if (src[dataStart] === "\n") dataStart++;
      const dict = body.slice(0, streamAt);
      const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = -1;
      if (length) {
        const guess = dataStart + Number(length[1]);
        if (guess <= src.length && /^\s*endstream/.test(src.slice(guess, guess + 20))) dataEnd = guess;
      }
      if (dataEnd < 0) {
        const endstream = src.indexOf("endstream", dataStart);
        if (endstream < 0) continue;
        dataEnd = endstream;
        if (src[dataEnd - 1] === "\n") dataEnd--;
        if (src[dataEnd - 1] === "\r") dataEnd--;
      }
      stream = buffer.subarray(dataStart, Math.max(dataStart, dataEnd));
      body = dict;
      // Binary data may contain the letters "endobj": continue after the real end.
      const realEnd = src.indexOf("endobj", dataEnd);
      head.lastIndex = realEnd > 0 ? realEnd : end;
    } else {
      head.lastIndex = end;
    }
    // Later definitions win (incremental updates append to the file).
    objects.set(num, { dict: body, stream });
  }
  // Objects stored inside object streams fill the gaps.
  for (const [, object] of [...objects]) {
    if (!object.stream || !/\/Type\s*\/ObjStm\b/.test(object.dict)) continue;
    const data = decodeStream(object);
    if (!data) continue;
    const text = data.toString("latin1");
    const n = Number(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const numbers = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && i * 2 + 1 < numbers.length; i++) {
      const num = numbers[i * 2];
      const offset = first + numbers[i * 2 + 1];
      const next = i + 1 < n && (i + 1) * 2 + 1 < numbers.length ? first + numbers[(i + 1) * 2 + 1] : text.length;
      if (!objects.has(num)) objects.set(num, { dict: text.slice(offset, next), stream: null });
    }
  }
  return { objects, src };
}

function findStreamKeyword(body) {
  const re = /(>>\s*)stream(\r\n|\n|\r)/g;
  const match = re.exec(body);
  return match ? match.index + match[1].length : -1;
}

/** FlateDecode or no filter; anything else (pictures, LZW …) is not text and returns null. */
function decodeStream(object) {
  if (!object.stream) return null;
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(object.dict)?.[1] ?? "";
  const names = filter.match(/\/\w+/g) ?? [];
  if (names.length === 0) return object.stream;
  if (names.length !== 1 || (names[0] !== "/FlateDecode" && names[0] !== "/Fl")) return null;
  try {
    return inflateSync(object.stream, { maxOutputLength: PDF_LIMITS.streamBytes });
  } catch {
    try {
      // Many writers cut the last bytes of the zlib trailer; what came before is still good.
      return inflateSync(object.stream, { maxOutputLength: PDF_LIMITS.streamBytes, finishFlush: zlibConstants.Z_SYNC_FLUSH });
    } catch {
      return null;
    }
  }
}

const refOf = (text, key) => {
  const m = new RegExp("/" + key + "\\s+(\\d+)\\s+\\d+\\s+R").exec(text);
  return m ? Number(m[1]) : null;
};

/** The text of `/Key << … >>` (balanced) or of the referenced object's dictionary. */
function dictOf(objects, text, key) {
  const at = new RegExp("/" + key + "\\s*(<<|\\d+\\s+\\d+\\s+R)").exec(text);
  if (!at) return "";
  if (at[1] === "<<") return balanced(text, at.index + at[0].length - 2);
  const num = Number(/^(\d+)/.exec(at[1])[1]);
  return objects.get(num)?.dict ?? "";
}

function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === "<" && text[i + 1] === "<") { depth++; i++; continue; }
    if (text[i] === ">" && text[i + 1] === ">") { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

/** "/Name 12 0 R" pairs of a resource dictionary. */
function namedRefs(dict) {
  const out = new Map();
  for (const m of dict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) out.set(m[1], Number(m[2]));
  return out;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const CP1252 = {
  0x80: "€", 0x82: "‚", 0x84: "„", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™",
};

/** Parses a ToUnicode CMap: code → string, plus the code width in bytes. */
export function parseCMap(text) {
  const map = new Map();
  let width = 1;
  const range = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (range) width = Math.max(1, Math.ceil(range[1].length / 2));
  const unicode = (hex) => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(-2), 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), unicode(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const from = parseInt(m[1], 16);
      const to = Math.min(parseInt(m[2], 16), from + 65535);
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]);
        for (let c = from; c <= to && c - from < items.length; c++) map.set(c, unicode(items[c - from]));
      } else {
        const base = m[3].slice(1, -1);
        const start = parseInt(base.slice(-4) || "0", 16);
        const prefix = unicode(base.slice(0, -4));
        for (let c = from; c <= to; c++) map.set(c, prefix + String.fromCharCode(start + (c - from)));
      }
    }
  }
  return { map, width };
}

function loadFont(objects, num, cache) {
  if (cache.has(num)) return cache.get(num);
  const dict = objects.get(num)?.dict ?? "";
  const type0 = /\/Subtype\s*\/Type0\b/.test(dict);
  let cmap = null;
  const toUnicode = refOf(dict, "ToUnicode");
  if (toUnicode !== null) {
    const data = decodeStream(objects.get(toUnicode) ?? {});
    if (data) cmap = parseCMap(data.toString("latin1"));
  }
  const font = { width: cmap ? cmap.width : type0 ? 2 : 1, map: cmap?.map ?? null };
  cache.set(num, font);
  return font;
}

function decodeText(bytes, font) {
  const width = font?.width ?? 1;
  let out = "";
  for (let i = 0; i + width <= bytes.length; i += width) {
    let code = 0;
    for (let j = 0; j < width; j++) code = code * 256 + bytes[i + j];
    const mapped = font?.map?.get(code);
    if (mapped !== undefined) out += mapped;
    else if (width === 1) out += CP1252[code] ?? String.fromCharCode(code);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content streams
// ---------------------------------------------------------------------------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Tokens of a content stream: { t: "num"|"name"|"str"|"arr"|"op", v }. */
function* tokens(data) {
  let i = 0;
  const n = data.length;
  const stack = [];
  const emit = function* (token) {
    if (stack.length) stack[stack.length - 1].push(token);
    else yield token;
  };
  while (i < n) {
    const c = data[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++; continue; }
    if (c === 0x28) {
      const bytes = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const b = data[i];
        if (b === 0x5c) {
          const e = data[i + 1];
          i += 2;
          if (e === 0x6e) bytes.push(0x0a);
          else if (e === 0x72) bytes.push(0x0d);
          else if (e === 0x74) bytes.push(0x09);
          else if (e === 0x62) bytes.push(0x08);
          else if (e === 0x66) bytes.push(0x0c);
          else if (e >= 0x30 && e <= 0x37) {
            let oct = e - 0x30;
            for (let k = 0; k < 2 && data[i] >= 0x30 && data[i] <= 0x37; k++) oct = oct * 8 + (data[i++] - 0x30);
            bytes.push(oct & 0xff);
          } else if (e === 0x0d) { if (data[i] === 0x0a) i++; }
          else if (e !== 0x0a && e !== undefined) bytes.push(e);
          continue;
        }
        if (b === 0x28) depth++;
        if (b === 0x29 && --depth === 0) { i++; break; }
        bytes.push(b);
        i++;
      }
      yield* emit({ t: "str", v: Uint8Array.from(bytes) });
      continue;
    }
    if (c === 0x3c && data[i + 1] === 0x3c) { i += 2; stack.push([]); continue; }
    if (c === 0x3e && data[i + 1] === 0x3e) { i += 2; const dict = stack.pop() ?? []; yield* emit({ t: "dict", v: dict }); continue; }
    if (c === 0x3c) {
      let hex = "";
      i++;
      while (i < n && data[i] !== 0x3e) { const ch = String.fromCharCode(data[i++]); if (/[0-9a-fA-F]/.test(ch)) hex += ch; }
      i++;
      if (hex.length % 2) hex += "0";
      yield* emit({ t: "str", v: Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)) });
      continue;
    }
    if (c === 0x5b) { i++; stack.push([]); continue; }
    if (c === 0x5d) { i++; const arr = stack.pop() ?? []; yield* emit({ t: "arr", v: arr }); continue; }
    if (c === 0x2f) {
      let name = "";
      i++;
      while (i < n && !WS.has(data[i]) && !DELIM.has(data[i])) name += String.fromCharCode(data[i++]);
      yield* emit({ t: "name", v: name });
      continue;
    }
    let word = "";
    while (i < n && !WS.has(data[i]) && !DELIM.has(data[i])) word += String.fromCharCode(data[i++]);
    if (!word) { i++; continue; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield* emit({ t: "num", v: Number(word) }); continue; }
    if (word === "BI") {
      // Inline image: skip to "EI" between white space.
      while (i < n - 2 && !(WS.has(data[i]) && data[i + 1] === 0x45 && data[i + 2] === 0x49 && (i + 3 >= n || WS.has(data[i + 3])))) i++;
      i += 3;
      continue;
    }
    yield* emit({ t: "op", v: word });
  }
}

function runContent(ctx, data, resources, depth) {
  if (depth > PDF_LIMITS.depth) return;
  const fontRefs = namedRefs(dictOf(ctx.objects, resources, "Font"));
  const xobjects = namedRefs(dictOf(ctx.objects, resources, "XObject"));
  let font = null;
  let operands = [];
  const newline = () => { if (ctx.out.length && !ctx.out[ctx.out.length - 1].endsWith("\n")) ctx.out.push("\n"); };
  const show = (bytes) => { if (ctx.size < PDF_LIMITS.text) { const s = decodeText(bytes, font); ctx.out.push(s); ctx.size += s.length; } };
  for (const token of tokens(data)) {
    if (token.t !== "op") { operands.push(token); continue; }
    const op = token.v;
    const last = operands[operands.length - 1];
    switch (op) {
      case "Tf": {
        const name = operands[operands.length - 2];
        const ref = name?.t === "name" ? fontRefs.get(name.v) : undefined;
        font = ref !== undefined ? loadFont(ctx.objects, ref, ctx.fonts) : null;
        break;
      }
      case "BT": case "ET": case "T*": newline(); break;
      case "Td": case "TD": {
        const ty = operands[operands.length - 1];
        if (ty?.t === "num" && Math.abs(ty.v) > 0.01) newline();
        break;
      }
      case "Tm": newline(); break;
      case "Tj": if (last?.t === "str") show(last.v); break;
      case "'": newline(); if (last?.t === "str") show(last.v); break;
      case "\"": newline(); if (last?.t === "str") show(last.v); break;
      case "TJ":
        if (last?.t === "arr") {
          for (const part of last.v) {
            if (part.t === "str") show(part.v);
            // A wide gap inside a line is a word break.
            else if (part.t === "num" && part.v < -250 && !/\s$/.test(ctx.out[ctx.out.length - 1] ?? "")) ctx.out.push(" ");
          }
        }
        break;
      case "Do": {
        const ref = last?.t === "name" ? xobjects.get(last.v) : undefined;
        const object = ref !== undefined ? ctx.objects.get(ref) : undefined;
        if (object && /\/Subtype\s*\/Form\b/.test(object.dict) && !ctx.visiting.has(ref)) {
          const inner = decodeStream(object);
          if (inner) {
            ctx.visiting.add(ref);
            const own = dictOf(ctx.objects, object.dict, "Resources");
            runContent(ctx, inner, own || resources, depth + 1);
            ctx.visiting.delete(ref);
          }
        }
        break;
      }
      default: break;
    }
    operands = [];
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function pageList(objects) {
  const pages = [];
  const seen = new Set();
  const walk = (num, depth) => {
    if (depth > PDF_LIMITS.depth || seen.has(num) || pages.length >= PDF_LIMITS.pages) return;
    seen.add(num);
    const dict = objects.get(num)?.dict ?? "";
    if (/\/Type\s*\/Page\b/.test(dict)) { pages.push(num); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? "";
    for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(m[1]), depth + 1);
  };
  for (const [, object] of objects) {
    if (!/\/Type\s*\/Catalog\b/.test(object.dict)) continue;
    const root = refOf(object.dict, "Pages");
    if (root !== null) walk(root, 0);
  }
  if (pages.length === 0) {
    for (const [num, object] of [...objects].sort((a, b) => a[0] - b[0])) {
      if (/\/Type\s*\/Page\b/.test(object.dict)) pages.push(num);
      if (pages.length >= PDF_LIMITS.pages) break;
    }
  }
  return pages;
}

/** /Resources of a page, inherited from its parents when the page has none. */
function pageResources(objects, num) {
  let current = num;
  for (let depth = 0; depth <= PDF_LIMITS.depth && current !== null; depth++) {
    const dict = objects.get(current)?.dict ?? "";
    const resources = dictOf(objects, dict, "Resources");
    if (resources) return resources;
    current = refOf(dict, "Parent");
  }
  return "";
}

function pageContents(objects, dict) {
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict);
  const refs = array ? [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [refOf(dict, "Contents")].filter((x) => x !== null);
  const parts = refs.map((ref) => decodeStream(objects.get(ref) ?? {})).filter(Boolean);
  return Buffer.concat(parts.flatMap((part) => [part, Buffer.from("\n")]));
}

/**
 * The text of a PDF, page by page.
 * @param {Buffer} buffer the whole file
 * @returns {{ text: string, pages: number, encrypted: boolean }}
 */
export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 1024).indexOf("%PDF-") < 0) return { text: "", pages: 0, encrypted: false };
  const { objects, src } = readObjects(buffer);
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(src.slice(-4096)) || [...objects.values()].some((o) => /\/Encrypt\s+\d+\s+\d+\s+R/.test(o.dict))) {
    return { text: "", pages: 0, encrypted: true };
  }
  const ctx = { objects, fonts: new Map(), out: [], size: 0, visiting: new Set() };
  const pages = pageList(objects);
  for (const num of pages) {
    const dict = objects.get(num)?.dict ?? "";
    runContent(ctx, pageContents(objects, dict), pageResources(objects, num), 0);
    ctx.out.push("\n\n");
    if (ctx.size >= PDF_LIMITS.text) break;
  }
  const text = ctx.out.join("")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, PDF_LIMITS.text);
  return { text, pages: pages.length, encrypted: false };
}

// ---------------------------------------------------------------------------
// Storyboard proposal through a language model
// ---------------------------------------------------------------------------

/** "0:05", "5", "5 s", "1:02:03" → seconds; anything else → null. */
export function parseSeconds(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 86_400 ? Math.round(value * 10) / 10 : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s*(s|sek|sec|sekunden|seconds)\.?$/i, "").replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(text)) return parseSeconds(Number(text));
  const parts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!parts) return null;
  const seconds = parts[3] !== undefined
    ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3])
    : Number(parts[1]) * 60 + Number(parts[2]);
  return parseSeconds(seconds);
}

const cut = (value, max) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").trim().slice(0, max);

/** One storyboard scene in the stored shape; null when it has nothing in it. */
export function cleanScene(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const n = Number(raw.n ?? raw.scene ?? raw.nr);
  let from = parseSeconds(raw.from ?? raw.start);
  let to = parseSeconds(raw.to ?? raw.end);
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  const scene = {
    n: Number.isInteger(n) && n >= 1 && n <= 999 ? n : index + 1,
    from, to,
    title: cut(raw.title, 200),
    content: cut(raw.content ?? raw.description, 2000),
    camera: cut(raw.camera, 500),
    overlay: cut(raw.overlay ?? raw.text, 500),
    goal: cut(raw.goal, 500),
    done: raw.done === true,
  };
  return scene.title || scene.content || scene.camera || scene.overlay ? scene : null;
}

export function cleanScenes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map((scene, i) => cleanScene(scene, i)).filter(Boolean);
}

/** The model's reply → scenes. Accepts a JSON array, {scenes:[…]}, code fences and chatter around it. */
export function parseSceneReply(content) {
  const text = String(content ?? "").replace(/```(?:json)?/gi, "").trim();
  const candidates = [];
  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  if (firstArray >= 0) candidates.push(text.slice(firstArray, text.lastIndexOf("]") + 1));
  if (firstObject >= 0) candidates.push(text.slice(firstObject, text.lastIndexOf("}") + 1));
  for (const candidate of candidates.sort((a, b) => b.length - a.length)) {
    try {
      const value = JSON.parse(candidate);
      const list = Array.isArray(value) ? value : Array.isArray(value?.scenes) ? value.scenes : null;
      if (list) return cleanScenes(list);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The text the model gets; long documents are cut. */
export const PROMPT_TEXT_MAX = 24_000;

export function storyboardMessages(text, lang = "de") {
  const de = lang === "de";
  const system = de
    ? "Du wandelst den Text eines Storyboards (aus einem PDF, oft zerstückelt) in Szenen um. Antworte NUR mit JSON, ohne Erklärung: "
      + "{\"scenes\":[{\"n\":1,\"from\":0,\"to\":5,\"title\":\"…\",\"content\":\"…\",\"camera\":\"…\",\"overlay\":\"…\",\"goal\":\"…\"}]}. "
      + "from/to = Sekunden (Zahl oder null), content = was im Bild passiert, camera = Kamerahinweis, overlay = eingeblendeter Text, "
      + "goal = Ziel der Szene. Fehlt etwas, leerer String. Erfinde nichts dazu, übernimm die Wörter des Dokuments."
    : "You turn the text of a storyboard (extracted from a PDF, often fragmented) into scenes. Answer ONLY with JSON, no explanation: "
      + "{\"scenes\":[{\"n\":1,\"from\":0,\"to\":5,\"title\":\"…\",\"content\":\"…\",\"camera\":\"…\",\"overlay\":\"…\",\"goal\":\"…\"}]}. "
      + "from/to = seconds (number or null), content = what happens in the picture, camera = camera hint, overlay = text shown on screen, "
      + "goal = purpose of the scene. Missing parts are empty strings. Do not invent anything; keep the document's words.";
  return [
    { role: "system", content: system },
    { role: "user", content: text.slice(0, PROMPT_TEXT_MAX) },
  ];
}

/** `…/v1` or `…/v1/chat/completions` → the chat completions URL. */
export function chatUrl(url) {
  const base = String(url ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/.test(base)) return base;
  return (/\/v1$/.test(base) ? base : base + "/v1") + "/chat/completions";
}

/**
 * Asks an OpenAI-compatible server for scenes.
 * @returns {Promise<{ ok: true, scenes: object[] } | { ok: false, error: string }>}
 */
export async function proposeScenes(text, { url, model = "", token = "", lang = "de", timeoutMs = 120_000, fetchImpl = fetch } = {}) {
  const endpoint = chatUrl(url);
  if (!endpoint) return { ok: false, error: "not-configured" };
  const body = {
    ...(model ? { model } : {}),
    messages: storyboardMessages(text, lang),
    temperature: 0.1,
    max_tokens: 4000,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: "http " + response.status };
    const reply = await response.json();
    const content = reply?.choices?.[0]?.message?.content ?? "";
    const scenes = parseSceneReply(content);
    if (!scenes) return { ok: false, error: "unreadable" };
    return { ok: true, scenes };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
  }
}
