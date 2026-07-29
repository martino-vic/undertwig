import { loadManifest, assertSha256 } from "./manifest.js";
import { s as safeRelativePath } from "./paths-FjePC1PO.js";
const MAX_TAR_ENTRIES = 25e4;
function untar(bytes, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_TAR_ENTRIES;
  const out = [];
  const decoder = new TextDecoder();
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (isAllZero(block)) {
      break;
    }
    const name = readCString(block, 0, 100);
    const size = parseOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    const prefix = readCString(block, 345, 155);
    const fullPath = pendingLongName ?? (prefix ? prefix + "/" + name : name);
    pendingLongName = null;
    offset += 512;
    if (size < 0 || !Number.isSafeInteger(size) || offset + size > bytes.length) {
      throw new Error(
        `texlive-wasm: tar entry "${fullPath}" declares ${size} bytes, past the end of the archive`
      );
    }
    const contentBlocks = Math.ceil(size / 512);
    const content = bytes.subarray(offset, offset + size);
    offset += contentBlocks * 512;
    if (out.length >= maxEntries) {
      throw new Error(
        `texlive-wasm: tar archive has more than ${maxEntries} entries; refusing to continue`
      );
    }
    if (typeflag === "L") {
      pendingLongName = decoder.decode(content).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x") {
      const paxPath = parsePaxPath(decoder.decode(content));
      if (paxPath) pendingLongName = paxPath;
      continue;
    }
    if (typeflag === "g") {
      continue;
    }
    const type = typeflag === "5" ? "dir" : typeflag === "0" || typeflag === "\0" ? "file" : "other";
    out.push({ path: fullPath, content: type === "file" ? content : new Uint8Array(), type });
  }
  return out;
}
function parsePaxPath(body) {
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(" ", i);
    if (space < 0) break;
    const len = Number(body.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = body.slice(space + 1, i + len);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") {
      return record.slice(eq + 1).replace(/\n$/, "");
    }
    i += len;
  }
  return null;
}
function readCString(block, start, len) {
  let end = start;
  while (end < start + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(start, end));
}
function parseOctal(block, start, len) {
  let n = 0;
  for (let i = start; i < start + len; i++) {
    const c = block[i];
    if (c === void 0 || c === 0 || c === 32) continue;
    if (c < 48 || c > 55) break;
    n = n * 8 + (c - 48);
  }
  return n;
}
function isAllZero(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
async function decompress(bytes, format, maxBytes = MAX_DECOMPRESSED_BYTES) {
  const Ctor = globalThis.DecompressionStream;
  if (!Ctor) {
    throw new Error(`DecompressionStream not available; can't decompress ${format}`);
  }
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const stream = new Blob([ab]).stream().pipeThrough(new Ctor(format)).pipeThrough(limitBytes(maxBytes, format));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
function limitBytes(maxBytes, format) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new Error(
            `texlive-wasm: ${format} stream expands past the ${maxBytes}-byte limit; refusing to continue`
          )
        );
        return;
      }
      controller.enqueue(chunk);
    }
  });
}
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
async function createBundleFs(opts) {
  const files = /* @__PURE__ */ new Map();
  const stripPrefix = opts.stripPrefix ?? "texmf/";
  async function load() {
    let bytes = opts.bundleBytes;
    let bundleUrl = opts.bundleUrl;
    let expectedSha = opts.sha256;
    if (!bytes && !bundleUrl && opts.manifestUrl) {
      const manifest = await loadManifest(opts.manifestUrl);
      if (manifest.coreBundleUrl) {
        bundleUrl = new URL(manifest.coreBundleUrl, absolutize(opts.manifestUrl)).toString();
        expectedSha ??= manifest.coreBundleSha256 ?? void 0;
      }
    }
    if (!bytes && bundleUrl) {
      requireIntegrity(bundleUrl, expectedSha, opts.allowUnverified === true);
      const r = await fetch(bundleUrl);
      if (!r.ok) throw new Error(`BundleFs: HTTP ${r.status} for ${bundleUrl}`);
      bytes = new Uint8Array(await r.arrayBuffer());
      const maxCompressed = opts.maxCompressedBytes ?? MAX_COMPRESSED_BYTES;
      if (bytes.byteLength > maxCompressed) {
        throw new Error(
          `BundleFs: ${bundleUrl} is ${bytes.byteLength} bytes, past the ${maxCompressed}-byte download limit; refusing to unpack it`
        );
      }
    }
    if (!bytes) return;
    if (expectedSha) {
      await assertSha256(bytes, expectedSha, bundleUrl ?? "bundle");
    }
    const format = opts.format ?? detectFormat(bundleUrl, bytes);
    if (!format) {
      throw new Error(
        `BundleFs: cannot tell what ${bundleUrl ?? "the supplied bundle"} is compressed with \u2014 it is neither gzip nor a plain tar. Brotli has no magic bytes, so name the file .tar.br or pass format: 'br' explicitly.`
      );
    }
    const tar = format === "raw" ? bytes : await decompress(bytes, format, opts.maxBytes);
    let rejected = 0;
    let firstRejected = "";
    let duplicates = 0;
    for (const entry of untar(tar)) {
      if (entry.type !== "file") continue;
      let path = entry.path;
      if (path.startsWith(stripPrefix)) path = path.slice(stripPrefix.length);
      const safe = path.startsWith("/") ? null : safeRelativePath(path);
      if (!safe) {
        rejected++;
        firstRejected ||= entry.path;
        continue;
      }
      if (files.has(safe)) {
        duplicates++;
        continue;
      }
      files.set(safe, entry.content);
    }
    if (rejected > 0) {
      console.warn(
        `texlive-wasm: BundleFs dropped ${rejected} archive entr${rejected === 1 ? "y" : "ies"} with an escaping path (first: ${firstRejected}) from ${bundleUrl ?? "the supplied bundle"}`
      );
    }
    if (duplicates > 0) {
      console.warn(
        `texlive-wasm: BundleFs dropped ${duplicates} duplicate archive entr${duplicates === 1 ? "y" : "ies"} from ${bundleUrl ?? "the supplied bundle"}; the first copy of each name is the one served`
      );
    }
  }
  return {
    id: "bundlefs",
    read(tdsPath) {
      return files.get(stripLeading(tdsPath)) ?? null;
    },
    exists(tdsPath) {
      return files.has(stripLeading(tdsPath));
    },
    list(prefix) {
      const p = stripLeading(prefix);
      const out = [];
      for (const path of files.keys()) {
        if (path.startsWith(p)) out.push(path);
      }
      return out;
    },
    async init() {
      await load();
    }
  };
}
function stripLeading(p) {
  return p.replace(/^\/+/, "");
}
function requireIntegrity(bundleUrl, sha256, allow) {
  if (sha256 || allow || isSameOrigin(bundleUrl)) return;
  throw new Error(
    `BundleFs: refusing to load ${bundleUrl} \u2014 no SHA-256 for it. Publish the digest in the manifest (coreBundleSha256), pass it as \`sha256\`, or serve the bundle from the app's own origin. For development only, set allowUnverified/allowUnverifiedAssets.`
  );
}
function isSameOrigin(url) {
  if (typeof location === "undefined") return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
function absolutize(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const origin = typeof location !== "undefined" ? location.href : "file:///";
  return new URL(url, origin).toString();
}
function detectFormat(url, bytes) {
  if (url) {
    const path = url.split(/[?#]/)[0] ?? url;
    if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) return "gzip";
    if (path.endsWith(".tar.br")) return "br";
    if (path.endsWith(".tar")) return "raw";
  }
  if (bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139) return "gzip";
  if (bytes.length >= 262 && bytes[257] === 117 && // u
  bytes[258] === 115 && // s
  bytes[259] === 116 && // t
  bytes[260] === 97 && // a
  bytes[261] === 114) {
    return "raw";
  }
  return null;
}
export {
  createBundleFs as c
};
