async function loadManifest(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) {
    throw new Error(`Failed to load manifest from ${url}: HTTP ${r.status}`);
  }
  const json = await r.json();
  if (json.schema !== 1) {
    throw new Error(`Unsupported manifest schema: ${json.schema}`);
  }
  return json;
}
function tierOf(manifest, tdsPath) {
  return manifest.files[tdsPath]?.tier ?? null;
}
function packageOf(manifest, tdsPath) {
  return manifest.files[tdsPath]?.package ?? null;
}
function expectedSha256(manifest, tdsPath) {
  return manifest.files[tdsPath]?.sha256 ?? null;
}
async function sha256Hex(bytes) {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function assertSha256(bytes, expected, what) {
  const actual = await sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `texlive-wasm: integrity check failed for ${what}: expected sha256 ${expected}, got ${actual}`
    );
  }
}
export {
  assertSha256,
  expectedSha256,
  loadManifest,
  packageOf,
  sha256Hex,
  tierOf
};
