package com.undertwig.app.data

import android.accounts.Account
import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class AuthUser(
    val id: String,
    val email: String,
    val name: String,
    val pictureUrl: String?,
    val idToken: String,
)

class AuthRepository(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val credentialManager = CredentialManager.create(appContext)

    fun currentUser(): AuthUser? {
        val id = prefs.getString(KEY_ID, null) ?: return null
        val email = prefs.getString(KEY_EMAIL, null) ?: return null
        val name = prefs.getString(KEY_NAME, null) ?: email
        val picture = prefs.getString(KEY_PICTURE, null)
        val idToken = prefs.getString(KEY_ID_TOKEN, null) ?: return null
        return AuthUser(
            id = id,
            email = email,
            name = name,
            pictureUrl = picture,
            idToken = idToken,
        )
    }

    fun isLoggedIn(): Boolean = currentUser() != null

    suspend fun signInWithGoogle(activity: Activity): AuthUser {
        val option = GetSignInWithGoogleOption.Builder(WEB_CLIENT_ID).build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()
        try {
            val result = credentialManager.getCredential(
                context = activity,
                request = request,
            )
            val credential = result.credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                val google = GoogleIdTokenCredential.createFrom(credential.data)
                val user = AuthUser(
                    id = google.id,
                    email = google.id,
                    name = google.displayName?.takeIf { it.isNotBlank() }
                        ?: decodeJwtName(google.idToken)
                        ?: google.id,
                    pictureUrl = google.profilePictureUri?.toString(),
                    idToken = google.idToken,
                ).let { base ->
                    val claims = decodeJwtClaims(google.idToken)
                    base.copy(
                        id = claims?.optString("sub")?.takeIf { it.isNotBlank() } ?: base.id,
                        email = claims?.optString("email")?.takeIf { it.isNotBlank() } ?: base.email,
                        name = claims?.optString("name")?.takeIf { it.isNotBlank() } ?: base.name,
                        pictureUrl = claims?.optString("picture")?.takeIf { it.isNotBlank() }
                            ?: base.pictureUrl,
                    )
                }
                persist(user)
                // Prompt for Drive once at login so later Saves can sync without a second identity step.
                runCatching { ensureDriveAccessToken(activity) }
                return user
            }
            throw IllegalStateException("Unexpected credential type from Google Sign-In.")
        } catch (e: GetCredentialCancellationException) {
            throw SignInCancelledException()
        } catch (e: NoCredentialException) {
            throw IllegalStateException(
                "No Google account available. Add a Google account on this device and try again.",
                e,
            )
        } catch (e: GoogleIdTokenParsingException) {
            throw IllegalStateException("Could not read Google sign-in response.", e)
        } catch (e: GetCredentialException) {
            throw IllegalStateException(friendlyCredentialError(e), e)
        }
    }

    /**
     * Returns a Google Drive OAuth access token for the signed-in user.
     * May show a consent UI the first time Drive access is needed.
     *
     * @param forceRefresh clear Play Services' cached access token and request a new one
     * (required after Drive returns 401 invalid credentials — otherwise authorize() can keep
     * handing back the same dead token).
     */
    suspend fun ensureDriveAccessToken(activity: Activity, forceRefresh: Boolean = false): String {
        if (!forceRefresh) {
            val cached = prefs.getString(KEY_DRIVE_TOKEN, null)
            val expiresAt = prefs.getLong(KEY_DRIVE_EXPIRES, 0L)
            if (!cached.isNullOrBlank() && expiresAt > System.currentTimeMillis() + 30_000L) {
                return cached
            }
        } else {
            val stale = prefs.getString(KEY_DRIVE_TOKEN, null)
            clearDriveToken()
            if (!stale.isNullOrBlank()) {
                clearPlayServicesToken(activity, stale)
            }
        }

        val email = currentUser()?.email
            ?: throw IllegalStateException("Log in before connecting Google Drive.")
        val builder = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_SCOPE)))
            .setAccount(Account(email, "com.google"))
        // Tie the token to our web OAuth client so Drive accepts it the same way as the website.
        runCatching { builder.requestOfflineAccess(WEB_CLIENT_ID) }
        // When refreshing after 401, force the consent prompt so GPS cannot reuse a revoked token.
        if (forceRefresh) {
            runCatching {
                val promptClass = Class.forName(
                    "com.google.android.gms.auth.api.identity.AuthorizationRequest\$Prompt",
                )
                val consent = promptClass.fields
                    .firstOrNull { it.name == "CONSENT" }
                    ?.get(null)
                if (consent is Int) {
                    val setPrompt = builder.javaClass.methods.firstOrNull { method ->
                        method.name == "setPrompt" && method.parameterCount == 1
                    }
                    setPrompt?.invoke(builder, consent)
                }
            }
            runCatching {
                // Older play-services-auth: force a new server auth code / consent.
                val method = builder.javaClass.methods.firstOrNull { method ->
                    method.name == "requestOfflineAccess" &&
                        method.parameterTypes.size == 2 &&
                        method.parameterTypes[0] == String::class.java &&
                        method.parameterTypes[1] == Boolean::class.javaPrimitiveType
                }
                method?.invoke(builder, WEB_CLIENT_ID, true)
            }
        }

        val request = builder.build()
        val client = Identity.getAuthorizationClient(activity)
        val first = client.authorize(request).await()
        val result = if (first.hasResolution()) {
            val pending = first.pendingIntent
                ?: throw IllegalStateException("Google Drive permission UI is unavailable.")
            launchAuthorizationResolution(activity, pending.intentSender).let { data ->
                client.getAuthorizationResultFromIntent(data)
            }
        } else {
            first
        }
        val token = result.accessToken?.takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("Google Drive access was not granted.")
        val expiresAtMs = driveTokenExpiryMs(result)
        prefs.edit()
            .putString(KEY_DRIVE_TOKEN, token)
            .putLong(KEY_DRIVE_EXPIRES, expiresAtMs)
            .apply()
        return token
    }

    private suspend fun clearPlayServicesToken(activity: Activity, token: String) {
        withContext(Dispatchers.IO) {
            // Newer Play services: AuthorizationClient.clearToken(ClearTokenRequest).
            runCatching {
                val requestClass = Class.forName(
                    "com.google.android.gms.auth.api.identity.ClearTokenRequest",
                )
                val builderMethod = requestClass.getMethod("builder")
                val builder = builderMethod.invoke(null)
                val setToken = builder.javaClass.methods.first { method ->
                    method.name == "setToken" && method.parameterCount == 1
                }
                setToken.invoke(builder, token)
                val clearRequest = builder.javaClass.getMethod("build").invoke(builder)
                val client = Identity.getAuthorizationClient(activity)
                val clearMethod = client.javaClass.methods.first { method ->
                    method.name == "clearToken" && method.parameterCount == 1
                }
                val task = clearMethod.invoke(client, clearRequest)
                @Suppress("UNCHECKED_CAST")
                (task as com.google.android.gms.tasks.Task<Void>).await()
            }
            // Always also clear via GoogleAuthUtil so authorize() cannot reuse a revoked token.
            runCatching {
                GoogleAuthUtil.clearToken(appContext, token)
            }
        }
    }

    private fun driveTokenExpiryMs(result: com.google.android.gms.auth.api.identity.AuthorizationResult): Long {
        val now = System.currentTimeMillis()
        val fromApi = runCatching {
            val method = result.javaClass.methods.firstOrNull { method ->
                method.name == "getAccessTokenExpirationTime" && method.parameterCount == 0
            } ?: return@runCatching null
            val value = method.invoke(result) as? Long ?: return@runCatching null
            if (value > now + 60_000L) value else null
        }.getOrNull()
        return fromApi ?: (now + 5 * 60_000L)
    }

    fun clearDriveToken() {
        prefs.edit()
            .remove(KEY_DRIVE_TOKEN)
            .remove(KEY_DRIVE_EXPIRES)
            .apply()
    }

    class InvalidDriveCredentialsException(
        message: String = "Google Drive credentials are invalid or expired.",
        cause: Throwable? = null,
    ) : Exception(message, cause)

    suspend fun signOut() {
        runCatching {
            credentialManager.clearCredentialState(ClearCredentialStateRequest())
        }
        prefs.edit().clear().apply()
    }

    private suspend fun launchAuthorizationResolution(
        activity: Activity,
        intentSender: android.content.IntentSender,
    ): Intent {
        val component = activity as? ComponentActivity
            ?: throw IllegalStateException("Drive authorization requires an Activity.")
        return suspendCancellableCoroutine { cont ->
            val key = "undertwig_drive_auth_${System.nanoTime()}"
            lateinit var launcher: ActivityResultLauncher<IntentSenderRequest>
            launcher = component.activityResultRegistry.register(
                key,
                ActivityResultContracts.StartIntentSenderForResult(),
            ) { activityResult ->
                launcher.unregister()
                if (activityResult.resultCode == Activity.RESULT_OK && activityResult.data != null) {
                    cont.resume(activityResult.data!!)
                } else {
                    cont.resumeWithException(SignInCancelledException())
                }
            }
            cont.invokeOnCancellation {
                runCatching { launcher.unregister() }
            }
            try {
                launcher.launch(IntentSenderRequest.Builder(intentSender).build())
            } catch (e: Exception) {
                runCatching { launcher.unregister() }
                cont.resumeWithException(e)
            }
        }
    }

    private fun persist(user: AuthUser) {
        prefs.edit()
            .putString(KEY_ID, user.id)
            .putString(KEY_EMAIL, user.email)
            .putString(KEY_NAME, user.name)
            .putString(KEY_PICTURE, user.pictureUrl)
            .putString(KEY_ID_TOKEN, user.idToken)
            .apply()
    }

    private fun decodeJwtName(idToken: String): String? =
        decodeJwtClaims(idToken)?.optString("name")?.takeIf { it.isNotBlank() }

    private fun decodeJwtClaims(idToken: String): JSONObject? {
        return try {
            val parts = idToken.split(".")
            if (parts.size < 2) return null
            val payload = String(
                Base64.decode(
                    parts[1],
                    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
                ),
            )
            JSONObject(payload)
        } catch (_: Exception) {
            null
        }
    }

    private fun friendlyCredentialError(e: GetCredentialException): String {
        val msg = e.message.orEmpty()
        return when {
            msg.contains("16:", ignoreCase = true) ||
                msg.contains("DEVELOPER_ERROR", ignoreCase = true) ||
                msg.contains("10:", ignoreCase = true) ->
                "Google Sign-In isn’t configured for this app build yet."
            else -> msg.ifBlank { "Google Sign-In failed." }
        }
    }

    class SignInCancelledException : Exception("Sign-in cancelled")

    companion object {
        // Same public web OAuth client ID as auth-config.js (audience for ID tokens).
        const val WEB_CLIENT_ID =
            "800443995990-dejumfn1f6254h326ln6d1hr16l017fu.apps.googleusercontent.com"

        const val DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"

        private const val PREFS = "undertwig_auth"
        private const val KEY_ID = "id"
        private const val KEY_EMAIL = "email"
        private const val KEY_NAME = "name"
        private const val KEY_PICTURE = "picture"
        private const val KEY_ID_TOKEN = "id_token"
        private const val KEY_DRIVE_TOKEN = "drive_access_token_v2"
        private const val KEY_DRIVE_EXPIRES = "drive_access_expires_v2"

        fun isInvalidCredentialsMessage(message: String?): Boolean {
            val text = message.orEmpty()
            return text.contains("invalid authentication credentials", ignoreCase = true) ||
                text.contains("Invalid Credentials", ignoreCase = true) ||
                text.contains("authError", ignoreCase = true) ||
                text.contains("UNAUTHENTICATED", ignoreCase = true) ||
                Regex("""\b401\b""").containsMatchIn(text)
        }
    }
}
