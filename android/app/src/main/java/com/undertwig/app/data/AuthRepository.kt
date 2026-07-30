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
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import android.util.Base64
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
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
     * Keep this path simple: Identity.authorize() with the Drive scope only.
     * Do not call requestOfflineAccess here — that changed token shape and broke Drive calls.
     */
    suspend fun ensureDriveAccessToken(activity: Activity, forceRefresh: Boolean = false): String {
        if (!forceRefresh) {
            val cached = prefs.getString(KEY_DRIVE_TOKEN, null)
            val expiresAt = prefs.getLong(KEY_DRIVE_EXPIRES, 0L)
            if (!cached.isNullOrBlank() && expiresAt > System.currentTimeMillis() + 60_000L) {
                return cached
            }
        } else {
            clearDriveToken()
        }

        val email = currentUser()?.email
        val builder = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(DRIVE_SCOPE)))
        if (!email.isNullOrBlank()) {
            builder.setAccount(Account(email, "com.google"))
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
        // Access tokens typically last ~1h; refresh via authorize() on next Save.
        prefs.edit()
            .putString(KEY_DRIVE_TOKEN, token)
            .putLong(KEY_DRIVE_EXPIRES, System.currentTimeMillis() + 55 * 60_000L)
            .apply()
        return token
    }

    fun clearDriveToken() {
        prefs.edit()
            .remove(KEY_DRIVE_TOKEN)
            .remove(KEY_DRIVE_EXPIRES)
            // Also drop keys from the broken intermediate builds.
            .remove("drive_access_token_v2")
            .remove("drive_access_expires_v2")
            .apply()
    }

    /** Best-effort cached token for releasing locks without an Activity (sign-out / process teardown). */
    fun cachedDriveAccessTokenOrNull(): String? {
        val cached = prefs.getString(KEY_DRIVE_TOKEN, null)?.takeIf { it.isNotBlank() } ?: return null
        val expiresAt = prefs.getLong(KEY_DRIVE_EXPIRES, 0L)
        // Allow a short grace past expiry — trash is best-effort and tokens often still work briefly.
        if (expiresAt > 0L && expiresAt + 5 * 60_000L < System.currentTimeMillis()) {
            return null
        }
        return cached
    }

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

    class InvalidDriveCredentialsException(
        message: String = "Google Drive credentials are invalid or expired.",
        cause: Throwable? = null,
    ) : Exception(message, cause)

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
        private const val KEY_DRIVE_TOKEN = "drive_access_token"
        private const val KEY_DRIVE_EXPIRES = "drive_access_expires"

        fun isInvalidCredentialsMessage(message: String?): Boolean {
            val text = message.orEmpty()
            return text.contains("invalid authentication credentials", ignoreCase = true) ||
                text.contains("Invalid Credentials", ignoreCase = true) ||
                text.contains("UNAUTHENTICATED", ignoreCase = true)
        }
    }
}
