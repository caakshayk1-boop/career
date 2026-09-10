/**
 * r2.mjs — put an object in Cloudflare R2 over its S3-compatible endpoint.
 *
 * WHY AUDIO IS NOT IN GIT. Three briefings a day at roughly 3MB is 60MB a week,
 * and git keeps every byte forever — deleting the file on day eight frees
 * nothing. A "rolling 7-day site" would carry a 3GB history by next September
 * and every CI checkout would pay for it. Object storage is the correct place
 * for a blob with a lifetime.
 *
 * WHY SIGV4 BY HAND. The alternative is @aws-sdk/client-s3, which is ~15MB of
 * transitive dependencies installed on every CI run to sign one PUT. The
 * signing algorithm is a fixed, published spec; this is the whole of it for the
 * single-request, known-payload case.
 */
import { createHash, createHmac } from "node:crypto";
import { cfg } from "../config.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();

export const r2Configured = () => Boolean(cfg.r2Account && cfg.r2Bucket && cfg.r2KeyId && cfg.r2Secret);

/**
 * @returns {Promise<string>} the public URL of the stored object
 */
export async function putObject(key, body, contentType) {
  if (!r2Configured()) throw new Error("R2 is not configured");

  const host = `${cfg.r2Account}.r2.cloudflarestorage.com`;
  const path = `/${cfg.r2Bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  /* R2 ignores the region but SigV4 requires one in the scope string, and the
     signature is computed over it — "auto" is what Cloudflare documents. */
  const region = "auto", service = "s3";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  /* Headers must be signed in lowercase alphabetical order, and every signed
     header must actually be sent. Getting this list out of sync with the
     request headers below is the classic SignatureDoesNotMatch. */
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [
    "PUT", path, "",
    `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, "",
    signed, payloadHash,
  ].join("\n");

  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key0 = hmac(`AWS4${cfg.r2Secret}`, dateStamp);
  const signature = createHmac("sha256", hmac(hmac(hmac(key0, region), service), "aws4_request"))
    .update(toSign).digest("hex");

  const res = await fetch(`https://${host}${path}`, {
    method: "PUT",
    headers: {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      "content-type": contentType,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.r2KeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);

  /* R2_PUBLIC_BASE is the r2.dev URL or a custom domain bound to the bucket.
     Without it the object is stored but unreachable, which is a configuration
     error worth failing loudly on rather than returning a URL that 403s. */
  if (!cfg.r2PublicBase) throw new Error("R2_PUBLIC_BASE is not set — the object was stored but has no public URL");
  return `${cfg.r2PublicBase}/${key}`;
}
