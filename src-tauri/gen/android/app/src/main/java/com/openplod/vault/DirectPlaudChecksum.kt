package com.openplod.vault

import org.json.JSONArray
import org.json.JSONObject

/**
 * REL-02 mirror of src/sync/transfer-checksum.ts.
 *
 * No captured real-device transfer identifies the CRC-16 variant behind the opcode-29
 * tail value, so CONFIRMED is null: every candidate is computed and recorded as
 * evidence, the status is "unverified-algorithm", and a transfer is never rejected
 * on an unconfirmed algorithm. Set CONFIRMED (here and in TypeScript) only after a
 * real capture matches exactly one variant.
 */
object DirectPlaudChecksum {
    data class Variant(val name: String, val poly: Int, val init: Int, val refIn: Boolean, val refOut: Boolean, val xorOut: Int)

    val VARIANTS = listOf(
        Variant("CRC-16/CCITT-FALSE", 0x1021, 0xffff, false, false, 0),
        Variant("CRC-16/XMODEM", 0x1021, 0, false, false, 0),
        Variant("CRC-16/KERMIT", 0x1021, 0, true, true, 0),
        Variant("CRC-16/X-25", 0x1021, 0xffff, true, true, 0xffff),
        Variant("CRC-16/MCRF4XX", 0x1021, 0xffff, true, true, 0),
        Variant("CRC-16/GENIBUS", 0x1021, 0xffff, false, false, 0xffff),
        Variant("CRC-16/SPI-FUJITSU", 0x1021, 0x1d0f, false, false, 0),
        Variant("CRC-16/MODBUS", 0x8005, 0xffff, true, true, 0),
        Variant("CRC-16/ARC", 0x8005, 0, true, true, 0),
        Variant("CRC-16/USB", 0x8005, 0xffff, true, true, 0xffff),
        Variant("CRC-16/UMTS", 0x8005, 0, false, false, 0),
    )
    val CONFIRMED: String? = null

    private fun reflect(value: Int, bits: Int): Int { var out = 0; for (i in 0 until bits) if (value and (1 shl i) != 0) out = out or (1 shl (bits - 1 - i)); return out }

    fun crc16(variant: Variant, bytes: ByteArray): Int {
        val poly = if (variant.refIn) reflect(variant.poly, 16) else variant.poly
        var crc = if (variant.refIn) reflect(variant.init, 16) else variant.init
        for (b in bytes) {
            val byte = b.toInt() and 255
            if (variant.refIn) { crc = crc xor byte; repeat(8) { crc = if (crc and 1 != 0) (crc ushr 1) xor poly else crc ushr 1 } }
            else { crc = crc xor (byte shl 8); repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor poly) and 0xffff else (crc shl 1) and 0xffff } }
        }
        if (variant.refIn != variant.refOut) crc = reflect(crc, 16)
        return (crc xor variant.xorOut) and 0xffff
    }

    /** Returns {status, algorithm, tailValue, candidateMatches}; status is "verified", "mismatch" or "unverified-algorithm". */
    fun evaluate(bytes: ByteArray, tail: Int, confirmed: String? = CONFIRMED): JSONObject {
        val matches = JSONArray()
        for (variant in VARIANTS) {
            val value = crc16(variant, bytes)
            val swapped = ((value and 255) shl 8) or (value ushr 8)
            if (value == tail) matches.put(JSONObject().put("algorithm", variant.name).put("byteOrder", "le"))
            else if (swapped == tail) matches.put(JSONObject().put("algorithm", variant.name).put("byteOrder", "be"))
        }
        val result = JSONObject().put("tailValue", tail).put("candidateMatches", matches)
        if (confirmed == null) return result.put("status", "unverified-algorithm").put("algorithm", JSONObject.NULL)
        val variant = requireNotNull(VARIANTS.firstOrNull { it.name == confirmed }) { "Unknown transfer checksum algorithm." }
        return result.put("algorithm", variant.name).put("status", if (crc16(variant, bytes) == tail) "verified" else "mismatch")
    }
}
