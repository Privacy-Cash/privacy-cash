declare module 'ffjavascript' {
  export const utils: {
    stringifyBigInts: (obj: any) => any;
    unstringifyBigInts: (obj: any) => any;
  };
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