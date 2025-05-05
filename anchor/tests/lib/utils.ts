import * as anchor from "@coral-xyz/anchor";
import { utils } from "ffjavascript";

/**
 * Converts an anchor.BN to a byte array of length 32 (little-endian format)
 * @param bn - The anchor.BN to convert
 * @returns A number array representing the bytes
 */
export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}
