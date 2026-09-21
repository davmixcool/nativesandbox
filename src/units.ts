/**
 * Units, so a size at a call site says what it is.
 *
 * `memory: 512` is ambiguous — megabytes, mebibytes or bytes, and the three differ by six
 * orders of magnitude. The type below removes the ambiguity at compile time: `Mebibytes` is a
 * branded number, so a bare `512` will not typecheck and the unit has to be written.
 *
 * The functions are identities in the sense that matters — `MiB(512) === 512` — because the
 * canonical unit IS the mebibyte. `GiB` and `KiB` convert into it. Nothing happens at runtime
 * beyond that arithmetic; this is a device for the reader and the compiler, and JavaScript
 * callers get the documentation value without the enforcement.
 */

declare const __mebibytes: unique symbol;

/** A size in mebibytes. Produced by `KiB`, `MiB`, `GiB` or `TiB`, never written bare. */
export type Mebibytes = number & { readonly [__mebibytes]: "Mebibytes" };

/** Kibibytes. Fractional in mebibytes — `KiB(512)` is `0.5`. */
export const KiB = (n: number): Mebibytes => (n / 1024) as Mebibytes;
/** Mebibytes, the canonical unit. */
export const MiB = (n: number): Mebibytes => n as Mebibytes;
/** Gibibytes. */
export const GiB = (n: number): Mebibytes => (n * 1024) as Mebibytes;
/** Tebibytes. */
export const TiB = (n: number): Mebibytes => (n * 1024 * 1024) as Mebibytes;
