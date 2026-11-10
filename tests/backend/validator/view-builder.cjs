"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PINNED = new Set(["49defb7dcdf455a6daf26e1354f890d309b3eabd8604b61d33172edbc555e010",
  "f6226aa1cea63ae1fbc603b80aed9232bc4dd5213c4cc081cc13300ee0179b28", // exchange-only PROVISIONAL review
  "280503a6a306c62e60dacea8a067137b37bcde151e6c2101d0beb4cbe09a25eb",
  "882f3b9fd8e3693903f1af44deadb6535ae97132ddff01f3f4622caf580d63f6",
  "9c7518f887aafacc5cf53b73d33a87d42b11a9fcd46730185b39360e62fe3bb4"]);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const enc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
function resolve(doc, ref) {
  assert.ok(ref.startsWith("#/"), "LOCAL_REFERENCE_REQUIRED");
  return decodeURIComponent(ref.slice(2)).split("/").reduce((v, k) => {
    const key = k.replace(/~1/g, "/").replace(/~0/g, "~");
    assert.ok(v !== null && typeof v === "object" && Object.hasOwn(v, key), "UNRESOLVED_REFERENCE:" + ref);
    return v[key];
  }, doc);
}
const maps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singles = ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "items",
  "unevaluatedItems", "not", "if", "then", "else", "contentSchema"];

// Visit schema positions only. Literal/example/default/enum/x-* objects are data.
function rewriteSchema(schema, pointer, mapRef, onDiscriminator = () => {}) {
  if (typeof schema === "boolean") return schema;
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), "SCHEMA_OBJECT_REQUIRED");
  for (const keyword of ["$id", "$dynamicRef", "$recursiveRef", "$anchor", "$dynamicAnchor"])
    assert.ok(!Object.hasOwn(schema, keyword), "SCOPED_REFERENCE_REVIEW_REQUIRED:" + pointer + "/" + keyword);
  const out = structuredClone(schema);
  if (Object.hasOwn(schema, "$ref")) out.$ref = mapRef(schema.$ref, pointer + "/$ref", "schema_ref");
  if (Object.hasOwn(schema, "discriminator")) {
    onDiscriminator(schema, pointer);
    for (const [tag, ref] of Object.entries(schema.discriminator.mapping || {}))
      out.discriminator.mapping[tag] = mapRef(ref, pointer + "/discriminator/mapping/" + enc(tag), "discriminator_mapping", tag);
  }
  for (const key of maps) if (Object.hasOwn(schema, key)) {
    out[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, child]) =>
      [name, rewriteSchema(child, pointer + "/" + key + "/" + enc(name), mapRef, onDiscriminator)]));
  }
  for (const key of arrays) if (Object.hasOwn(schema, key))
    out[key] = schema[key].map((child, i) => rewriteSchema(child, pointer + "/" + key + "/" + i, mapRef, onDiscriminator));
  for (const key of singles) if (Object.hasOwn(schema, key))
    out[key] = rewriteSchema(schema[key], pointer + "/" + key, mapRef, onDiscriminator);
  return out;
}

function checkDiscriminator(doc, schema, pointer) {
  const d = schema.discriminator;
  assert.ok(d && typeof d.propertyName === "string" && d.propertyName, "DISCRIMINATOR_PROPERTY_REQUIRED");
  assert.ok(Array.isArray(schema.oneOf), "PINNED_DISCRIMINATOR_ONEOF_REQUIRED");
  const branches = schema.oneOf.map((s) => s.$ref), mapped = Object.values(d.mapping || {});
  assert.deepEqual([...mapped].sort(), [...branches].sort(), "MAPPING_MUST_COVER_SAME_EXPLICIT_BRANCHES");
  for (const [tag, ref] of Object.entries(d.mapping)) {
    const target = resolve(doc, ref), property = target.properties?.[d.propertyName];
    assert.ok(target.required?.includes(d.propertyName), "DISCRIMINATOR_TAG_NOT_REQUIRED:" + pointer);
    assert.ok(property?.const === tag || property?.enum?.includes(tag), "DISCRIMINATOR_TAG_TARGET_MISMATCH:" + tag);
  }
}

const TYPE_PLAN = [];
function propertyType(name, branch, property, type, keyword) {
  TYPE_PLAN.push({ target: "#/components/schemas/" + name + branch + "/properties/" + property,
    anchor: "#/components/schemas/" + name + "/properties/" + property + "/type", type, keyword,
    proof: "UNCONDITIONAL_SAME_PROPERTY_TYPE", component: name, branch, property });
}
propertyType("Profile", "/allOf/0/if", "roles", "array", "contains");
for (const [i, props, keyword] of [[0, ["questions", "answers"], "maxItems"],
  [1, ["questions"], "minItems"], [2, ["questions", "answers"], "maxItems"],
  [3, ["questions", "answers"], "maxItems"], [4, ["questions", "answers"], "maxItems"]])
  for (const property of props) propertyType("Attempt", "/allOf/" + i + "/then", property, "array", keyword);
TYPE_PLAN.push({ target: "#/components/schemas/DetailedReview/properties/gate/allOf/1",
  anchor: "#/components/schemas/ReviewGate/type", type: "object", keyword: "properties",
  proof: "UNCONDITIONAL_SIBLING_ALLOF_REFERENCE", component: "DetailedReview" });
for (const [i, property] of [[0, "group_ids"], [1, "subject_ids"]])
  for (const [branch, keyword] of [["then", "maxItems"], ["else", "minItems"]])
    propertyType("MutationScope", "/allOf/" + i + "/" + branch, property, "array", keyword);
propertyType("StatisticalBonusStatus", "/allOf/0/then", "blocking_codes", "array", "maxItems");
propertyType("StatisticalBonusStatus", "/allOf/0/then", "eligible_participant_count", "integer", "minimum");
assert.equal(TYPE_PLAN.length, 17);

function proveType(doc, entry) {
  const target = resolve(doc, entry.target), root = doc.components.schemas[entry.component];
  assert.equal(root.type, "object", "ROOT_OBJECT_DOMINATOR_REQUIRED");
  assert.equal(resolve(doc, entry.anchor), entry.type, "UNCHANGED_TYPE_ANCHOR_REQUIRED");
  assert.equal(Object.hasOwn(target, "type"), false, "TYPE_ALREADY_PRESENT");
  assert.ok(Object.hasOwn(target, entry.keyword), "EXPECTED_APPLICABLE_KEYWORD_MISSING");
  if (entry.proof === "UNCONDITIONAL_SAME_PROPERTY_TYPE") {
    assert.match(entry.branch, /^\/allOf\/\d+\/(if|then|else)$/);
    assert.equal(entry.anchor, "#/components/schemas/" + entry.component + "/properties/" + entry.property + "/type");
  } else {
    assert.equal(entry.target, "#/components/schemas/DetailedReview/properties/gate/allOf/1");
    assert.deepEqual(root.properties.gate.allOf[0], { $ref: "#/components/schemas/ReviewGate" });
  }
  return true;
}

function buildView(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw), sourceHash = hash(bytes);
  assert.ok(PINNED.has(sourceHash), "UNPINNED_ORIGINAL_OPENAPI");
  const doc = JSON.parse(bytes), before = JSON.stringify(doc), rewrites = [], typeAdditions = [];
  const defs = {};
  for (const [name, schema] of Object.entries(doc.components.schemas)) {
    defs[name] = rewriteSchema(schema, "#/components/schemas/" + enc(name), (ref, pointer, kind, tag) => {
      assert.ok(typeof ref === "string" && ref.startsWith("#/components/schemas/"), "UNSUPPORTED_SCHEMA_REFERENCE");
      resolve(doc, ref);
      const newRef = "#/$defs/" + ref.slice("#/components/schemas/".length);
      rewrites.push({ pointer, kind, ...(tag === undefined ? {} : { tag }), before: ref, after: newRef,
        original_identity: { source_sha256: sourceHash, pointer: ref } });
      return newRef;
    }, (s, p) => checkDiscriminator(doc, s, p));
  }
  const view = { $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:univeracademy:validator-view:sha256:" + sourceHash,
    $comment: "Derived validation view; original component names and source SHA256 identity preserved. Not an OpenAPI release.",
    $defs: defs };
  for (const entry of TYPE_PLAN) {
    proveType(doc, entry);
    const derivedPointer = "#/$defs/" + entry.target.slice("#/components/schemas/".length);
    resolve(view, derivedPointer).type = entry.type;
    typeAdditions.push({ ...entry, derived_pointer: derivedPointer,
      condition: "On any instance satisfying the unchanged root constraints, this same value already has this type. Missing property stays skipped; null behavior unchanged.",
      if_note: entry.branch?.endsWith("/if") ? "Both original-valid and derived-valid roots retain roles:array, so adding type cannot flip if for any admissible root." : null });
  }
  assert.deepEqual(Object.keys(defs), Object.keys(doc.components.schemas));
  for (const change of rewrites) resolve(view, change.after); // Includes every discriminator target.
  assert.equal(rewrites.filter((r) => r.kind === "discriminator_mapping").length, 17);
  // Exact inverse AST check: only typed nodes and the two known reference forms differ.
  const stripped = structuredClone(view);
  for (const addition of typeAdditions) delete resolve(stripped, addition.derived_pointer).type;
  const restored = Object.fromEntries(Object.entries(stripped.$defs).map(([name, schema]) =>
    [name, rewriteSchema(schema, "#/$defs/" + enc(name), (ref) => {
      assert.ok(ref.startsWith("#/$defs/")); return "#/components/schemas/" + ref.slice("#/$defs/".length);
    })]));
  assert.deepEqual(restored, doc.components.schemas, "UNAUTHORIZED_AST_DIFFERENCE");
  assert.equal(JSON.stringify(doc), before, "ORIGINAL_DOCUMENT_MUTATED");
  const viewBytes = Buffer.from(JSON.stringify(view, null, 2) + "\n");
  const ledger = { status: "DERIVED_VALIDATOR_VIEW_NOT_ORIGINAL_API_CHANGE", source_sha256: sourceHash,
    source_bytes: bytes.length, view_sha256: hash(viewBytes), view_bytes: viewBytes.length,
    component_names_preserved: Object.keys(defs), source_identity_rule: "source_sha256 + original #/components/schemas/NAME",
    reference_rewrites: rewrites, type_additions: typeAdditions,
    structural_inverse_equals_original_components: true, original_mutated: false,
    semantic_proof: "The unchanged enclosing object/property or unconditional allOf-reference imposes T on the same existing value in BOTH versions. Thus local T is redundant on every admissible root; if/then/else selection, missing/null behavior and all existing assertions remain unchanged. Reference target names are bijective; annotations are retained, not data assertions." };
  return { view, viewBytes, ledger };
}
module.exports = { buildView, rewriteSchema, proveType, checkDiscriminator, TYPE_PLAN, resolve, hash };
if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const { viewBytes, ledger } = buildView(fs.readFileSync(file));
    fs.mkdirSync("views", { recursive: true }); const stem = ledger.source_sha256.slice(0, 12);
    fs.writeFileSync(path.join("views", stem + ".view.json"), viewBytes);
    fs.writeFileSync(path.join("views", stem + ".ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
    console.log(JSON.stringify({ source: ledger.source_sha256, view: ledger.view_sha256,
      definitions: ledger.component_names_preserved.length, mappings: 17, type_additions: ledger.type_additions.length }));
  }
}
