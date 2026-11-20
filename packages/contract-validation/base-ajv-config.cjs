"use strict";
const fs = require("node:fs");
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats");
const { createRequire } = require("node:module");
const options = Object.freeze({
  strict: true, allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, unicodeRegExp: true, validateFormats: true,
});
const formatOptions = Object.freeze({
  mode: "full", formats: Object.freeze(["uuid", "date-time", "uri", "uri-reference"]),
  keywords: false,
});

// These literal imports let deployment tracing include the root production installation.
function createAjv() {
  if (require("ajv/package.json").version !== "8.20.0" ||
      require("ajv-formats/package.json").version !== "3.0.1") throw Error("PINNED_VALIDATOR_VERSION_REQUIRED");
  const pluginLoad = createRequire(require.resolve("ajv-formats/package.json"));
  if (fs.realpathSync(require.resolve("ajv/package.json")) !==
      fs.realpathSync(pluginLoad.resolve("ajv/package.json"))) throw Error("AJV_INSTALLATION_MISMATCH");
  const ajv = new Ajv2020({ ...options });
  addFormats(ajv, formatOptions);
  // Whole RFC string values: never trim a raw line terminator into validity.
  // The stock date-time whitespace separator also accepts a raw line break.
  for (const name of formatOptions.formats) {
    const def = ajv.formats[name];
    if (!def || def === true) throw Error("REAL_FORMAT_VALIDATOR_REQUIRED:" + name);
    const rule = def instanceof RegExp || typeof def === "function" ? def : def.validate;
    const test = rule instanceof RegExp ? (value) => rule.test(value) : rule;
    if (typeof test !== "function") throw Error("INVALID_FORMAT_DEFINITION:" + name);
    ajv.addFormat(name, { ...(typeof def === "object" && !(def instanceof RegExp) ? def : {}),
      type: "string", validate: (value) => !/[\r\n\u2028\u2029]/u.test(value) && test(value) });
  }
  return ajv;
}
module.exports = { createAjv, options, formatOptions };
