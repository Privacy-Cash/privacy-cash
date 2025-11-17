declare module 'ffjavascript' {
  export const utils: {
    unstringifyBigInts: (obj: any) => any;
    stringifyBigInts: (obj: any) => any;
    leBuff2int: (buff: Buffer) => bigint;
    leInt2Buff: (num: bigint, len: number) => Buffer;
  };
}

