"use strict";
const base = require("./base-ajv-config.cjs");
const roles = ["student", "teacher", "admin", "owner"];
const roleList = { type: "array", items: { type: "string", enum: roles }, minItems: 1, uniqueItems: true };
// OAS schema annotations: validate their SCHEMA values, retain metadata, emit no data assertion.
// oneOf/const/required remain the payload assertions. Server permissions are separate.
const vocabulary = [
  { keyword: "x-allowed-requester-roles", schemaType: "array", metaSchema: roleList },
  { keyword: "x-decision-roles", schemaType: "array", metaSchema: roleList },
  { keyword: "x-admin-requires", schemaType: "array", metaSchema: {
    type: "array", items: { type: "string", minLength: 1 }, minItems: 1, uniqueItems: true } },
  { keyword: "discriminator", schemaType: "object", metaSchema: { type: "object",
    properties: { propertyName: { type: "string", minLength: 1 },
      mapping: { type: "object", additionalProperties: { type: "string", minLength: 1 } } },
    required: ["propertyName"], patternProperties: { "^x-": {} }, additionalProperties: false } },
];
function createAjv(modulePath) {
  const ajv = base.createAjv(modulePath);
  for (const rule of vocabulary) {
    if (ajv.getKeyword(rule.keyword)) throw Error("ANNOTATION_VOCABULARY_COLLISION:" + rule.keyword);
    ajv.addKeyword(rule);
  }
  if (ajv.opts.strict !== true || ajv.opts.strictTypes !== true || ajv.opts.strictSchema !== true ||
    ajv.opts.validateFormats !== true) throw Error("STRICT_PROFILE_REQUIRED");
  return ajv;
}
function compileView(view) {
  const { rewriteSchema, resolve, checkDiscriminator } = require("./view-builder.cjs");
  for (const [name, schema] of Object.entries(view.$defs))
    rewriteSchema(schema, "#/$defs/" + name, (ref) => {
      if (!ref.startsWith("#/$defs/")) throw Error("DERIVED_LOCAL_REFERENCE_REQUIRED");
      resolve(view, ref); return ref;
    }, (s, p) => checkDiscriminator(view, s, p));
  const ajv = createAjv(), validators = new Map();
  ajv.addSchema(view);
  for (const name of Object.keys(view.$defs)) {
    const pointer = view.$id + "#/$defs/" + name.replace(/~/g, "~0").replace(/\//g, "~1");
    const validate = ajv.getSchema(pointer);
    if (!validate) throw Error("COMPONENT_NOT_COMPILED:" + name);
    validators.set(name, validate);
  }
  return { ajv, validators };
}
module.exports = { createAjv, compileView, options: base.options, formatOptions: base.formatOptions, vocabulary };
