function safeRelativePath(path) {
  const segments = path.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "..")) return null;
  if (/^[a-z]:$/i.test(segments[0])) return null;
  if (segments.some((s) => s.includes("\0"))) return null;
  return segments.join("/");
}
function safeResolve(root, path) {
  const base = root.replace(/\/+$/, "");
  const inRoot = path === base || path.startsWith(`${base}/`);
  if (!inRoot && path.startsWith("/")) return null;
  const rest = inRoot ? path.slice(base.length) : path;
  if (rest === "" || rest === "/") return base;
  const rel = safeRelativePath(rest);
  return rel === null ? null : `${base}/${rel}`;
}
export {
  safeResolve as a,
  safeRelativePath as s
};
