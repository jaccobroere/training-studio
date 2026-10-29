import { describe, expect, it } from "vitest";
import { uploadError, uploadSizeError } from "./upload";

describe("upload limits", () => {
  it("accepts exactly 100 MiB but rejects one byte over before sending", () => {
    expect(uploadSizeError(104857599)).toBeNull();
    expect(uploadSizeError(104857600)).toBeNull();
    expect(uploadSizeError(104857601)).toContain("100 MiB");
  });
  it.each(["", "Request Entity Too Large", "<html>413</html>", '{"detail":{"code":"too_large"}}'])(
    "handles any edge 413 body: %s", (body) => {
      expect(uploadError(413, body)).toContain("100 MiB");
    },
  );
  it.each(["plain", "<html>502</html>", "", "null", "[]", '{"detail":{"detail":42}}'])(
    "safely handles other errors: %s", (body) => {
      expect(uploadError(502, body)).toBe("Upload failed. Try again.");
    },
  );
  it("preserves a structured backend error message", () => {
    expect(uploadError(422, '{"code":"unsupported_file","detail":"Upload a ZIP or FIT"}')).toBe("Upload a ZIP or FIT");
  });
});
