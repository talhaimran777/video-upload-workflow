import crypto from "crypto";

const ALGO = "aes-256-gcm";

function encryptionKey() {
  const s = process.env.YOUTUBE_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "YOUTUBE_SESSION_SECRET must be set to at least 32 characters"
    );
  }
  return crypto.createHash("sha256").update(s, "utf8").digest();
}

export function sealRefreshToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function unsealRefreshToken(blob) {
  if (!blob || typeof blob !== "string") {
    return null;
  }
  try {
    const buf = Buffer.from(blob, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return (
      decipher.update(data, undefined, "utf8") + decipher.final("utf8")
    );
  } catch {
    return null;
  }
}
