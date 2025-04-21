/**
 * BN128 Curve Utility Functions
 * 
 * Functions for working with BN128 curve points for zero-knowledge proof generation.
 * Copied from https://github.com/darklakefi/darklake-monorepo/blob/d0357ebc791e1f369aa24309385e86b715bd2bff/apps/anchor/src/utils.ts
 */

// BN128 interface defined here to avoid TypeScript module resolution issues
interface BN128 {
  G1: {
    fromObject: (obj: any) => any;
    toRprUncompressed: (buff: Uint8Array, offset: number, point: any) => void;
    toAffine: (point: any) => any;
    neg: (point: any) => any;
    fromRprUncompressed: (buffer: Uint8Array, offset: number) => any;
  };
  G2: {
    fromObject: (obj: any) => any;
    toRprUncompressed: (buff: Uint8Array, offset: number, point: any) => void;
  };
}

export function to32ByteBuffer(bigInt: bigint): Uint8Array {
  const hexString = bigInt.toString(16).padStart(64, '0');
  return new Uint8Array(Buffer.from(hexString, 'hex'));
}

export function g1Uncompressed(curve: BN128, p1Raw: any): Uint8Array {
  const p1 = curve.G1.fromObject(p1Raw);
  const buff = new Uint8Array(64);
  curve.G1.toRprUncompressed(buff, 0, p1);
  return buff;
}

export async function negateAndSerializeG1(
  curve: BN128,
  p1Uncompressed: Uint8Array,
): Promise<Uint8Array> {
  const p1 = curve.G1.toAffine(curve.G1.fromRprUncompressed(p1Uncompressed, 0));
  const negatedP1 = curve.G1.neg(p1);
  const serializedNegatedP1 = new Uint8Array(64);
  curve.G1.toRprUncompressed(serializedNegatedP1, 0, negatedP1);
  return serializedNegatedP1;
}

export function g2Uncompressed(curve: BN128, p2Raw: any): Uint8Array {
  const p2 = curve.G2.fromObject(p2Raw);
  const buff = new Uint8Array(128);
  curve.G2.toRprUncompressed(buff, 0, p2);
  return buff;
} 