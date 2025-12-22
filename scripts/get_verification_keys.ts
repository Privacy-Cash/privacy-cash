/**
 * Converts a verifying key from a JSON file to a Rust struct.
 * 
 * Adapated from: https://github.com/Lightprotocol/groth16-solana/blob/master/parse_vk_to_rust.js
 * nr_pubinputs is updated to IC.length - 1, as founder of light protocol confirmed their original script was incorrect.
 */

// @ts-ignore
import * as ffjavascript from 'ffjavascript';
import * as fs from 'fs';

// Use type assertion for the utility functions
const utils = ffjavascript.utils as any;
const { unstringifyBigInts, leInt2Buff } = utils;

interface VerificationKey {
  vk_alpha_1: any[];
  vk_beta_2: any[][];
  vk_gamma_2: any[][];
  vk_delta_2: any[][];
  vk_alphabeta_12?: any[][][];
  IC: any[][];
}

async function main(): Promise<void> {
  const inputPath = '../artifacts/circuits/verifyingkey2.json';

  // Save original console.log
  const originalConsoleLog = console.log;
  // Temporarily disable console.log during processing
  console.log = () => {};

  try {
    const fileData = await fs.promises.readFile(inputPath);
    const mydata: VerificationKey = JSON.parse(fileData.toString());
    
    // Process vk_alpha_1
    for (const j in mydata.vk_alpha_1) {
      mydata.vk_alpha_1[j] = leInt2Buff(unstringifyBigInts(mydata.vk_alpha_1[j]), 32).reverse();
    }
    
    // Process vk_beta_2
    for (const j in mydata.vk_beta_2) {
      const tmp = Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_beta_2[j][0]), 32))
        .concat(Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_beta_2[j][1]), 32)))
        .reverse();
      
      mydata.vk_beta_2[j][0] = tmp.slice(0, 32);
      mydata.vk_beta_2[j][1] = tmp.slice(32, 64);
    }
    
    // Process vk_gamma_2
    for (const j in mydata.vk_gamma_2) {
      const tmp = Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_gamma_2[j][0]), 32))
        .concat(Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_gamma_2[j][1]), 32)))
        .reverse();
      
      mydata.vk_gamma_2[j][0] = tmp.slice(0, 32);
      mydata.vk_gamma_2[j][1] = tmp.slice(32, 64);
    }
    
    // Process vk_delta_2
    for (const j in mydata.vk_delta_2) {
      const tmp = Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_delta_2[j][0]), 32))
        .concat(Array.from(leInt2Buff(unstringifyBigInts(mydata.vk_delta_2[j][1]), 32)))
        .reverse();
      
      mydata.vk_delta_2[j][0] = tmp.slice(0, 32);
      mydata.vk_delta_2[j][1] = tmp.slice(32, 64);
    }
    
    // Process vk_alphabeta_12 if it exists
    if (mydata.vk_alphabeta_12) {
      for (const j in mydata.vk_alphabeta_12) {
        for (const z in mydata.vk_alphabeta_12[j]) {
          for (const u in mydata.vk_alphabeta_12[j][z]) {
            mydata.vk_alphabeta_12[j][z][u] = leInt2Buff(unstringifyBigInts(mydata.vk_alphabeta_12[j][z][u]));
          }
        }
      }
    }
    
    // Process IC
    for (const j in mydata.IC) {
      for (const z in mydata.IC[j]) {
        mydata.IC[j][z] = leInt2Buff(unstringifyBigInts(mydata.IC[j][z]), 32).reverse();
      }
    }
    
    // Restore original console.log before outputting the result
    console.log = originalConsoleLog;
    
    // Build the result string
    let result = `use groth16_solana::groth16::Groth16Verifyingkey;\n\npub const VERIFYING_KEY: Groth16Verifyingkey =  Groth16Verifyingkey {\n\tnr_pubinputs: ${mydata.IC.length - 1},\n\n`;
    
    // Add vk_alpha_g1
    result += "\tvk_alpha_g1: [\n";
    for (let j = 0; j < mydata.vk_alpha_1.length - 1; j++) {
      result += "\t\t" + Array.from(mydata.vk_alpha_1[j]) + ",\n";
    }
    result += "\t],\n\n";
    
    // Add vk_beta_g2
    result += "\tvk_beta_g2: [\n";
    for (let j = 0; j < mydata.vk_beta_2.length - 1; j++) {
      for (let z = 0; z < 2; z++) {
        result += "\t\t" + Array.from(mydata.vk_beta_2[j][z]) + ",\n";
      }
    }
    result += "\t],\n\n";
    
    // Add vk_gamme_g2
    result += "\tvk_gamme_g2: [\n";
    for (let j = 0; j < mydata.vk_gamma_2.length - 1; j++) {
      for (let z = 0; z < 2; z++) {
        result += "\t\t" + Array.from(mydata.vk_gamma_2[j][z]) + ",\n";
      }
    }
    result += "\t],\n\n";
    
    // Add vk_delta_g2
    result += "\tvk_delta_g2: [\n";
    for (let j = 0; j < mydata.vk_delta_2.length - 1; j++) {
      for (let z = 0; z < 2; z++) {
        result += "\t\t" + Array.from(mydata.vk_delta_2[j][z]) + ",\n";
      }
    }
    result += "\t],\n\n";
    
    // Add vk_ic
    result += "\tvk_ic: &[\n";
    
    for (const ic in mydata.IC) {
      result += "\t\t[\n";
      for (let j = 0; j < mydata.IC[ic].length - 1; j++) {
        result += "\t\t\t" + mydata.IC[ic][j] + ",\n";
      }
      result += "\t\t],\n";
    }
    result += "\t]\n};";
    
    // Output the full result
    console.log(result);
    
  } catch (err) {
    // Restore original console.log in case of error
    console.log = originalConsoleLog;
    console.error(err);
  }
}

main().catch(console.error);