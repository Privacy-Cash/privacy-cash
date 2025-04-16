declare module 'ffjavascript' {
  export const utils: {
    stringifyBigInts: (obj: any) => any;
    unstringifyBigInts: (obj: any) => any;
  };
}

declare module 'snarkjs' {
  export const wtns: any;
  export const groth16: any;
}

declare module 'tmp-promise' {
  export function dir(): Promise<{ path: string }>;
} 