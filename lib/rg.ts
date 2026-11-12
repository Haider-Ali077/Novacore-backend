// RG (Requirement Gathering) documents: reading the uploaded file into text. DOCX is read with jszip,
// PDF with pdfjs-dist (its Node build; only the text layer, so a scanned PDF has nothing to read), and
// plain text and Markdown as UTF-8. The old binary .doc is refused with a clear message.
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { all, insert, now, type RgDocument } from "./db";

export type RgUpload = { filename?: string; contentType?: string; data?: string; text?: string };
export type RgText = { filename: string; contentType: string; size: number; sha256: string; file: Uint8Array | null; text: string };

export class RgError extends Error {}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MIN_TEXT_CHARS = 40;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Turns an upload (base64 file) or pasted RG text into plain text the analyst can read. */
export async function readRg(upload: RgUpload): Promise<RgText> {
  let rg: RgText;
  if (upload.data) {
    const filename = (upload.filename ?? "rg").trim() || "rg";
    const bytes = Uint8Array.from(Buffer.from(upload.data, "base64"));
    if (!bytes.length) throw new RgError("The RG file is empty.");
    if (bytes.length > MAX_FILE_BYTES) throw new RgError("The RG file is larger than 10 MB.");
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    let text: string;
    let contentType: string;
    if (ext === "docx" || isZip(bytes)) {
      text = await docxText(bytes);
      contentType = DOCX;
    } else if (ext === "pdf" || startsWith(bytes, "%PDF")) {
      text = await pdfText(bytes);
      contentType = "application/pdf";
    } else if (ext === "doc" || startsWith(bytes, "\xD0\xCF\x11\xE0")) {
      throw new RgError("Old Word files (.doc) cannot be read. Save the RG as .docx or paste its text.");
    } else if (["txt", "md", "markdown", "text"].includes(ext)) {
      text = new TextDecoder("utf-8").decode(bytes);
      contentType = ext === "txt" || ext === "text" ? "text/plain" : "text/markdown";
    } else {
      throw new RgError("Upload the RG as .docx, .pdf, .txt or .md, or paste its text.");
    }
    rg = { filename, contentType, size: bytes.length, sha256: sha256(bytes), file: bytes, text: tidy(text) };
  } else {
    const text = tidy(upload.text ?? "");
    const bytes = Buffer.from(text, "utf8");
    rg = { filename: "Pasted RG text", contentType: "text/plain", size: bytes.length, sha256: sha256(bytes), file: null, text };
  }
  if (rg.text.length < MIN_TEXT_CHARS) throw new RgError("The RG has almost no readable text. Check the file, or paste the RG text instead.");
  if (rg.text.length > MAX_TEXT_CHARS) throw new RgError(`The RG has ${rg.text.length.toLocaleString()} characters of text; the limit is ${MAX_TEXT_CHARS.toLocaleString()}. Remove appendices that are not about the form.`);
  return rg;
}

export function saveRg(requirementId: number, rg: RgText) {
  return insert(
    "INSERT INTO rg_documents (requirement_id, filename, content_type, size, sha256, file, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    requirementId, rg.filename, rg.contentType, rg.size, rg.sha256, rg.file as never, rg.text, now(),
  );
}

/**
 * Several attachments (and pasted text) read together. Any file that cannot be read stops the start,
 * naming the file, so nothing is analyzed from a partial RG without the user knowing.
 */
export async function readRgs(uploads: RgUpload[] = [], text = ""): Promise<RgText[]> {
  const docs: RgText[] = [];
  const failed: string[] = [];
  for (const u of uploads) {
    try {
      docs.push(await readRg(u));
    } catch (e) {
      failed.push(`"${u.filename ?? "file"}": ${(e as Error).message}`);
    }
  }
  if (failed.length) throw new RgError(`These attachments could not be read: ${failed.join(" ")} Remove or replace them and try again.`);
  if (text.trim()) docs.push(await readRg({ text }));
  const total = docs.reduce((n, d) => n + d.text.length, 0);
  if (total > MAX_TEXT_CHARS) throw new RgError(`The attachments have ${total.toLocaleString()} characters of text together; the limit is ${MAX_TEXT_CHARS.toLocaleString()}.`);
  return docs;
}

/** Extraction status per attachment, before anything is created: what the page shows next to each file. */
export async function previewRgs(uploads: RgUpload[] = []) {
  return Promise.all(
    uploads.map(async (u) => {
      try {
        const rg = await readRg(u);
        return { filename: rg.filename, ok: true, characters: rg.text.length, contentType: rg.contentType };
      } catch (e) {
        return { filename: u.filename ?? "file", ok: false, error: (e as Error).message };
      }
    }),
  );
}

/** One text for the analyst. A single document stays exactly as it was read. */
export function combineRg(docs: { filename: string; text: string }[]) {
  if (docs.length === 1) return { filename: docs[0].filename, text: docs[0].text };
  return {
    filename: `${docs.length} documents: ${docs.map((d) => d.filename).join(", ")}`.slice(0, 200),
    text: docs.map((d, i) => `=== Attachment ${i + 1} of ${docs.length}: ${d.filename} ===\n${d.text}`).join("\n\n"),
  };
}

/** The RG a requirement started from: all its attachments combined. The analysis is kept on the first one. */
export function rgOf(requirementId: number): (RgDocument & { documents: number }) | undefined {
  const docs = all<RgDocument>(
    "SELECT id, requirement_id, filename, content_type, size, sha256, text, analysis_json, created_at FROM rg_documents WHERE requirement_id = ? ORDER BY id",
    requirementId,
  );
  if (!docs.length) return undefined;
  const { filename, text } = combineRg(docs);
  return { ...docs[0], filename, text, size: docs.reduce((n, d) => n + d.size, 0), documents: docs.length };
}

export function rgList(requirementId: number) {
  return all<Omit<RgDocument, "text">>(
    "SELECT id, requirement_id, filename, content_type, size, sha256, analysis_json, created_at FROM rg_documents WHERE requirement_id = ? ORDER BY id",
    requirementId,
  );
}

/**
 * Word body text in reading order. Paragraphs become lines; a table becomes Markdown-style rows so
 * the analyst still sees which value belongs to which column. Headers, footers and comments are left out.
 */
async function docxText(bytes: Uint8Array): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new RgError("The file is not a readable Word document. Save it again as .docx, or paste the RG text.");
  }
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new RgError("The file is not a Word document (word/document.xml is missing).");
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) =>
    `\n${[...table.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)]
      .map((row) => `| ${[...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) => paragraphs(cell[0]).join(" / ").replace(/\|/g, "/")).join(" | ")} |`)
      .join("\n")}\n`,
  );
  return paragraphs(body).join("\n");
}

function paragraphs(xml: string): string[] {
  return xml
    .split(/<\/w:p>/)
    .map((p) => {
      const listItem = /<w:numPr>/.test(p) ? "- " : "";
      const text = p
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "")
        .replace(/<[^>]+>/g, "");
      return listItem + decode(text);
    })
    .map((t) => t.replace(/[ \t]+$/g, ""))
    .filter((t) => t.trim());
}

/**
 * The text layer of a PDF, page by page. Lines keep their breaks; pages are separated by a blank line.
 * A scanned PDF has no text layer and is refused with that reason, never passed on as an empty RG.
 */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // A copy: pdf.js takes over the buffer it is given. The loading task owns the worker and is destroyed at the end.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 });
  let doc: import("pdfjs-dist/types/src/display/api").PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    if ((e as { name?: string }).name === "PasswordException") throw new RgError("The PDF is password-protected. Remove the password, or paste the RG text.");
    throw new RgError("The file is not a readable PDF. Save it again, or paste the RG text.");
  }
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push(text.trim());
      page.cleanup();
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (text.replace(/\s/g, "").length < 40) {
      throw new RgError("This PDF has no readable text; it is probably a scan. Save the RG as .docx, or paste its text.");
    }
    return text;
  } finally {
    await task.destroy();
  }
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

const tidy = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const startsWith = (b: Uint8Array, sig: string) => [...sig].every((c, i) => b[i] === c.charCodeAt(0));
