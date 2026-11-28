// Signs the one request a pipeline may make of the bucket: a PUT of one bundle to its key. The
// pipeline holds no AWS credentials. It is given an address that carries the function's role's
// signature, which S3 accepts for five minutes and for nothing but the request signed.

import type { Credentials } from "@repo/lambda-function";
import { heldValue } from "@repo/utils/held-value";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

import type { Bundle } from "./bundle.ts";
import type { CiUploads } from "./types.ts";

/** How long a pipeline has to start its upload. */
export const UPLOAD_EXPIRES_SECONDS = 300;

export interface SignedUpload {
  /** Where to `PUT` the bundle. Whoever holds it can make the upload, so it is never logged. */
  readonly url: string;
  /** The headers the upload must carry, exactly, beside the length an HTTP client sets itself. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
}

export type SignUpload = (key: string, bundle: Bundle) => Promise<SignedUpload>;

export interface UploadSignerOptions {
  readonly uploads: CiUploads;
  /** Called for each upload, since the role's credentials are rotated. */
  readonly credentials: () => Credentials;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}

// The signature covers three headers, so S3 refuses an upload that differs in any of them:
//
//   content-length          the bundle's length, so no other length is accepted
//   x-amz-checksum-sha256   the bundle's hash, which S3 checks the body against, so the object
//                           under a key is the bundle the key names
//   if-none-match: *        S3 writes only where there is no object, so a bundle is never replaced
//
// The checksum stays a header, which the signer would otherwise move into the address: as a
// signed header the upload must send it, and S3 checks the body against what is sent.
export function createUploadSigner(options: UploadSignerOptions): SignUpload {
  const { bucket, region } = options.uploads;
  const host = `${bucket}.s3.${region}.amazonaws.com`;

  return async (key, bundle) => {
    const checksum = Buffer.from(bundle.sha256, "hex").toString("base64");
    const required = {
      "if-none-match": "*",
      "x-amz-checksum-sha256": checksum,
    };

    const signer = new SignatureV4({
      service: "s3",
      region,
      credentials: options.credentials(),
      sha256: Hash.bind(null, "sha256"),
      // S3 takes a key as it is written, so the path is escaped once, not twice.
      uriEscapePath: false,
      applyChecksum: false,
    });
    const signed = await signer.presign(
      {
        method: "PUT",
        protocol: "https:",
        hostname: host,
        path: `/${key}`,
        query: {},
        headers: {
          host,
          "content-length": String(bundle.size),
          ...required,
          // The body isn't signed: it is the bundle, which the function never sees. The checksum
          // above is what holds it.
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
      },
      {
        expiresIn: UPLOAD_EXPIRES_SECONDS,
        signingDate: new Date(options.now()),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );

    return {
      url: `https://${host}/${key}?${queryString(signed.query ?? {})}`,
      headers: required,
      expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
    };
  };
}

// As Signature Version 4 escapes a query: everything but unreserved characters.
function queryString(query: Record<string, unknown>): string {
  return Object.entries(query)
    .flatMap(([name, value]) =>
      typeof value === "string" ? [`${escape(name)}=${escape(value)}`] : [],
    )
    .join("&");
}

// What `encodeURIComponent` leaves as it is and Signature Version 4 escapes.
const ESCAPED: ReadonlyMap<string, string> = new Map([
  ["!", "%21"],
  ["'", "%27"],
  ["(", "%28"],
  [")", "%29"],
  ["*", "%2A"],
]);

function escape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    heldValue(ESCAPED, character),
  );
}
