const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TOO_LARGE = "Upload too large. Choose a ZIP or FIT file of 100 MiB or less.";

export function uploadSizeError(size: number): string | null {
  return size > MAX_UPLOAD_BYTES ? UPLOAD_TOO_LARGE : null;
}

export function uploadError(status: number, body: string): string {
  // Caddy may send plain text, HTML or nothing: status takes precedence over JSON.
  if (status === 413) return UPLOAD_TOO_LARGE;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "detail" in parsed && typeof parsed.detail === "string") {
      return parsed.detail;  // the error envelope's copy
    }
  } catch {
    // Proxy/network errors need not contain JSON.
  }
  return "Upload failed. Try again.";
}
