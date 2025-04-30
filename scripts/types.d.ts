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

declare module 'snarkjs' {
  export const wtns: {
    debug: (input: any, wasmFile: string, wtnsFile: string, symFile: string, options: any, logger: any) => Promise<void>;
    exportJson: (wtnsFile: string) => Promise<any>;
  };
  
  export const groth16: {
    fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ 
      proof: {
        pi_a: string[];
        pi_b: string[][];
        pi_c: string[];
      };
      publicSignals: any;
    }>;
  };
}

declare module 'tmp-promise' {
  export function dir(): Promise<{ path: string }>;
} 