package com.openplod.vault

import android.content.Context
import android.media.MediaMetadataRetriever
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

class PlaudStore(context: Context) {
    val directory = File(context.filesDir, "plaud-audio").apply { mkdirs() }
    private val index = AtomicFile(File(directory, "index.json"))
    private val rows = linkedMapOf<String, JSONObject>()

    init {
        if (index.baseFile.exists()) {
            val values = JSONArray(index.openRead().use { it.bufferedReader().readText() })
            for (i in 0 until values.length()) {
                val row = values.getJSONObject(i)
                rows[row.getString("sourceRecordingId")] = row
            }
        }
    }

    @Synchronized fun list(): JSONArray = JSONArray(rows.values.map { JSONObject(it.toString()) })
    @Synchronized fun row(id: String): JSONObject = JSONObject(rows[id]?.toString() ?: error("Recording not downloaded."))
    @Synchronized fun file(id: String): File = File(directory, row(id).getString("filename")).also {
        check(it.isFile && it.length() > 0) { "The local audio file is unavailable." }
    }

    fun retain(sn: String, sessionId: Long, exported: File): JSONObject {
        require(sn.matches(Regex("[0-9A-F]{16}")) && sessionId > 0) { "Invalid Note Pro recording identity." }
        synchronized(this) { if (rows.containsKey("$sn:$sessionId")) return row("$sn:$sessionId") }
        check(exported.length() > 0) { "The device returned an empty audio file." }
        val header = ByteArray(4)
        exported.inputStream().use { check(it.read(header) == 4 && header.contentEquals("OggS".toByteArray())) {
            "The device export is not playable Ogg Opus audio. Original recording retained."
        } }
        val filename = "$sn-$sessionId.ogg"
        val target = File(directory, filename)
        if (exported.canonicalPath != target.canonicalPath) {
            val staging = File(directory, "$filename.part")
            staging.writeBytes(DirectPlaudProtocol.playbackOgg(exported.readBytes()))
            java.io.RandomAccessFile(staging, "rw").use { it.fd.sync() }
            check(staging.renameTo(target)) { "Could not commit local audio." }
        }
        return register(sn, sessionId, target)
    }

    private fun register(sn: String, sessionId: Long, target: File): JSONObject {
        val id = "$sn:$sessionId"
        val durationMs = duration(target)
        check(durationMs > 0) { "Audio duration could not be verified. Original bytes retained for retry." }
        val metadata = JSONObject().put("sourceRecordingId", id).put("sessionId", sessionId.toString())
            .put("deviceSerial", sn).put("filename", target.name).put("size", target.length())
            .put("fingerprint", fingerprint(target)).put("durationMs", durationMs)
            .put("recordedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).apply {
                timeZone = java.util.TimeZone.getTimeZone("UTC")
            }.format(java.util.Date(Math.multiplyExact(sessionId, 1000))))
            .put("desktopRecordingId", JSONObject.NULL)
        synchronized(this) {
            rows[id] = metadata
            try { persist() } catch (error: Exception) { rows.remove(id); throw error }
        }
        return JSONObject(metadata.toString())
    }

    @Synchronized fun acknowledge(id: String, recordingId: String, expected: String) {
        val current = rows[id] ?: error("Recording missing.")
        check(current.getString("fingerprint") == expected) { "Desktop audio fingerprint does not match. Local audio retained." }
        update(id) {
            it.put("desktopRecordingId", recordingId).put("acknowledgedAt", System.currentTimeMillis())
                .put("lastUploadError", JSONObject.NULL)
        }
    }

    /** Persists the resumable transfer ID before any byte is sent, so a retry resumes it. */
    @Synchronized fun recordTransfer(id: String, transferId: String) = update(id) { it.put("transferId", transferId) }

    /** Keeps the failed attempt visible in the outbox. The local audio is untouched. */
    @Synchronized fun recordUploadFailure(id: String, message: String) = update(id) {
        it.put("uploadAttempts", it.optInt("uploadAttempts", 0) + 1).put("lastUploadError", message.take(300))
            .put("lastUploadAt", System.currentTimeMillis())
    }

    /**
     * Outbox summary (MOB-03): recordings still waiting for a durable desktop acknowledgement,
     * how many of those last failed, and the local storage they use. Nothing is ever deleted
     * automatically; acknowledged recordings stay until the owner removes them.
     */
    @Synchronized fun outbox(): JSONObject {
        var pending = 0; var failed = 0; var acknowledged = 0; var bytes = 0L
        for (row in rows.values) {
            bytes += row.optLong("size", 0L)
            if (row.isNull("desktopRecordingId")) {
                pending += 1
                if (!row.isNull("lastUploadError") && row.optString("lastUploadError").isNotEmpty()) failed += 1
            } else acknowledged += 1
        }
        return JSONObject().put("pending", pending).put("failed", failed).put("acknowledged", acknowledged).put("bytes", bytes)
    }

    private fun update(id: String, change: (JSONObject) -> Unit) {
        val current = rows[id] ?: error("Recording missing.")
        val previous = JSONObject(current.toString())
        change(current)
        try { persist() } catch (error: Exception) { rows[id] = previous; throw error }
    }

    private fun persist() {
        val output = index.startWrite()
        try { output.write(list().toString().toByteArray()); index.finishWrite(output) }
        catch (error: Exception) { index.failWrite(output); throw error }
    }

    private fun duration(file: File): Long {
        val reader = MediaMetadataRetriever()
        return try {
            reader.setDataSource(file.absolutePath)
            reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } finally { reader.release() }
    }

    private fun fingerprint(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var count = input.read(buffer)
            while (count >= 0) { if (count > 0) digest.update(buffer, 0, count); count = input.read(buffer) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
