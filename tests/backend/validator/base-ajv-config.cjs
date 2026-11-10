"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const options = Object.freeze({
  strict: true, allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, unicodeRegExp: true, validateFormats: true,
});
const formatOptions = Object.freeze({
  mode: "full", formats: Object.freeze(["uuid", "date-time", "uri", "uri-reference"]),
  keywords: false,
});

function createAjv(modulePath = path.join(__dirname, "tooling/node_modules/ajv/dist/2020.js")) {
  const moduleFile = path.resolve(modulePath), load = createRequire(moduleFile);
  if (load("ajv/package.json").version !== "8.20.0" ||
      load("ajv-formats/package.json").version !== "3.0.1") throw Error("PINNED_VALIDATOR_VERSION_REQUIRED");
  const pluginLoad = createRequire(load.resolve("ajv-formats/package.json"));
  if (fs.realpathSync(load.resolve("ajv/package.json")) !==
      fs.realpathSync(pluginLoad.resolve("ajv/package.json"))) throw Error("AJV_INSTALLATION_MISMATCH");
  const Ajv2020 = load(moduleFile).default, addFormats = load("ajv-formats");
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
