/**
 * ZK Proof Generation Utilities
 * 
 * This file provides functions for generating zero-knowledge proofs for privacy-preserving 
 * transactions on Solana. It handles both snarkjs and zkutil proof generation workflows.
 * 
 * Inspired by: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/prover.js
 */

/// <reference types="node" />

import * as anchor from "@coral-xyz/anchor";
import { wtns, groth16 } from 'snarkjs'
import * as fs from 'fs'
import * as tmp from 'tmp-promise'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'
import { FIELD_SIZE } from './constants'
import * as path from 'path'

// @ts-ignore - ignore TypeScript errors for ffjavascript
import { utils } from 'ffjavascript'

// Type definitions for external modules
type WtnsModule = {
  debug: (input: any, wasmFile: string, wtnsFile: string, symFile: string, options: any, logger: any) => Promise<void>
  exportJson: (wtnsFile: string) => Promise<any>
}

type Groth16Module = {
  fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ proof: Proof; publicSignals: string[] }>
  verify: (vkeyData: any, publicSignals: any, proof: Proof) => Promise<boolean>
}

type UtilsModule = {
  stringifyBigInts: (obj: any) => any
  unstringifyBigInts: (obj: any) => any
}

// Cast imported modules to their types
const wtnsTyped = wtns as unknown as WtnsModule
const groth16Typed = groth16 as unknown as Groth16Module
const utilsTyped = utils as unknown as UtilsModule

const exec = promisify(execCallback)

// Define interfaces for the proof structures
interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

interface ProofResult {
  proof: Proof
}

/**
 * Generates a ZK proof using snarkjs and formats it for use on-chain
 * 
 * @param input The circuit inputs to generate a proof for
 * @param keyBasePath The base path for the circuit keys (.wasm and .zkey files)
 * @returns A proof object with formatted proof elements and public signals
 */
async function prove(input: any, keyBasePath: string): Promise<{
  proof: Proof
  publicSignals: string[];
}> {
  // console.log('Generating proof for inputs:', input)
  
  // Generate the proof using snarkjs
  // const { proof, publicSignals } = await groth16Typed.fullProve(
  //   utilsTyped.stringifyBigInts(input),
  //   `${keyBasePath}.wasm`,
  //   `${keyBasePath}.zkey`,
  // )

  return await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`,
  )
  
  // console.log('Original proof:', JSON.stringify(proof, null, 2))
  // console.log('Public signals:', JSON.stringify(publicSignals, null, 2))
  
  // // Process the proof similarly to Darklake's implementation
  // const proofProc = utilsTyped.unstringifyBigInts(proof)
  // const publicSignalsUnstringified = utilsTyped.unstringifyBigInts(publicSignals)
  
  // // referencing https://github.com/darklakefi/darklake-monorepo/blob/d0357ebc791e1f369aa24309385e86b715bd2bff/web-old/lib/prepare-proof.ts#L61 for post processing
  // // Load ffjavascript curve utilities
  // // We use require instead of import due to TypeScript module issues
  // const curve = await ffjavascript.buildBn128()
  
  // // Format proof elements
  // let proofA = g1Uncompressed(curve, proofProc.pi_a)
  // proofA = await negateAndSerializeG1(curve, proofA)
  
  // const proofB = g2Uncompressed(curve, proofProc.pi_b)
  // const proofC = g1Uncompressed(curve, proofProc.pi_c)
  
  // // Format public signals
  // const formattedPublicSignals = publicSignalsUnstringified.map(
  //   (signal: any) => {
  //     return to32ByteBuffer(BigInt(signal))
  //   }
  // )
  
  // return {
  //   proofA: proofA,
  //   proofB: proofB,
  //   proofC: proofC,
  //   publicSignals: formattedPublicSignals,
  // }
}

async function verify(verificationKeyPath: string, publicSignals: any, proof: any): Promise<boolean> {
  // Load verification key from the specified path
  const vKey = JSON.parse(fs.readFileSync(`${verificationKeyPath}`, 'utf8'));
  const res = await groth16Typed.verify(vKey, publicSignals, proof);
  return res;
}

/**
 * Generates a ZK proof using zkutil
 * 
 * This is an alternative proving method using the zkutil command line tool.
 * It creates temporary files for the witness and proof during the process.
 * 
 * @param input The circuit inputs to generate a proof for
 * @param keyBasePath The base path for the circuit keys
 * @returns A promise that resolves to a hex string of the proof
 */
function proveZkutil(input: any, keyBasePath: string): Promise<string> {
  input = utilsTyped.stringifyBigInts(input)
  // console.log('input', input)
  return tmp.dir().then(async (dir: { path: string }) => {
    const dirPath = dir.path
    let out: any

    try {
      // Generate witness
      await wtnsTyped.debug(
        utilsTyped.unstringifyBigInts(input),
        `${keyBasePath}.wasm`,
        `${dirPath}/witness.wtns`,
        `${keyBasePath}.sym`,
        {},
        console,
      )
      const witness = utilsTyped.stringifyBigInts(await wtnsTyped.exportJson(`${dirPath}/witness.wtns`))
      fs.writeFileSync(`${dirPath}/witness.json`, JSON.stringify(witness, null, 2))

      // Run zkutil prove command
      out = await exec(
        `zkutil prove -c ${keyBasePath}.r1cs -p ${keyBasePath}.params -w ${dirPath}/witness.json -r ${dirPath}/proof.json -o ${dirPath}/public.json`,
      )
      // Verify the generated proof
      await exec(`zkutil verify -p ${keyBasePath}.params -r ${dirPath}/proof.json -i ${dirPath}/public.json`)
    } catch (e) {
      console.log(out, e)
      throw e
    }
    // Return the proof as a hex string
    return '0x' + JSON.parse(fs.readFileSync(`${dirPath}/proof.json`).toString()).proof
  })
}

export function parseProofToBytesArray(
  proof: Proof,
  compressed: boolean = false,
): {
  proofA: number[];
  proofB: number[][];
  proofC: number[];
} {
  const proofJson = JSON.stringify(proof, null, 1);
  const mydata = JSON.parse(proofJson.toString());
  try {
    for (const i in mydata) {
      if (i == "pi_a" || i == "pi_c") {
        for (const j in mydata[i]) {
          mydata[i][j] = Array.from(
            utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j]), 32),
          ).reverse();
        }
      } else if (i == "pi_b") {
        for (const j in mydata[i]) {
          for (const z in mydata[i][j]) {
            mydata[i][j][z] = Array.from(
              utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j][z]), 32),
            );
          }
        }
      }
    }

    if (compressed) {
      const proofA = mydata.pi_a[0];
      // negate proof by reversing the bitmask
      const proofAIsPositive = yElementIsPositiveG1(
        new anchor.BN(mydata.pi_a[1]),
      )
        ? false
        : true;
      proofA[0] = addBitmaskToByte(proofA[0], proofAIsPositive);
      const proofB = mydata.pi_b[0].flat().reverse();
      const proofBY = mydata.pi_b[1].flat().reverse();
      const proofBIsPositive = yElementIsPositiveG2(
        new anchor.BN(proofBY.slice(0, 32)),
        new anchor.BN(proofBY.slice(32, 64)),
      );
      proofB[0] = addBitmaskToByte(proofB[0], proofBIsPositive);
      const proofC = mydata.pi_c[0];
      const proofCIsPositive = yElementIsPositiveG1(
        new anchor.BN(mydata.pi_c[1]),
      );
      proofC[0] = addBitmaskToByte(proofC[0], proofCIsPositive);
      return {
        proofA,
        proofB,
        proofC,
      };
    }
    return {
      proofA: [mydata.pi_a[0], mydata.pi_a[1]].flat(),
      proofB: [
        mydata.pi_b[0].flat().reverse(),
        mydata.pi_b[1].flat().reverse(),
      ].flat(),
      proofC: [mydata.pi_c[0], mydata.pi_c[1]].flat(),
    };
  } catch (error: any) {
    console.error("Error while parsing the proof.", error.message);
    throw error;
  }
}

// mainly used to parse the public signals of groth16 fullProve
export function parseToBytesArray(publicSignals: string[]): number[][] {
  const publicInputsJson = JSON.stringify(publicSignals, null, 1);
  const publicInputsBytesJson = JSON.parse(publicInputsJson.toString());
  try {
    const publicInputsBytes = new Array<Array<number>>();
    for (const i in publicInputsBytesJson) {
      const ref: Array<number> = Array.from([
        ...utils.leInt2Buff(utils.unstringifyBigInts(publicInputsBytesJson[i]), 32),
      ]).reverse();
      publicInputsBytes.push(ref);
    }

    return publicInputsBytes;
  } catch (error: any) {
    console.error("Error while parsing public inputs.", error.message);
    throw error;
  }
}

function yElementIsPositiveG1(yElement: anchor.BN): boolean {
  return yElement.lte(FIELD_SIZE.sub(yElement));
}

function yElementIsPositiveG2(yElement1: anchor.BN, yElement2: anchor.BN): boolean {
  const fieldMidpoint = FIELD_SIZE.div(new anchor.BN(2));

  // Compare the first component of the y coordinate
  if (yElement1.lt(fieldMidpoint)) {
    return true;
  } else if (yElement1.gt(fieldMidpoint)) {
    return false;
  }

  // If the first component is equal to the midpoint, compare the second component
  return yElement2.lt(fieldMidpoint);
}

// bitmask compatible with solana altbn128 compression syscall and arkworks' implementation
// https://github.com/arkworks-rs/algebra/blob/master/ff/src/fields/models/fp/mod.rs#L580
// https://github.com/arkworks-rs/algebra/blob/master/serialize/src/flags.rs#L18
// fn u8_bitmask(value: u8, inf: bool, neg: bool) -> u8 {
//     let mut mask = 0;
//     match self {
//         inf => mask |= 1 << 6,
//         neg => mask |= 1 << 7,
//         _ => (),
//     }
//     mask
// }
function addBitmaskToByte(byte: number, yIsPositive: boolean): number {
  if (!yIsPositive) {
    return (byte |= 1 << 7);
  } else {
    return byte;
  }
}

export { prove, proveZkutil, verify, Proof }