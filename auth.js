(function (global) {
  const AUTH_STORAGE_KEY = "undertwig-auth-v2";
  const NONCE_STORAGE_KEY = "undertwig-auth-nonce";
  const GOOGLE_ISSUERS = new Set([
    "https://accounts.google.com",
    "accounts.google.com",
  ]);
  const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
  const CLOCK_SKEW_SECONDS = 60;

  let jwksCache = null;
  let jwksFetchedAt = 0;

  function getConfig() {
    const config = global.UNDERTWIG_AUTH_CONFIG || {};
    return {
      googleClientId: String(config.googleClientId || "").trim(),
    };
  }

  function base64UrlToUint8Array(value) {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decodeJwtPart(part) {
    const text = new TextDecoder().decode(base64UrlToUint8Array(part));
    return JSON.parse(text);
  }

  function splitJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid Google credential.");
    }
    return {
      header: decodeJwtPart(parts[0]),
      payload: decodeJwtPart(parts[1]),
      signingInput: parts[0] + "." + parts[1],
      signature: base64UrlToUint8Array(parts[2]),
    };
  }

  function createNonce() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function rememberNonce(nonce) {
    try {
      sessionStorage.setItem(NONCE_STORAGE_KEY, nonce);
    } catch (_error) {
      // sessionStorage may be unavailable; verification will fail closed.
    }
  }

  function consumeNonce() {
    try {
      const nonce = sessionStorage.getItem(NONCE_STORAGE_KEY);
      sessionStorage.removeItem(NONCE_STORAGE_KEY);
      return nonce;
    } catch (_error) {
      return null;
    }
  }

  function prepareSignInNonce() {
    const nonce = createNonce();
    rememberNonce(nonce);
    return nonce;
  }

  function safeNextPath(nextPath) {
    if (!nextPath || typeof nextPath !== "string") {
      return "/";
    }
    const trimmed = nextPath.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
      return "/";
    }
    try {
      const url = new URL(trimmed, global.location.origin);
      if (url.origin !== global.location.origin) {
        return "/";
      }
      return url.pathname + url.search + url.hash;
    } catch (_error) {
      return "/";
    }
  }

  async function fetchGoogleJwks() {
    const now = Date.now();
    if (jwksCache && now - jwksFetchedAt < 60 * 60 * 1000) {
      return jwksCache;
    }
    const response = await fetch(GOOGLE_JWKS_URL, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error("Could not fetch Google signing keys.");
    }
    jwksCache = await response.json();
    jwksFetchedAt = now;
    return jwksCache;
  }

  async function importGoogleKey(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"]
    );
  }

  async function verifyJwtSignature(credential) {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error("Secure token verification is unavailable in this browser.");
    }

    const { header, signingInput, signature } = splitJwt(credential);
    if (header.alg !== "RS256" || !header.kid) {
      throw new Error("Unsupported Google credential algorithm.");
    }

    const jwks = await fetchGoogleJwks();
    const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
    if (!jwk) {
      jwksCache = null;
      const refreshed = await fetchGoogleJwks();
      const retry = (refreshed.keys || []).find((key) => key.kid === header.kid);
      if (!retry) {
        throw new Error("Google credential signing key was not recognized.");
      }
      const key = await importGoogleKey(retry);
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        new TextEncoder().encode(signingInput)
      );
      if (!ok) {
        throw new Error("Google credential signature verification failed.");
      }
      return;
    }

    const key = await importGoogleKey(jwk);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(signingInput)
    );
    if (!ok) {
      throw new Error("Google credential signature verification failed.");
    }
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha256Base64Url(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    let binary = "";
    new Uint8Array(digest).forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function nonceMatches(expectedNonce, actualNonce) {
    if (!expectedNonce || !actualNonce) {
      return false;
    }
    if (expectedNonce === actualNonce) {
      return true;
    }
    // Google may return a hash of the supplied nonce in the ID token.
    const hex = await sha256Hex(expectedNonce);
    if (hex === actualNonce) {
      return true;
    }
    const b64 = await sha256Base64Url(expectedNonce);
    return b64 === actualNonce;
  }

  async function assertValidClaims(payload, expectedNonce) {
    const clientId = getConfig().googleClientId;
    if (!clientId) {
      throw new Error("Google sign-in is not configured.");
    }
    if (payload.aud !== clientId) {
      throw new Error("Google credential audience mismatch.");
    }
    if (!GOOGLE_ISSUERS.has(payload.iss)) {
      throw new Error("Google credential issuer mismatch.");
    }
    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("Google credential is missing a subject.");
    }
    if (!payload.email || typeof payload.email !== "string") {
      throw new Error("Google credential is missing an email address.");
    }
    if (payload.email_verified !== true && payload.email_verified !== "true") {
      throw new Error("Google account email is not verified.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
      throw new Error("Google credential has expired.");
    }
    if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_SECONDS > now) {
      throw new Error("Google credential timestamp is invalid.");
    }
    if (!(await nonceMatches(expectedNonce, payload.nonce))) {
      throw new Error("Google credential nonce mismatch.");
    }
  }

  function toPublicSession(payload) {
    // Minimal profile only. The raw ID token is never persisted.
    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : payload.email,
      picture:
        typeof payload.picture === "string" && payload.picture.startsWith("https://")
          ? payload.picture
          : "",
      provider: "google",
      emailVerified: true,
      expiresAt: payload.exp,
      loggedInAt: new Date().toISOString(),
    };
  }

  function clearSession() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      // Remove legacy unverified sessions.
      localStorage.removeItem("undertwig-auth-v1");
    } catch (_error) {
      // Ignore storage failures during logout.
    }
  }

  function writeSession(session) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const session = JSON.parse(raw);
      if (!session || !session.sub || !session.email || !session.expiresAt) {
        clearSession();
        return null;
      }
      const now = Math.floor(Date.now() / 1000);
      if (session.expiresAt + CLOCK_SKEW_SECONDS < now) {
        clearSession();
        return null;
      }
      if (session.provider !== "google") {
        clearSession();
        return null;
      }
      return {
        sub: session.sub,
        email: session.email,
        name: session.name || session.email,
        picture: session.picture || "",
        provider: "google",
        emailVerified: true,
        expiresAt: session.expiresAt,
        loggedInAt: session.loggedInAt || null,
      };
    } catch (_error) {
      clearSession();
      return null;
    }
  }

  function isLoggedIn() {
    return Boolean(readSession());
  }

  async function loginWithCredential(credential) {
    const expectedNonce = consumeNonce();
    await verifyJwtSignature(credential);
    const { payload } = splitJwt(credential);
    assertValidClaims(payload, expectedNonce);
    const session = toPublicSession(payload);
    writeSession(session);
    return session;
  }

  function logout() {
    clearSession();
    try {
      sessionStorage.removeItem(NONCE_STORAGE_KEY);
    } catch (_error) {
      // Ignore.
    }
    if (global.google && global.google.accounts && global.google.accounts.id) {
      try {
        global.google.accounts.id.disableAutoSelect();
      } catch (_error) {
        // Ignore GIS cleanup failures.
      }
    }
  }

  function loadGoogleIdentityServices() {
    return new Promise((resolve, reject) => {
      if (global.google && global.google.accounts && global.google.accounts.id) {
        resolve();
        return;
      }
      const existing = document.querySelector('script[data-undertwig-gsi="1"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Google sign-in failed to load.")), {
          once: true,
        });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.dataset.undertwigGsi = "1";
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Google sign-in failed to load.")), {
        once: true,
      });
      document.head.appendChild(script);
    });
  }

  function revokeGoogleAccess(email) {
    return new Promise((resolve) => {
      if (
        !email ||
        !global.google ||
        !global.google.accounts ||
        !global.google.accounts.id ||
        typeof global.google.accounts.id.revoke !== "function"
      ) {
        resolve(false);
        return;
      }
      try {
        global.google.accounts.id.revoke(email, () => resolve(true));
      } catch (_error) {
        resolve(false);
      }
    });
  }

  async function logoutAndRevoke() {
    const session = readSession();
    const email = session && session.email;
    logout();
    if (!email) {
      return;
    }
    try {
      await loadGoogleIdentityServices();
      await revokeGoogleAccess(email);
    } catch (_error) {
      // Local session is already cleared; revoke is best-effort.
    }
  }

  function loginUrl(nextPath) {
    const next = safeNextPath(nextPath || "/");
    return "login.html?next=" + encodeURIComponent(next);
  }

  global.UndertwigAuth = {
    AUTH_STORAGE_KEY,
    getConfig,
    prepareSignInNonce,
    safeNextPath,
    readSession,
    isLoggedIn,
    loginWithCredential,
    logout,
    logoutAndRevoke,
    loginUrl,
  };
})(window);
