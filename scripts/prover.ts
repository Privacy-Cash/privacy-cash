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
 * Generates a ZK proof using snarkjs
 * 
 * @param input The circuit inputs to generate a proof for
 * @param keyBasePath The base path for the circuit keys (.wasm and .zkey files)
 * @returns A concatenated hex string of the proof elements
 */
async function prove(input: any, keyBasePath: string): Promise<string> {
  const { proof }: ProofResult = await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`,
  )
  
  // Format the proof as a single hex string for on-chain verification
  return (
    '0x' +
    toFixedHex(proof.pi_a[0]).slice(2) +
    toFixedHex(proof.pi_a[1]).slice(2) +
    toFixedHex(proof.pi_b[0][1]).slice(2) +
    toFixedHex(proof.pi_b[0][0]).slice(2) +
    toFixedHex(proof.pi_b[1][1]).slice(2) +
    toFixedHex(proof.pi_b[1][0]).slice(2) +
    toFixedHex(proof.pi_c[0]).slice(2) +
    toFixedHex(proof.pi_c[1]).slice(2)
  )
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