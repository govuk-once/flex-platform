// The shape of a gateway's directory: the modules it is generated from, and the generated
// directory beside them. Two build targets, kept apart because they are deployed separately:
// `runtime/` is what the gateway itself runs, `client/` is what a service calling it imports.
//
// gateway.config.ts       the configuration, named the same way for every gateway
// schemas.fixture.ts      the schemas it is generated from, where no driver derives them
// .gen/
//   runtime/
//     entry.js          the handler, wiring the configuration, validators and driver
//     validators/       compiled input and outcome validators
//       index.js        what the entry point imports them from
//     bundle.mjs        entry.js and everything it imports, bundled for deployment
//   client/
//     rpc.ts            the call contract, as types

export const CONFIG_FILE = "gateway.config.ts";
export const SCHEMAS_FILE = "schemas.fixture.ts";

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
