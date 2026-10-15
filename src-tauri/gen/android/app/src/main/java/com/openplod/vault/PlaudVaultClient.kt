package com.openplod.vault

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/** A desktop response that was not a success envelope. `payload` is the parsed body, if any. */
class VaultHttpException(val code: Int, val payload: JSONObject?, message: String) : IllegalStateException(message)

class PlaudVaultClient {
    private val client = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.MINUTES)
        .readTimeout(5, TimeUnit.MINUTES).writeTimeout(5, TimeUnit.MINUTES)
        .followRedirects(false).followSslRedirects(false).build()
    private var origin = ""
    private var token = ""

    fun configure(address: String, pairingToken: String) {
        val uri = java.net.URI(address)
        require(uri.scheme in listOf("http", "https") && uri.host != null && uri.userInfo == null && uri.query == null) { "Invalid desktop address." }
        require(pairingToken.isNotBlank()) { "Pair the desktop vault first." }
        origin = address.trimEnd('/')
        token = pairingToken
    }

    fun requestAuthorization(publicKey: String, name: String): JSONObject = execute(Request.Builder().url("$origin/api/plaud/authorizations")
        .post(JSONObject().put("publicKey", publicKey).put("name", name).toString().toRequestBody("application/json".toMediaType())))
    fun authorization(id: String): JSONObject { require(id.matches(Regex("[a-f0-9-]{36}"))); return execute(Request.Builder().url("$origin/api/plaud/authorizations/$id")) }
    fun acknowledgeAuthorization(id: String): JSONObject { require(id.matches(Regex("[a-f0-9-]{36}"))); return execute(Request.Builder().url("$origin/api/plaud/authorizations/$id/acknowledge").post("{}".toRequestBody("application/json".toMediaType()))) }

    fun exportAudio(directory: File, id: String, filename: String): File {
        require(id.matches(Regex("[a-zA-Z0-9-]+"))) { "Invalid recording ID." }
        directory.mkdirs()
        val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(120).ifEmpty { "recording.ogg" }
        val target = File(directory, "${System.currentTimeMillis()}-$safeName")
        val request = Request.Builder().url("$origin/api/recordings/$id/audio").header("X-OpenPlod-Token", token).build()
        client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Audio export failed (HTTP ${response.code})." }
            val body = response.body ?: error("Desktop returned no audio.")
            try {
                body.byteStream().use { input -> target.outputStream().use { input.copyTo(it) } }
                check(target.length() > 0) { "Desktop returned empty audio." }
            } catch (error: Exception) { target.delete(); throw error }
        }
        return target
    }

    /**
     * Sends one locally retained recording to the desktop vault. Uses the resumable protocol
     * (MOB-02) so an interrupted upload continues from the desktop's committed byte offset; the
     * transfer ID is persisted before any byte is sent. Local audio is never deleted here: the
     * row only records the durable acknowledgement once the desktop fingerprint matches.
     */
    fun upload(store: PlaudStore, id: String): JSONObject {
        val row = store.row(id)
        val file = store.file(id)
        try {
            val result = try { uploadResumable(store, id, row, file) } catch (unsupported: ResumableUnsupported) { uploadSingle(row, file, id) }
            val recordingId = result.getString("recordingId")
            require(recordingId.isNotBlank()) { "Desktop returned no recording ID." }
            store.acknowledge(id, recordingId, result.getString("fingerprint"))
            return result
        } catch (error: Exception) {
            runCatching { store.recordUploadFailure(id, error.message ?: "Upload failed; local audio retained.") }
            throw error
        }
    }

    private class ResumableUnsupported : Exception()

    private fun uploadResumable(store: PlaudStore, id: String, row: JSONObject, file: File): JSONObject {
        val size = file.length()
        val metadata = JSONObject().put("sourceProvider", "plaud").put("sourceRecordingId", id)
            .put("recordedAt", row.getString("recordedAt")).put("durationMs", row.getLong("durationMs"))
        val request = JSONObject().put("fingerprint", row.getString("fingerprint")).put("size", size)
            .put("filename", file.name).put("metadata", metadata)
        val start = try {
            execute(Request.Builder().url("$origin/api/mobile/uploads").post(request.toString().toRequestBody(JSON_TYPE)))
        } catch (error: VaultHttpException) {
            if (error.code == 404 || error.code == 405) throw ResumableUnsupported() else throw error
        }
        val transferId = start.getString("transferId")
        require(transferId.matches(Regex("[a-f0-9-]{36}"))) { "Desktop returned an invalid transfer ID." }
        store.recordTransfer(id, transferId)
        val advertised = start.optLong("maxChunkBytes", CHUNK_BYTES.toLong())
        val chunkBytes = (if (advertised in 1..CHUNK_BYTES.toLong()) advertised else CHUNK_BYTES.toLong()).toInt()
        var offset = start.getLong("offset")
        var failures = 0
        var restarted = false
        var acknowledgement: JSONObject? = null
        val input = RandomAccessFile(file, "r")
        try {
            while (acknowledgement == null) {
                while (offset < size) {
                    val length = minOf(chunkBytes.toLong(), size - offset).toInt()
                    val bytes = ByteArray(length)
                    input.seek(offset)
                    input.readFully(bytes)
                    try {
                        val state = execute(Request.Builder().url("$origin/api/mobile/uploads/$transferId")
                            .header("Content-Range", "bytes $offset-${offset + length - 1}/$size")
                            .header("X-Chunk-SHA256", sha256(bytes))
                            .put(bytes.toRequestBody(OCTET_TYPE)))
                        val next = state.getLong("offset")
                        if (next > offset) failures = 0
                        offset = next
                    } catch (error: Exception) {
                        if (error is VaultHttpException && error.code in listOf(401, 403, 404)) throw error
                        failures += 1
                        if (failures >= MAX_ATTEMPTS) throw error
                        Thread.sleep(minOf(8000L, 500L shl (failures - 1)))
                        val reported = (error as? VaultHttpException)?.payload?.optJSONObject("data")?.optLong("offset", -1L) ?: -1L
                        offset = if (reported >= 0) reported else committedOffset(transferId, offset)
                    }
                }
                try {
                    acknowledgement = execute(Request.Builder().url("$origin/api/mobile/uploads/$transferId/complete").post("{}".toRequestBody(JSON_TYPE)))
                } catch (error: VaultHttpException) {
                    val code = error.payload?.optString("code")
                    if (code == "fingerprint_mismatch" && !restarted) { restarted = true; offset = 0 }
                    else if (code == "incomplete" && failures + 1 < MAX_ATTEMPTS) { failures += 1; offset = committedOffset(transferId, offset) }
                    else throw error
                }
            }
        } finally { input.close() }
        return acknowledgement!!
    }

    private fun committedOffset(transferId: String, fallback: Long): Long =
        runCatching { execute(Request.Builder().url("$origin/api/mobile/uploads/$transferId")).getLong("offset") }.getOrDefault(fallback)

    /** Single-request upload for desktops that predate resumable transfers. */
    private fun uploadSingle(row: JSONObject, file: File, id: String): JSONObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name, file.asRequestBody((if (file.extension == "ogg") "audio/ogg" else "audio/mpeg").toMediaType()))
            .addFormDataPart("source_provider", "plaud")
            .addFormDataPart("source_recording_id", id)
            .addFormDataPart("recorded_at", row.getString("recordedAt"))
            .addFormDataPart("duration_ms", row.getLong("durationMs").toString())
            .addFormDataPart("fingerprint", row.getString("fingerprint")).build()
        return execute(Request.Builder().url("$origin/api/mobile/recordings").post(body))
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun execute(builder: Request.Builder): JSONObject {
        check(origin.isNotEmpty()) { "Pair the desktop vault first." }
        client.newCall(builder.header("X-OpenPlod-Token", token).build()).execute().use { response ->
            val body = response.body?.string().orEmpty()
            val payload = runCatching { JSONObject(body) }.getOrNull()
            if (!response.isSuccessful || payload?.optBoolean("success") != true) {
                val message = payload?.optString("error")?.take(200)
                throw VaultHttpException(response.code, payload, message?.takeIf { it.isNotBlank() } ?: "Desktop request failed (HTTP ${response.code}).")
            }
            return payload.getJSONObject("data")
        }
    }

    private companion object {
        const val CHUNK_BYTES = 4 * 1024 * 1024
        const val MAX_ATTEMPTS = 4
        val JSON_TYPE = "application/json".toMediaType()
        val OCTET_TYPE = "application/octet-stream".toMediaType()
    }
}
