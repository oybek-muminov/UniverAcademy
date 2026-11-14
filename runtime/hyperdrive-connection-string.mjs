// Trusted platform binding only: this is not a direct-origin connection policy.
// workerd supplies ?sslmode=disable for the Worker-to-Hyperdrive local hop.
// Hyperdrive-to-origin TLS (verify-full + CA) remains a separate deployment gate.
// Keep the exact platform string; never strip parameters or weaken origin TLS.
export function isHyperdriveConnectionString(value){
  if(typeof value!=="string"||/\s|\0/.test(value)||value.includes("#"))return false;
  let url;try{url=new URL(value);}catch{return false;}
  if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||!url.port||
    !url.username||!url.password||url.pathname.length<2)return false;
  // Exact raw allowlist: no duplicate, encoded, additional, or alternate options.
  const query=value.indexOf("?");
  return query===-1||value.slice(query)==="?sslmode=disable";
}
