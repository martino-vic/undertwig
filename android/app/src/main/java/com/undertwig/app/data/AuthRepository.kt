package com.undertwig.app.data

import android.app.Activity
import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import android.util.Base64
import org.json.JSONObject

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
                    // GoogleIdTokenCredential.id is usually the email; prefer JWT claims when present.
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

    suspend fun signOut() {
        runCatching {
            credentialManager.clearCredentialState(ClearCredentialStateRequest())
        }
        prefs.edit().clear().apply()
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

        private const val PREFS = "undertwig_auth"
        private const val KEY_ID = "id"
        private const val KEY_EMAIL = "email"
        private const val KEY_NAME = "name"
        private const val KEY_PICTURE = "picture"
        private const val KEY_ID_TOKEN = "id_token"
    }
}
