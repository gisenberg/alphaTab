/**
 * Produces a stable content key for a SoundFont layer. SHA-256 is used when
 * Web Crypto is available; the deterministic fallback keeps non-browser test
 * and legacy environments functional without making the key a security token.
 * @target web
 * @internal
 */
export async function computeSoundFontCacheKey(data: Uint8Array): Promise<string> {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi?.subtle) {
        const bytes =
            data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
                ? data.buffer
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const digest = await cryptoApi.subtle.digest('SHA-256', bytes as ArrayBuffer);
        return `sha256:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`;
    }

    let hash = 0x811c9dc5;
    for (const value of data) {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a32:${data.byteLength}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
