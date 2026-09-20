// The shape of a gateway's directory: the modules it is generated from, and the generated
// directory beside them. Two build targets, kept apart because they are deployed separately:
// `runtime/` is what the gateway itself runs, `client/` is what a service calling it imports.
//
// gateway.config.ts       the configuration, named the same way for every gateway
// schemas/                the schemas it is generated from, one file for each version
//   0001.json             the first version; the highest number is the one generated from
// .gen/
//   runtime/
//     entry.js          the handler, wiring the configuration, validators and driver
//     validators/       compiled input and outcome validators
//       index.js        what the entry point imports them from
//     bundle.mjs        entry.js and everything it imports, bundled for deployment
//   client/
//     rpc.ts            the call contract, as types

export const CONFIG_FILE = "gateway.config.ts";

// The versions of a gateway's schemas, kept beside its configuration. JSON rather than a module:
// a version is data to be parsed, never code to be evaluated, and one written once is history,
// which a type keyed by today's operations could not go on checking.
export const SCHEMAS_DIR = "schemas";

// Everything a gateway generates, beside the configuration it was generated from.
export const GENERATED_DIR = ".gen";

export const RUNTIME_DIR = "runtime";
export const CLIENT_DIR = "client";

export const VALIDATORS_DIR = "validators";
export const VALIDATORS_MODULE = "index.js";
export const ENTRY_MODULE = "entry.js";
export const BUNDLE_MODULE = "bundle.mjs";
export const CONTRACT_MODULE = "rpc.ts";

// The gateway configuration, as the entry point reaches it from inside the runtime directory:
// up through it and the generated directory.
export const CONFIG_MODULE = `../../${CONFIG_FILE}`;
