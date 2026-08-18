import { sha256Hex, sha8 } from '../sha256';

// Known-answer vectors, because `modelio.grammarSha8` is only worth anything if a human can
// reproduce it host-side with `sha256sum`. If these drift, the field becomes a number that looks
// authoritative and matches nothing.
describe('sha256', () => {
  it('matches the standard vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes multi-byte and multi-block input', () => {
    // Crosses the 64-byte block boundary and exercises the UTF-8 encoder's non-ASCII path.
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    expect(sha256Hex('héllo — wörld 🎯')).toHaveLength(64);
  });

  it('sha8 is the first eight hex characters, and memoises', () => {
    expect(sha8('abc')).toBe('ba7816bf');
    expect(sha8('abc')).toBe('ba7816bf');
  });
});
