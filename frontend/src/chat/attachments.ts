/** Composer attachments: pure state for the chips (validated, uploading, ready, failed) and the
 * upload itself. Errors are plain words; the server's codes map onto the same sentences. */
import type { AttachmentRules, Media, MessageAttachment } from "./types";

export interface FileLike { name: string; size: number; type: string }

export interface AttChip {
  key: string;
  name: string;
  size: number;
  type: string;
  status: "uploading" | "ready" | "error";
  /** 0–100 while uploading. */
  progress: number;
  /** Short chip text ("Too large") and the full sentence for the alert line. */
  short?: string;
  error?: string;
  media?: Media;
}

export const DEFAULT_RULES: AttachmentRules = {
  images: false, pdf: false, max_per_message: 4, max_mb: 20,
  types: ["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf"],
};

const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heic", pdf: "application/pdf" };

/** Browsers often leave HEIC (and sometimes PDF) types empty: fall back to the extension. */
export function kindOf(f: FileLike): string {
  const t = f.type.toLowerCase();
  if (t === "image/heif") return "image/heic";
  if (t) return t;
  return EXT[f.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

export const isPdf = (type: string) => type === "application/pdf";
export const isImage = (type: string) => type.startsWith("image/");

export function canAttach(r: AttachmentRules | undefined): boolean {
  return !!r && (r.images || r.pdf);
}

/** The file input's accept list for what the server takes right now. */
export function acceptOf(r: AttachmentRules): string {
  return r.types.filter((t) => (isPdf(t) ? r.pdf : r.images)).concat(r.images ? [".heic"] : []).join(",");
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function allowedWords(r: AttachmentRules) {
  if (r.images && r.pdf) return "a PNG, JPEG, WebP or HEIC image, or a PDF";
  if (r.pdf) return "a PDF (this assistant can't look at images)";
  return "a PNG, JPEG, WebP or HEIC image";
}

/** null when the file may be uploaded; otherwise [chip text, sentence]. */
export function validate(f: FileLike, r: AttachmentRules): [string, string] | null {
  const type = kindOf(f);
  const known = r.types.includes(type);
  if (!known || (isPdf(type) && !r.pdf) || (isImage(type) && !r.images)) {
    if (known && isImage(type)) return ["Images off", `${f.name}: this assistant can't look at images. PDFs still work.`];
    return ["Not supported", `${f.name} can't be attached. Attach ${allowedWords(r)}.`];
  }
  if (f.size === 0) return ["Empty", `${f.name} is empty.`];
  if (f.size > r.max_mb * 1024 * 1024) return ["Too large", `${f.name} is ${sizeText(f.size)}; the limit is ${r.max_mb} MB.`];
  return null;
}

/** Server refusals in the same plain words. */
export function serverError(name: string, status: number, code: string): [string, string] {
  switch (code) {
    case "too_large": return ["Too large", `${name} is over the size limit.`];
    case "unsupported_type": return ["Not supported", `${name} isn't an image or PDF the assistant can read.`];
    case "unreadable": return ["Unreadable", `${name} couldn't be read. Is the file damaged?`];
    case "empty_file": return ["Empty", `${name} is empty.`];
    case "pdf_encrypted": return ["Locked PDF", `${name} is password-protected. Save an unlocked copy and attach that.`];
    case "rate_limited": return ["Wait a moment", "Too many uploads in a minute. Wait a moment and attach it again."];
    default:
      if (status === 413) return ["Too large", `${name} is over the size limit.`];
      if (status === 0) return ["Not sent", `${name} didn't upload: the server didn't respond.`];
      return ["Failed", `${name} didn't upload (${code || status}).`];
  }
}

export type AttAction =
  | { type: "add"; files: (FileLike & { key: string })[]; rules: AttachmentRules; /** "per message" by default. */ per?: string }
  | { type: "progress"; key: string; progress: number }
  | { type: "done"; key: string; media: Media }
  | { type: "fail"; key: string; short: string; error: string }
  | { type: "remove"; key: string }
  | { type: "clear" };

export interface AttState { chips: AttChip[]; /** The latest refusal not tied to a chip ("At most 4"). */ notice: string | null }

export const EMPTY: AttState = { chips: [], notice: null };

export function attReducer(s: AttState, a: AttAction): AttState {
  switch (a.type) {
    case "add": {
      const chips = [...s.chips];
      let notice: string | null = null;
      for (const f of a.files) {
        if (chips.length >= a.rules.max_per_message) {
          notice = `At most ${a.rules.max_per_message} files ${a.per ?? "per message"}.`;
          break;
        }
        const bad = validate(f, a.rules);
        chips.push({ key: f.key, name: f.name, size: f.size, type: kindOf(f), progress: 0,
          ...(bad ? { status: "error", short: bad[0], error: bad[1] } : { status: "uploading" }) });
      }
      return { chips, notice };
    }
    case "progress":
      return { ...s, chips: s.chips.map((c) => (c.key === a.key && c.status === "uploading" ? { ...c, progress: Math.max(c.progress, Math.min(99, a.progress)) } : c)) };
    case "done":
      return { ...s, chips: s.chips.map((c) => (c.key === a.key ? { ...c, status: "ready", progress: 100, media: a.media, type: a.media.media_type || c.type } : c)) };
    case "fail":
      return { ...s, chips: s.chips.map((c) => (c.key === a.key ? { ...c, status: "error", short: a.short, error: a.error } : c)) };
    case "remove":
      return { chips: s.chips.filter((c) => c.key !== a.key), notice: null };
    case "clear":
      return EMPTY;
  }
}

/** Uploads still running hold Send back; failed chips are simply not sent. */
export const uploading = (s: AttState) => s.chips.some((c) => c.status === "uploading");
export const readyMedia = (s: AttState) => s.chips.filter((c) => c.status === "ready" && c.media).map((c) => c.media!);
export const briefOf = (m: Media): MessageAttachment => ({ id: m.id, filename: m.filename, media_type: m.media_type, pages: m.pages ?? null, url: m.url });

/** Chip meta text: progress while uploading, page count for PDFs, else the size. */
export function chipMeta(c: AttChip): string {
  if (c.status === "uploading") return `${Math.round(c.progress)}%`;
  if (c.status === "error") return c.short ?? "Failed";
  const pages = c.media?.pages;
  if (isPdf(c.type) && pages) return `${pages} ${pages === 1 ? "page" : "pages"}`;
  return sizeText(c.media?.size ?? c.size);
}

/** XHR (not fetch) so the chip can show upload progress. Resolves with the stored file. */
export function upload(file: File, threadId: string, onProgress: (pct: number) => void): { promise: Promise<Media>; abort: () => void } {
  return uploadTo("/api/chat/attachments", file, { thread_id: threadId }, onProgress);
}

/** `upload` for any multipart endpoint that answers with a stored media file. */
export function uploadTo(url: string, file: File, fields: Record<string, string>, onProgress: (pct: number) => void): { promise: Promise<Media>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Media>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    xhr.open("POST", url);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress((e.loaded / e.total) * 100); };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve(body as Media);
      else {
        reject({ status: xhr.status, code: body?.code || "" });
      }
    };
    xhr.onerror = () => reject({ status: 0, code: "" });
    xhr.onabort = () => reject({ status: -1, code: "aborted" });
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
