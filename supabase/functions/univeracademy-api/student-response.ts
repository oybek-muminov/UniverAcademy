// Generated HTTP clients may offer both the versioned success format and plain
// JSON for errors. Select the requested success representation by preference.
function wantsCurrentProfile(accept: string | null): boolean {
  let current = 0;
  let plain = 0;
  for (const range of (accept ?? "").split(",")) {
    const [type, ...parameters] = range.trim().split(/\s*;\s*/);
    if (type.toLowerCase() !== "application/json") continue;
    let profile: string | undefined;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, raw] = parameter.split(/\s*=\s*/, 2);
      const value = raw?.replace(/^"(.*)"$/, "$1");
      if (name.toLowerCase() === "profile") profile = value;
      if (name.toLowerCase() === "q") {
        quality = value && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
      }
    }
    if (profile === "univeracademy-id-v2") current = Math.max(current, quality);
    else if (profile === undefined) plain = Math.max(plain, quality);
  }
  return current > 0 && current >= plain;
}

/**
 * The first student clients have an exact-key Profile decoder. Keep their wire
 * representation available while the domain and storage use UniverAcademy ID.
 * Only the top-level Profile or Session.profile is projected; other payloads
 * (including arbitrary user content) are serialized verbatim.
 */
export function studentResponse(request: Request, data: unknown, initHeaders?: HeadersInit): Response {
  const headers = new Headers(initHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const nested = Object.hasOwn(record, "profile");
    const profile = (nested ? record.profile : record) as Record<string, unknown> | null;
    if (profile && typeof profile === "object" && Object.hasOwn(profile, "univeracademy_id")) {
      headers.append("vary", "Accept");
      if (wantsCurrentProfile(request.headers.get("accept"))) {
        headers.set("content-type", "application/json; profile=univeracademy-id-v2; charset=utf-8");
      } else {
        const { univeracademy_id, ...fields } = profile;
        const legacy = { ...fields, qadam_id: univeracademy_id };
        data = nested ? { ...record, profile: legacy } : legacy;
      }
    }
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers });
}
