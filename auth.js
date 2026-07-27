(function (global) {
  const AUTH_STORAGE_KEY = "undertwig-auth-v1";

  function getConfig() {
    return global.UNDERTWIG_AUTH_CONFIG || { googleClientId: "" };
  }

  function decodeJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) {
      throw new Error("Invalid credential token.");
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const session = JSON.parse(raw);
      if (!session || !session.email || !session.sub) {
        return null;
      }
      return session;
    } catch (_error) {
      return null;
    }
  }

  function writeSession(session) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  function isLoggedIn() {
    return Boolean(readSession());
  }

  function sessionFromCredential(credential) {
    const payload = decodeJwtPayload(credential);
    if (!payload.email || !payload.sub) {
      throw new Error("Google sign-in did not return a usable account profile.");
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture || "",
      provider: "google",
      loggedInAt: new Date().toISOString(),
    };
  }

  function loginWithCredential(credential) {
    const session = sessionFromCredential(credential);
    writeSession(session);
    return session;
  }

  function logout() {
    clearSession();
    if (global.google && global.google.accounts && global.google.accounts.id) {
      try {
        global.google.accounts.id.disableAutoSelect();
      } catch (_error) {
        // Ignore GIS cleanup failures.
      }
    }
  }

  function loginUrl(nextPath) {
    const next = nextPath || "/";
    return "login.html?next=" + encodeURIComponent(next);
  }

  global.UndertwigAuth = {
    AUTH_STORAGE_KEY,
    getConfig,
    readSession,
    isLoggedIn,
    loginWithCredential,
    logout,
    loginUrl,
  };
})(window);
