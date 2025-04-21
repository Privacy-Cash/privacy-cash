/**
 * ZK Proof Generation Utilities
 * 
 * This file provides functions for generating zero-knowledge proofs for privacy-preserving 
 * transactions on Solana. It handles both snarkjs and zkutil proof generation workflows.
 * 
 * Inspired by: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/prover.js
 */

/// <reference types="node" />

import { wtns, groth16 } from 'snarkjs'
import { utils } from 'ffjavascript'
import * as fs from 'fs'
import * as tmp from 'tmp-promise'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'
import BN from 'bn.js'
import { to32ByteBuffer, g1Uncompressed, g2Uncompressed, negateAndSerializeG1 } from './bn128_utils'

// Type definitions for external modules
type WtnsModule = {
  debug: (input: any, wasmFile: string, wtnsFile: string, symFile: string, options: any, logger: any) => Promise<void>
  exportJson: (wtnsFile: string) => Promise<any>
}

type Groth16Module = {
  fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ proof: Proof; publicSignals: any }>
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
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
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
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  publicSignals: Uint8Array[];
}> {
  console.log('Generating proof for inputs:', input)
  
  // Generate the proof using snarkjs
  const { proof, publicSignals } = await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`,
  )
  
  console.log('Original proof:', JSON.stringify(proof, null, 2))
  console.log('Public signals:', JSON.stringify(publicSignals, null, 2))
  
  // Process the proof similarly to Darklake's implementation
  const proofProc = utilsTyped.unstringifyBigInts(proof)
  const publicSignalsUnstringified = utilsTyped.unstringifyBigInts(publicSignals)
  
  // referencing https://github.com/darklakefi/darklake-monorepo/blob/d0357ebc791e1f369aa24309385e86b715bd2bff/web-old/lib/prepare-proof.ts#L61 for post processing
  // Load ffjavascript curve utilities
  // We use require instead of import due to TypeScript module issues
  const ffjavascript = require('ffjavascript')
  const curve = await ffjavascript.buildBn128()
  
  // Format proof elements
  let proofA = g1Uncompressed(curve, proofProc.pi_a)
  proofA = await negateAndSerializeG1(curve, proofA)
  
  const proofB = g2Uncompressed(curve, proofProc.pi_b)
  const proofC = g1Uncompressed(curve, proofProc.pi_c)
  
  // Format public signals
  const formattedPublicSignals = publicSignalsUnstringified.map(
    (signal: any) => {
      return to32ByteBuffer(BigInt(signal))
    }
  )
  
  return {
    proofA: proofA,
    proofB: proofB,
    proofC: proofC,
    publicSignals: formattedPublicSignals,
  }
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

/** 
 * Converts a number to a fixed-length hex string 
 * 
 * Used to format proof elements as hex strings of consistent length
 * 
 * @param number The number to convert (can be BN, Buffer, or number)
 * @param length The length of the resulting hex string (default: 32)
 * @returns A hex string of the specified length
 */
function toFixedHex(number: any, length = 32): string {
  let result =
    '0x' +
    (number instanceof Buffer
      ? number.toString('hex')
      : new BN(number).toString('hex')
    ).padStart(length * 2, '0')
  if (result.indexOf('-') > -1) {
    result = '-' + result.replace('-', '')
  }
  return result
}

export { prove, proveZkutil }