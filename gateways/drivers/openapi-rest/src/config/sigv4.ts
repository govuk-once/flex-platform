import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { GatewayError } from "@repo/gateway-runtime";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

import type { OpenApiRestAuth } from "./auth.ts";
import {
  isSecretField,
  type SecretField,
  type SecretValues,
  type Setting,
} from "./secret-field.ts";

// AWS Signature Version 4, for an upstream behind IAM authorisation: an API Gateway stage, say.
// Unlike a token, it is not a credential attached to a request but a signature over one, the
// method, the address, the headers and a hash of the body, which is why an authentication is
// shown the request it authenticates.
//
// The credentials are a role's that the upstream's owner grants the gateway's account, assumed
// through STS with the gateway's own: the role's ARN, and the external ID its trust policy may
// ask for, are fields of the secret the configuration names. What the assumed role may call is
// granted where it is defined. Its credentials are short-lived; they are held until shortly
// before they expire and assumed again then.

export interface SigV4Role {
  // The role to assume, from the secret.
  readonly arn: SecretField;
  // The value the role's trust policy asks for, where it asks for one: it guards the role
  // against a caller acting for someone else. From the secret.
  readonly externalId?: SecretField;
  // Who is calling, as it appears in the upstream's own audit trail. Written in the
  // configuration.
  readonly sessionName: string;
}

export interface SigV4Options {
  // What the upstream is, as AWS names it for signing: "execute-api" for an API Gateway stage.
  readonly service: string;
  // The region the upstream is in, which need not be the gateway's: written in the
  // configuration, or read from the secret where the upstream keeps it there.
  readonly region: Setting;
  readonly role: SigV4Role;
}

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

// What assuming a role is given, read from the secret on the request that needs it.
export interface AssumedRole {
  readonly arn: string;
  readonly externalId?: string;
  readonly sessionName: string;
  readonly region: string;
}

// What a test supplies in place of the platform's: credentials that STS did not issue, and a
// time that is not now.
export interface SigV4Deps {
  readonly assumeRole?: (role: AssumedRole) => () => Promise<Credentials>;
  readonly now?: () => Date;
}

// SDK-level bounds on one call to STS, as on a secret's retrieval. A request's attempt keeps its
// own deadline, but an assumption is shared by every request that waits for it and held until it
// settles: one that never did would leave each of them waiting on it until they timed out.
const CONNECTION_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

const assumeWithSts = (role: AssumedRole): (() => Promise<Credentials>) =>
  fromTemporaryCredentials({
    params: {
      RoleArn: role.arn,
      RoleSessionName: role.sessionName,
      ...(role.externalId === undefined ? {} : { ExternalId: role.externalId }),
    },
    clientConfig: {
      region: role.region,
      // Without throwOnRequestTimeout the SDK only logs a breach of requestTimeout.
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    },
  });

// How long before they expire credentials are assumed again: a request signed with ones about
// to lapse can be refused by the time it arrives.
const RENEW_BEFORE_MS = 5 * 60 * 1000;

// One role's credentials, assumed once and held until they are about to expire. Requests that
// arrive while they are being assumed wait for the same assumption; one that fails is not held,
// so the next request assumes the role again.
function heldCredentials(
  assume: () => Promise<Credentials>,
): () => Promise<Credentials> {
  let held: Credentials | undefined;
  let pending: Promise<Credentials> | undefined;
  return () => {
    const expiry = held?.expiration?.getTime();
    if (
      held !== undefined &&
      (expiry === undefined || expiry - Date.now() > RENEW_BEFORE_MS)
    ) {
      return Promise.resolve(held);
    }
    pending ??= assume()
      .then((credentials) => {
        held = credentials;
        return credentials;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

// The header a payload hash is written in. The signer takes the value already on a request as
// the hash rather than computing one from the body, so a request that carried its own would be
// signed over a body it did not send: a caller mapping this header and sending
// "UNSIGNED-PAYLOAD" would sign every body the same. It is the authentication's, so nothing
// else may set it, and it is taken off whatever reaches the signer.
const PAYLOAD_HASH = "x-amz-content-sha256";

// The headers a signature travels in. The session token is a role's; a long-lived key has none.
const OWNED = [
  "authorization",
  PAYLOAD_HASH,
  "x-amz-date",
  "x-amz-security-token",
];

// A query name an object literal reads as its prototype rather than as a name. The signer
// canonicalises a query through an ordinary object, so such a name would be left out of the
// signature while the request still carried it, and the upstream would check a signature over a
// query it did not receive. A null-prototype object here would not help: the loss is the
// signer's, which is not this driver's to change.
const UNSIGNABLE_QUERY = "__proto__";

// What this signs for. Signing is not one algorithm with a service name in it: S3 wants the
// payload hash in a header and its path left unnormalised, and others differ again. What is
// listed is what this was written for; another is added by implementing what it asks for rather
// than by naming it, so one that is merely named is refused.
const SERVICES: ReadonlySet<string> = new Set(["execute-api"]);

const NAME = /^[a-z0-9-]+$/;
// What STS accepts as a session name.
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

function checked(value: unknown, what: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new TypeError(
      `sigV4 auth: ${what} must be a name of lowercase letters, digits and hyphens`,
    );
  }
  return value;
}

function secretField(value: unknown, what: string): SecretField {
  if (!isSecretField(value)) {
    throw new TypeError(
      `sigV4 auth: ${what} must name the secret field that holds it, with fromSecret`,
    );
  }
  return value;
}

// A value the secret holds, read for one request. A required field is always there, since the
// secret is refused without it; a region is held to the shape of one, since the secret is not
// the configuration's to check. Failures name the field, never what it held.
function read(values: SecretValues, field: SecretField): string | undefined {
  return values.get(field);
}

// The signing itself, under whatever service name it is given: AWS publishes the examples this
// is checked against under names no upstream has. Not exported from the package, so a gateway
// reaches this only through `sigV4`, which is where a service is held to one this signs for.
export function sigV4With(
  options: SigV4Options,
  deps: SigV4Deps = {},
): OpenApiRestAuth {
  const service = checked(options.service, "service");
  const { region } = options;
  if (typeof region === "string") checked(region, "region");
  else secretField(region, "region");
  const arn = secretField(options.role?.arn, "role.arn");
  const externalId =
    options.role.externalId === undefined
      ? undefined
      : secretField(options.role.externalId, "role.externalId");
  const { sessionName } = options.role;
  if (typeof sessionName !== "string" || !SESSION_NAME.test(sessionName)) {
    throw new TypeError(
      "sigV4 auth: role.sessionName must be 2 to 64 letters, digits or any of + = , . @ _ -",
    );
  }
  const assume = deps.assumeRole ?? assumeWithSts;

  return {
    headers: OWNED,
    fields: [
      arn,
      ...(externalId === undefined ? [] : [externalId]),
      ...(typeof region === "string" ? [] : [region]),
    ],
    create: ({ secret }) => {
      // One held set of credentials for each role the secret has named: usually one, and a new
      // one when the secret is rotated to another role or another external ID.
      const roles = new Map<string, () => Promise<Credentials>>();
      const credentialsFor = (role: AssumedRole) => {
        const key = JSON.stringify([role.arn, role.externalId, role.region]);
        let credentials = roles.get(key);
        if (credentials === undefined) {
          credentials = heldCredentials(assume(role));
          roles.set(key, credentials);
        }
        return credentials;
      };

      return {
        // Credentials the upstream refused are assumed again, not held until they expire.
        refused: () => {
          roles.clear();
        },
        async headers({ method, url, headers, body }) {
          const values = await secret.get();
          const roleArn = read(values, arn);
          const signingRegion =
            typeof region === "string" ? region : read(values, region);
          if (roleArn === undefined || signingRegion === undefined) {
            throw new GatewayError(
              "INTERNAL",
              "sigV4 auth: the secret holds no role or no region to sign with",
            );
          }
          if (!NAME.test(signingRegion)) {
            throw new GatewayError(
              "INTERNAL",
              "sigV4 auth: the secret's region is not a region name",
            );
          }
          const external =
            externalId === undefined ? undefined : read(values, externalId);
          const signer = new SignatureV4({
            service,
            region: signingRegion,
            credentials: credentialsFor({
              arn: roleArn,
              ...(external === undefined ? {} : { externalId: external }),
              sessionName,
              region: signingRegion,
            }),
            sha256: Hash.bind(null, "sha256"),
            // The hash of the body is part of what is signed either way; the header that repeats
            // it is for services that ask for it, which an API Gateway stage does not.
            applyChecksum: false,
          });

          const query: Record<string, string | string[]> = {};
          for (const name of new Set(url.searchParams.keys())) {
            if (name === UNSIGNABLE_QUERY) {
              throw new TypeError(
                `sigV4 auth: a query parameter named "${UNSIGNABLE_QUERY}" cannot be signed, and a request carrying one would be refused`,
              );
            }
            const repeated = url.searchParams.getAll(name);
            query[name] =
              repeated.length === 1 ? (repeated[0] ?? "") : repeated;
          }
          // The host is signed, and is the transport's to send: it is named here so the
          // signature covers the one the request goes to. The payload hash is not taken from
          // what reached here; the signer computes it from the body below.
          const given: Record<string, string> = {
            ...Object.fromEntries(headers),
            host: url.host,
          };
          delete given[PAYLOAD_HASH];

          const signed = await signer.sign(
            {
              method,
              protocol: url.protocol,
              hostname: url.hostname,
              ...(url.port === "" ? {} : { port: Number(url.port) }),
              path: url.pathname,
              query,
              headers: given,
              ...(body === undefined ? {} : { body }),
            },
            deps.now === undefined ? {} : { signingDate: deps.now() },
          );

          const found = new Headers(signed.headers);
          return Object.fromEntries(
            OWNED.flatMap((name) => {
              const value = found.get(name);
              return value === null ? [] : [[name, value]];
            }),
          );
        },
      };
    },
  };
}

export function sigV4(options: SigV4Options): OpenApiRestAuth {
  const service = checked(options.service, "service");
  if (!SERVICES.has(service)) {
    throw new TypeError(
      `sigV4 auth: service "${service}" is not one this signs for (${[...SERVICES].join(", ")}): it puts the payload hash in the signature rather than in a header, and leaves the path to be normalised, neither of which every service accepts`,
    );
  }
  return sigV4With(options);
}
