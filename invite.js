(function (global) {
  const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
  const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;

  function auth() {
    return global.UndertwigAuth;
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

  function describeOauthError(response) {
    if (response.error === "access_denied") {
      return "Gmail send permission was denied.";
    }
    if (response.error === "popup_closed_by_user") {
      return "Gmail permission popup was closed.";
    }
    return response.error_description || response.error || "Gmail authorization failed.";
  }

  async function getGmailAccessToken(options) {
    const forcePrompt = Boolean(options && options.forcePrompt);
    const now = Date.now();
    if (!forcePrompt && memoryAccessToken && memoryTokenExpiresAt - 60000 > now) {
      return memoryAccessToken;
    }

    const session = auth().readSession();
    if (!session) {
      throw new Error("Sign in to send collaboration invites.");
    }

    const clientId = auth().getConfig().googleClientId;
    if (!clientId) {
      throw new Error("Google sign-in is not configured.");
    }

    await ensureGisOauth();

    const token = await new Promise((resolve, reject) => {
      try {
        const client = global.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: GMAIL_SEND_SCOPE,
          prompt: forcePrompt ? "consent" : "",
          hint: session.email,
          callback: (response) => {
            if (response && response.error) {
              reject(new Error(describeOauthError(response)));
              return;
            }
            if (!response || !response.access_token) {
              reject(new Error("Google did not return a Gmail access token."));
              return;
            }
            resolve(response);
          },
          error_callback: (error) => {
            reject(new Error((error && error.message) || "Gmail authorization failed."));
          },
        });
        client.requestAccessToken();
      } catch (error) {
        reject(error);
      }
    });

    memoryAccessToken = token.access_token;
    const expiresIn = Number(token.expires_in) || 3600;
    memoryTokenExpiresAt = Date.now() + expiresIn * 1000;
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

    let token = await getGmailAccessToken();
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
      token = await getGmailAccessToken({ forcePrompt: true });
      response = await fetch(GMAIL_SEND_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: raw }),
      });
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
    sendCollaborationInvite,
    clearToken,
  };
})(window);
