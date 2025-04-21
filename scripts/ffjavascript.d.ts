declare module 'ffjavascript' {
  export interface Utils {
    stringifyBigInts: (obj: any) => any;
    unstringifyBigInts: (obj: any) => any;
    leInt2Buff: (n: any, len?: number) => Uint8Array;
    // Add other utility functions as needed
  }
  
  export const utils: Utils;
  
  // BN128 curve interface
  export interface BN128 {
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
  
  // Function to build BN128 curve
  export function buildBn128(): Promise<BN128>;
} 