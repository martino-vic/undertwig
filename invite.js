(function (global) {
  const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
  const COLLAB_SCOPES = DRIVE_SCOPE + " " + GMAIL_SEND_SCOPE;
  const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120000;
  const SILENT_TOKEN_TIMEOUT_MS = 4000;

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;

  function auth() {
    return global.UndertwigAuth;
  }

  function cloud() {
    return global.UndertwigCloud;
  }

  async function ensureGisOauth() {
    await auth().loadGoogleIdentityServices();
    await waitForOauthClient();
  }

  function waitForOauthClient() {
    return new Promise((resolve, reject) => {
      if (global.google && global.google.accounts && global.google.accounts.oauth2) {
        resolve();
        return;
      }
      const started = Date.now();
      const timer = setInterval(() => {
        if (global.google && global.google.accounts && global.google.accounts.oauth2) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error("Google authorization library failed to load."));
        }
      }, 50);
    });
  }

  /** Warm the GIS script so Send invite can open a popup from the click gesture. */
  function preload() {
    return ensureGisOauth().catch(() => null);
  }

  function clearToken() {
    if (
      memoryAccessToken &&
      global.google &&
      global.google.accounts &&
      global.google.accounts.oauth2 &&
      typeof global.google.accounts.oauth2.revoke === "function"
    ) {
      try {
        global.google.accounts.oauth2.revoke(memoryAccessToken);
      } catch (_error) {
        // Best-effort revoke.
      }
    }
    memoryAccessToken = null;
    memoryTokenExpiresAt = 0;
  }

  function hasAccessToken() {
    return Boolean(memoryAccessToken && memoryTokenExpiresAt - 60000 > Date.now());
  }

  function rememberToken(tokenResponse) {
    memoryAccessToken = tokenResponse.access_token;
    const expiresIn = Number(tokenResponse.expires_in) || 3600;
    memoryTokenExpiresAt = Date.now() + expiresIn * 1000;
    return memoryAccessToken;
  }

  function describeOauthError(response) {
    if (response.error === "access_denied") {
      return "Gmail send permission was denied.";
    }
    if (response.error === "popup_closed_by_user") {
      return "Gmail permission popup was closed.";
    }
    if (response.error === "popup_failed_to_open") {
      return "Browser blocked the Gmail permission popup. Allow popups, then try again.";
    }
    return response.error_description || response.error || "Gmail authorization failed.";
  }

  /**
   * Request an access token. Must not await before requestAccessToken() when called
   * from a click handler — browsers block the popup otherwise.
   */
  async function requestToken(scope, forcePrompt, timeoutMs) {
    const session = auth().readSession();
    if (!session) {
      throw new Error("Sign in to send collaboration invites.");
    }

    const clientId = auth().getConfig().googleClientId;
    if (!clientId) {
      throw new Error("Google sign-in is not configured.");
    }

    if (!(global.google && global.google.accounts && global.google.accounts.oauth2)) {
      await ensureGisOauth();
      throw new Error(
        "Google permission UI finished loading. Click Send invite again to open the permission popup."
      );
    }

    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : SILENT_TOKEN_TIMEOUT_MS;

    const token = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        handler(value);
      };
      const timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            "Gmail authorization timed out. Allow the Google popup (and Brave Shields/popups), then try inviting again."
          )
        );
      }, waitMs);

      try {
        const client = global.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: scope,
          prompt: forcePrompt ? "consent" : "",
          hint: session.email,
          callback: (response) => {
            if (response && response.error) {
              finish(reject, new Error(describeOauthError(response)));
              return;
            }
            if (!response || !response.access_token) {
              finish(reject, new Error("Google did not return a Gmail access token."));
              return;
            }
            finish(resolve, response);
          },
          error_callback: (error) => {
            const message =
              (error && (error.message || error.type)) || "Gmail authorization failed.";
            if (/popup/i.test(message)) {
              finish(
                reject,
                new Error(
                  "Browser blocked the Gmail permission popup. Allow popups for this site, then click Send invite again."
                )
              );
              return;
            }
            finish(reject, new Error(message));
          },
        });
        client.requestAccessToken();
      } catch (error) {
        finish(reject, error);
      }
    });

    return token;
  }

  async function getGmailAccessToken(options) {
    const opts = options || {};
    const forcePrompt = Boolean(opts.forcePrompt);
    const interactive = Boolean(opts.interactive);
    if (!forcePrompt && !interactive) {
      if (hasAccessToken()) {
        return memoryAccessToken;
      }
      throw new Error(
        "Gmail permission is not ready. Click Send invite again and allow the Google permission popup."
      );
    }

    const tokenResponse = await requestToken(
      GMAIL_SEND_SCOPE,
      forcePrompt,
      INTERACTIVE_TOKEN_TIMEOUT_MS
    );
    rememberToken(tokenResponse);
    return tokenResponse.access_token;
  }

  /** Call from a click handler before long uploads so the Gmail popup is not blocked. */
  async function connect(options) {
    return getGmailAccessToken({
      interactive: true,
      forcePrompt: Boolean(options && options.forcePrompt),
    });
  }

  /**
   * One permission popup for Drive + Gmail from the Send invite click.
   * Avoids a second popup after await (which browsers block).
   */
  async function connectForCollaboration(options) {
    const forcePrompt = Boolean(options && options.forcePrompt);
    const needsDrive = !(cloud() && typeof cloud().hasAccessToken === "function" && cloud().hasAccessToken());
    const needsGmail = !hasAccessToken();

    if (!needsDrive && !needsGmail) {
      return memoryAccessToken;
    }

    const scope =
      needsDrive && needsGmail ? COLLAB_SCOPES : needsGmail ? GMAIL_SEND_SCOPE : DRIVE_SCOPE;

    const tokenResponse = await requestToken(scope, forcePrompt, INTERACTIVE_TOKEN_TIMEOUT_MS);

    if (scope.indexOf(GMAIL_SEND_SCOPE) !== -1) {
      rememberToken(tokenResponse);
    }
    if (
      scope.indexOf(DRIVE_SCOPE) !== -1 &&
      cloud() &&
      typeof cloud().acceptTokenResponse === "function"
    ) {
      cloud().acceptTokenResponse(tokenResponse);
    }

    return memoryAccessToken;
  }

  function encodeUtf8Base64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function sanitizeHeaderValue(value) {
    return String(value || "").replace(/[\r\n]+/g, " ").trim();
  }

  function buildInviteMessage(recipientEmail, session, projectUrl) {
    const inviterName = sanitizeHeaderValue((session && session.name) || session.email || "Undertwig user");
    const inviterEmail = sanitizeHeaderValue((session && session.email) || "");
    const to = sanitizeHeaderValue(recipientEmail);
    const subject = "Invitation to collaborate on an Undertwig project";
    const fromLine = inviterEmail ? inviterName + " <" + inviterEmail + ">" : inviterName;
    const body =
      "Hi,\n\n" +
      inviterName +
      (inviterEmail ? " (" + inviterEmail + ")" : "") +
      " invited you to collaborate on their Undertwig LaTeX project.\n\n" +
      "Important: the project stays in their Google Drive. When you open the link below and sign in, " +
      "you get edit access to their shared project folder (you do not create a separate copy).\n\n" +
      "Open this Undertwig link (preferred):\n" +
      projectUrl +
      "\n\nIf Google Drive also emails you about a shared folder, you can accept that too — " +
      "but always open the Undertwig link above to edit in the browser.\n\n" +
      "If you were not expecting this invitation, you can ignore this email.\n";

    return (
      "From: " +
      fromLine +
      "\r\n" +
      "To: " +
      to +
      "\r\n" +
      "Subject: " +
      subject +
      "\r\n" +
      "MIME-Version: 1.0\r\n" +
      "Content-Type: text/plain; charset=\"UTF-8\"\r\n" +
      "\r\n" +
      body
    );
  }

  async function sendCollaborationInvite(recipientEmail, projectUrl) {
    const session = auth().readSession();
    if (!session) {
      throw new Error("Sign in to send collaboration invites.");
    }

    const email = String(recipientEmail || "").trim();
    if (!email) {
      throw new Error("Enter an email address.");
    }
    if (!projectUrl) {
      throw new Error("Missing project invite link.");
    }

    const rawMessage = buildInviteMessage(email, session, projectUrl);
    const raw = encodeUtf8Base64Url(rawMessage);

    // Prefer an already-prepared token from connectForCollaboration(); do not open a popup here.
    let token = await getGmailAccessToken({ interactive: false });
    let response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      credentials: "omit",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: raw }),
    });

    if (response.status === 401) {
      clearToken();
      throw new Error(
        "Gmail permission expired. Click Send invite again and allow the Google permission popup."
      );
    }

    if (!response.ok) {
      let detail = "Could not send the invitation email.";
      try {
        const payload = await response.json();
        if (payload && payload.error && payload.error.message) {
          detail = payload.error.message;
        }
      } catch (_error) {
        // Ignore JSON parse failures.
      }
      throw new Error(detail);
    }

    return true;
  }

  global.UndertwigInvite = {
    GMAIL_SEND_SCOPE,
    hasAccessToken,
    preload,
    connect,
    connectForCollaboration,
    sendCollaborationInvite,
    clearToken,
  };
})(window);
