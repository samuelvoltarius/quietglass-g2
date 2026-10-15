import { deflateSync } from "node:zlib";

/**
 * Builds a small PDF for the extractor tests: two pages, inherited resources,
 * a FlateDecode content stream, a Type0 font with a ToUnicode CMap (bfchar,
 * bfrange and the array form), a WinAnsi font stored in an object stream,
 * escapes (\( \) and octal) and a TJ array with a word gap.
 *
 * Page 1:  "Szene 1 (Intro)" / "Kamera: nah" / "ÜbcAfi"
 * Page 2:  "Seite 2: Grüße"
 */
export function makePdf({ encrypted = false, textless = false } = {}) {
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (chunk) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    size += buffer.length;
  };
  const object = (num, dict, stream = null) => {
    offsets[num] = size;
    if (stream === null) { push(`${num} 0 obj\n${dict}\nendobj\n`); return; }
    push(`${num} 0 obj\n${dict.replace(">>", ` /Length ${stream.length} >>`)}\nstream\n`);
    push(stream);
    push("\nendstream\nendobj\n");
  };

  const page1 = textless
    ? "q 100 0 0 100 0 0 cm /Im1 Do Q"
    : [
      "BT /F2 12 Tf 72 700 Td (Szene 1 \\(Intro\\)) Tj 0 -14 Td [(Kame) 10 (ra:) -600 (nah)] TJ ET",
      "BT /F1 12 Tf 72 650 Td <000300040005> Tj <0006 0007> Tj ET",
    ].join("\n");
  const page2 = textless ? "0 0 m 10 10 l S" : "BT /F2 10 Tf 72 700 Td (Seite 2: Gr\\374\\337e) Tj ET";
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "1 beginbfchar <0003> <00DC> endbfchar",
    "2 beginbfrange <0004> <0005> <0062> <0006> <0007> [<0041> <00660069>] endbfrange",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const font2 = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const objStm = "5 0 " + font2;

  push("%PDF-1.5\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R >>");
  object(4, "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 7 0 R >>");
  object(6, "<< /Filter /FlateDecode >>", deflateSync(Buffer.from(page1, "latin1")));
  object(7, "<< /Filter /FlateDecode >>", deflateSync(Buffer.from(cmap, "latin1")));
  object(8, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F2 5 0 R >> >> /Contents 10 0 R >>");
  object(9, `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>`, deflateSync(Buffer.from(objStm, "latin1")));
  object(10, "<< >>", Buffer.from(page2, "latin1"));
  if (encrypted) object(11, "<< /Filter /Standard /V 1 /R 2 >>");
  const xref = size;
  push(`xref\n0 12\n0000000000 65535 f \n`);
  for (let i = 1; i < 12; i++) push(String(offsets[i] ?? 0).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<< /Size 12 /Root 1 0 R${encrypted ? " /Encrypt 11 0 R" : ""} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}
