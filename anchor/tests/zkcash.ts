import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
import { getExtDataHash } from "../../scripts/utils/utils";

import * as crypto from "crypto";
import * as path from 'path';
import { Utxo } from "./lib/utxo";
import { parseProofToBytesArray, parseToBytesArray, prove, verify } from "./lib/prover";
import { utils } from 'ffjavascript';
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import { BN } from 'bn.js';

export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

import { MerkleTree } from "./lib/merkle_tree";

// Find nullifier PDAs for the given proof
function findNullifierPDAs(program: anchor.Program<any>, proof: any) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[0])],
    program.programId
  );
  
  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[1])],
    program.programId
  );
  
  return { nullifier0PDA, nullifier1PDA };
}

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;
  let lightWasm: LightWasm;

  // Generate keypairs for the accounts needed in the test
  let treeAccountPDA: PublicKey;
  let feeRecipientPDA: PublicKey;
  let treeBump: number;
  let feeRecipientBump: number;
  let authority: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let fundingAccount: anchor.web3.Keypair;
  let randomUser: anchor.web3.Keypair; // Random user for signing transactions

  // Initialize variables for tree token account
  let treeTokenAccountPDA: PublicKey;
  let treeTokenBump: number;

  // --- Funding a wallet to use for paying transaction fees ---
  before(async () => {
    // Generate a funding account to pay for transactions
    fundingAccount = anchor.web3.Keypair.generate();
    lightWasm = await WasmFactory.getInstance();
    
    // Airdrop SOL to the funding account
    console.log(`Airdropping SOL to funding account ${fundingAccount.publicKey.toBase58()}...`);
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      100 * LAMPORTS_PER_SOL // Airdrop 50 SOL
    );

    // Confirm the transaction
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    console.log("Airdrop complete.");

    // Check the balance
    const balance = await provider.connection.getBalance(fundingAccount.publicKey);
    console.log(`Funding account balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    expect(balance).to.be.greaterThan(0);
  });

  // Reset program state before each test
  beforeEach(async () => {
    // Generate a fresh authority keypair for each test (ensuring unique PDAs)
    authority = anchor.web3.Keypair.generate();

    // Transfer enough SOL from funding account to the new authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: authority.publicKey,
        lamports: 2 * LAMPORTS_PER_SOL, // Increase to 2 SOL to ensure enough for rent
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the authority has received funds
    const authorityBalance = await provider.connection.getBalance(authority.publicKey);
    expect(authorityBalance).to.be.greaterThan(0);
    
    // Generate new recipient keypair for each test
    recipient = anchor.web3.Keypair.generate();
    
    // Fund the recipient with SOL for rent exemption
    const recipientAirdropSignature = await provider.connection.requestAirdrop(recipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    // Confirm the airdrop
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: recipientAirdropSignature,
    });
    
    // Calculate the PDA for the tree account with the new authority
    const [treePda, pdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), authority.publicKey.toBuffer()],
      program.programId
    );
    treeAccountPDA = treePda;
    treeBump = pdaBump;

    // Calculate the PDA for the fee recipient account with the new authority
    const [feeRecipientPda, feeRecipientPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("fee_recipient"), authority.publicKey.toBuffer()],
      program.programId
    );
    feeRecipientPDA = feeRecipientPda;
    feeRecipientBump = feeRecipientPdaBump;
    
    // Calculate the PDA for the tree token account with the new authority
    const [treeTokenPda, treeTokenPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token"), authority.publicKey.toBuffer()],
      program.programId
    );
    treeTokenAccountPDA = treeTokenPda;
    treeTokenBump = treeTokenPdaBump;
    
    // Initialize a fresh tree account for each test
    try {
      await program.methods
        .initialize()
        .accounts({
          treeAccount: treeAccountPDA,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority]) // Only authority is a signer
        .rpc();
        
      // Fund the treeTokenAccount with SOL (do this after initialization)
      const treeTokenAirdropSignature = await provider.connection.requestAirdrop(treeTokenAccountPDA, 2 * LAMPORTS_PER_SOL);
      const latestBlockHash2 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash2.blockhash,
        lastValidBlockHeight: latestBlockHash2.lastValidBlockHeight,
        signature: treeTokenAirdropSignature,
      });
      
      // Fund the feeRecipientAccount with SOL
      const feeRecipientAirdropSignature = await provider.connection.requestAirdrop(feeRecipientPDA, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash3 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash3.blockhash,
        lastValidBlockHeight: latestBlockHash3.lastValidBlockHeight,
        signature: feeRecipientAirdropSignature,
      });
      
      // Generate a random user for signing transactions
      randomUser = anchor.web3.Keypair.generate();
      
      // Fund the random user with SOL
      const randomUserAirdropSignature = await provider.connection.requestAirdrop(randomUser.publicKey, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash4 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash4.blockhash,
        lastValidBlockHeight: latestBlockHash4.lastValidBlockHeight,
        signature: randomUserAirdropSignature,
      });
      
      // Check balances after funding
      const treeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
      const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
      const recipientBalance = await provider.connection.getBalance(recipient.publicKey);
      const randomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
      
      // Verify the initialization was successful
      const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
      expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
      expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
      expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
      expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
      expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);

      // Verify the fee recipient account was initialized correctly
      const feeRecipientAccount = await program.account.feeRecipientAccount.fetch(feeRecipientPDA);
      expect(feeRecipientAccount.authority.equals(authority.publicKey)).to.be.true;
      expect(feeRecipientAccount.bump).to.equal(feeRecipientBump);
    } catch (error) {
      console.error("Error initializing accounts:", error);
      // Get more detailed error information if available
      if ('logs' in error) {
        console.error("Error logs:", error.logs);
      }
      throw error;
    }
  });

  it("Can execute both deposit and withdraw instruction for correct input", async () => {
    // Create a sample ExtData object with original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(50), // Fee
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    console.log("\n=== Deposit Transaction ===");
    console.log("extAmount:", extData.extAmount.toString());
    console.log("fee:", extData.fee.toString());

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(20, lightWasm);
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(tree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = tree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: new anchor.BN(150),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output UTXO data (UTXOs being created) - ensure all values are in decimal format
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };

    // Path to the proving key files (wasm and zkey)
    // Try with both circuits to see which one works
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);

    publicSignals.forEach((signal, index) => {
      const signalStr = signal.toString();
      let matchedKey = 'unknown';
      
      // Try to identify which input this signal matches
      for (const [key, value] of Object.entries(input)) {
        if (Array.isArray(value)) {
          if (value.some(v => v.toString() === signalStr)) {
            matchedKey = key;
            break;
          }
        } else if (value.toString() === signalStr) {
          matchedKey = key;
          break;
        }
      }
    });
    

    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    // Create a Proof object with the correctly calculated hash
    const proofToSubmit = {
      proofA: proofInBytes.proofA, // 64-byte array for proofA
      proofB: proofInBytes.proofB.flat(), // 128-byte array for proofB  
      proofC: proofInBytes.proofC, // 64-byte array for proofC
      root: inputsInBytes[0],
      publicAmount: inputsInBytes[1],
      extDataHash: inputsInBytes[2],
      inputNullifiers: [
        inputsInBytes[3],
        inputsInBytes[4]
      ],
      outputCommitments: [
        inputsInBytes[5],
        inputsInBytes[6]
      ],
    };

    // Derive nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    // Execute the transaction without pre-instructions
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits])
      .rpc();
    
    expect(tx).to.be.a('string');
    
    // Now let's execute a withdrawal transaction
    // Get the updated tree account data after deposit
    const updatedTreeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '30' }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(20)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrwaOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrwaOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    console.log("!!!!!!withdrawPublicAmount:", {extAmount, withdrawFee, withdrawPublicAmount})

    console.log("\n=== Withdraw Transaction ===");
    console.log("withdrawInputsSum:", withdrawInputsSum.toString());
    console.log("withdrawOutputsSum:", withdrwaOutputsSum.toString());
    console.log("extAmount:", extAmount.toString());
    console.log("withdrawFee:", withdrawFee.toString());
    console.log("withdrawPublicAmount:", withdrawPublicAmount);
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      tree.insert(commitment);
    }

    const oldRoot = tree.root();

    console.log("!!!!oldRoot", oldRoot)
    console.log("!!!!updatedTreeAccountData.root", new BN(updatedTreeAccountData.root).toString(10))

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = tree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(tree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(tree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    console.log(withdrawInput)

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

    // Derive PDAs for withdrawal nullifiers
    const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .rpc();
    
    expect(withdrawTx).to.be.a('string');
  });

  // it("Fails transact instruction for the wrong extDataHash", async () => {
  //   // Create a sample ExtData object
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100),
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100),
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Create a different ExtData to generate a different hash
  //   const modifiedExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(100), // Different amount (positive instead of negative)
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100),
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the hash using the modified data
  //   const incorrectExtDataHash = getExtDataHash(modifiedExtData);
    
  //   // Create a Proof object with the incorrect hash
  //   const proof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)),
  //     extDataHash: Array.from(incorrectExtDataHash)
  //   };

  //   // Get nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);

  //   try {
  //     // Execute the transaction - this should fail because the hash doesn't match
  //     await program.methods
  //       .transact(proof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey,
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser])
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to invalid extDataHash but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6001); // ExtDataHashMismatch error code
  //       expect(error.error.errorMessage).to.equal("External data hash does not match the one in the proof");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Fails transact instruction for an unknown root", async () => {
  //   // Create a sample ExtData object
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100),
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100),
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the correct extDataHash
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create an invalid root (not in the tree's history)
  //   const invalidRoot = Array(32).fill(123); // Different from any known root
    
  //   // Create a Proof object with the invalid root but correct hash
  //   const proof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: invalidRoot,
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Get nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);

  //   try {
  //     // Execute the transaction - this should fail because the root is unknown
  //     await program.methods
  //       .transact(proof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey, // Use random user as signer
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser]) // Random user signs the transaction
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to unknown root but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6002); // UnknownRoot error code
  //       expect(error.error.errorMessage).to.equal("Root is not known in the tree");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Fails transact instruction for zero root", async () => {
  //   // Create a sample ExtData object
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100),
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100),
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the correct extDataHash
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const zeroRoot = Array(32).fill(0);
    
  //   // Create a Proof object with the invalid root but correct hash
  //   const proof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: zeroRoot,
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Get nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);

  //   try {
  //     // Execute the transaction - this should fail because the root is unknown
  //     await program.methods
  //       .transact(proof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey, // Use random user as signer
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser]) // Random user signs the transaction
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to unknown root but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6002); // UnknownRoot error code
  //       expect(error.error.errorMessage).to.equal("Root is not known in the tree");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Transact succeeds with the correct root", async () => {
  //   // Fetch the Merkle tree account to get the current root
  //   const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

  //   // This should now pass because we're using a fresh tree account for each test
  //   expect(treeAccountData.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    
  //   // Test that a transaction with the initial root works
  //   // Using original values
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100), // Original value
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100), // Original value
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create a Proof with the current valid root (initial root)
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: Array.from(treeAccountData.root), // Use the current valid root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)), // Original value
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Get nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);
    
  //   // This transaction should succeed because the root is valid
  //   const transactTx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(transactTx).to.be.a('string');
  // });

  // it("Transact succeeds after the second root update", async () => {
  //   // First transaction to update the root - use original values
  //   const firstExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100), // Original value
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100), // Original value
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const firstExtDataHash = getExtDataHash(firstExtData);
    
  //   const firstProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT], // Initial root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)), // Original value
  //     extDataHash: Array.from(firstExtDataHash)
  //   };
    
  //   // Find nullifier PDAs for the first proof
  //   const { nullifier0PDA: firstNullifier0PDA, nullifier1PDA: firstNullifier1PDA } = findNullifierPDAs(program, firstProof);
    
  //   // Note: No need for further funding as we fund in beforeEach
    
  //   // This transaction should succeed with the initial root
  //   await program.methods
  //     .transact(firstProof, firstExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: firstNullifier0PDA,
  //       nullifier1: firstNullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   // Fetch the updated root
  //   const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    
  //   // Second transaction with the updated root - use original values
  //   const secondExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100), // Original value
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100), // Original value
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedSecondExtDataHash = getExtDataHash(secondExtData);

  //   const secondValidProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: Array.from(treeAccountData.root), // Use the updated root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(7), // Different commitments
  //       Array(32).fill(8)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)), // Original value
  //     extDataHash: Array.from(calculatedSecondExtDataHash)
  //   };
    
  //   // Find nullifier PDAs for the second proof
  //   const { nullifier0PDA: secondNullifier0PDA, nullifier1PDA: secondNullifier1PDA } = findNullifierPDAs(program, secondValidProof);
    
  //   // Note: No need for further funding as we fund in beforeEach
    
  //   // This transaction should succeed because the root is valid
  //   const secondTransactTx = await program.methods
  //     .transact(secondValidProof, secondExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: secondNullifier0PDA,
  //       nullifier1: secondNullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   expect(secondTransactTx).to.be.a('string');
  // });

  // it("Succeeds with valid external amount and fee (withdrawal)", async () => {
  //   // For withdrawal test, use original values
  //   const extAmount = new anchor.BN(-100);
  //   const fee = new anchor.BN(100);
  //   const publicAmount = new anchor.BN(200);
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Transaction should succeed with original amounts
  //   const tx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(tx).to.be.a('string');
  // });

  // it("Succeeds with valid external amount and fee (deposit)", async () => {
  //   // For deposit test, use original values
  //   const extAmount = new anchor.BN(200);
  //   const fee = new anchor.BN(50);
  //   const publicAmount = new anchor.BN(150);
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Transaction should succeed with original amounts
  //   const tx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(tx).to.be.a('string');
  // });

  // it("Succeeds with zero fee", async () => {
  //   // Case with zero fee but non-zero external amount
  //   const extAmount = new anchor.BN(-100);
  //   const fee = new anchor.BN(0);
  //   const publicAmount = new anchor.BN(100);
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Transaction should succeed with zero fee
  //   const tx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(tx).to.be.a('string');
  // });

  // it("Fails with invalid external amount and public amount relation (withdrawal)", async () => {
  //   // For invalid withdrawal: ext_amount is negative, fee is positive, 
  //   // but |ext_amount| + fee != public_amount
  //   const extAmount = new anchor.BN(-100);
  //   const fee = new anchor.BN(50);
  //   const publicAmount = new anchor.BN(200); // Should be 150 but we set 200 to cause failure
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const invalidProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, invalidProof);

  //   try {
  //     // Transaction should fail due to invalid amount relation
  //     await program.methods
  //       .transact(invalidProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey, // Use random user as signer
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser]) // Random user signs the transaction
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to invalid amount relation but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6003);
  //       expect(error.error.errorMessage).to.equal("Public amount is invalid");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Fails with invalid external amount and public amount relation (deposit)", async () => {
  //   // For invalid deposit: ext_amount is positive, fee is positive, 
  //   // but ext_amount - fee != public_amount
  //   const extAmount = new anchor.BN(200);
  //   const fee = new anchor.BN(50);
  //   const publicAmount = new anchor.BN(100); // Should be 150 but we set 100 to cause failure
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const invalidProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, invalidProof);

  //   try {
  //     // Transaction should fail due to invalid amount relation
  //     await program.methods
  //       .transact(invalidProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey, // Use random user as signer
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser]) // Random user signs the transaction
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to invalid amount relation but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6003);
  //       expect(error.error.errorMessage).to.equal("Public amount is invalid");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Fails with negative fee, as hash check isn't valid for negative fee", async () => {
  //   // Case with negative fee, which should not be allowed
  //   const extAmount = new anchor.BN(-100);
  //   const fee = new anchor.BN(-10); // Negative fee should cause failure
  //   const publicAmount = new anchor.BN(90); // We're intentionally using the wrong formula to test fee validation
    
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const invalidProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, invalidProof);

  //   try {
  //     // Transaction should fail due to negative fee
  //     await program.methods
  //       .transact(invalidProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey, // Use random user as signer
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser]) // Random user signs the transaction
  //       .rpc();
      
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to negative fee but succeeded");
  //   } catch (error) {
  //     // Check if the error is an AnchorError with the expected error code
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(6001);
  //       expect(error.error.errorMessage).to.equal("External data hash does not match the one in the proof");
  //     } else {
  //       // If it's not an AnchorError or has the wrong error code, fail the test
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Succeeds with correct authority", async () => {
  //   // Use the correct authority with original values
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100), // Original value
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100), // Original value
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);

  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)), // Original value
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // This transaction should succeed with the correct authority
  //   const tx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();

  //   expect(tx).to.be.a('string');
  // });

  // it("Fails with mismatched authority with provided pda accounts", async () => {
  //   // Create a different authority
  //   const wrongAuthority = anchor.web3.Keypair.generate();
    
  //   // Fund the wrong authority
  //   const transferTx = new anchor.web3.Transaction().add(
  //     anchor.web3.SystemProgram.transfer({
  //       fromPubkey: fundingAccount.publicKey,
  //       toPubkey: wrongAuthority.publicKey,
  //       lamports: 1 * LAMPORTS_PER_SOL,
  //     })
  //   );
    
  //   // Send and confirm the transfer transaction
  //   const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
  //   await provider.connection.confirmTransaction(transferSignature);
    
  //   // Create the ext data and proof for transaction
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100),
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100),
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };
    
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);
    
  //   try {
  //     // Try to use the original PDA accounts but with wrongAuthority as the authority
  //     // This should trigger the authority check in the transact function
  //     await program.methods
  //       .transact(validProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: wrongAuthority.publicKey,
  //         signer: randomUser.publicKey,
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser])
  //       .rpc();
      
  //     expect.fail("Transaction should have failed due to mismatched fee recipient account authority but succeeded");
  //   } catch (error) {
  //     if (error instanceof anchor.AnchorError) {
  //       expect(error.error.errorCode.number).to.equal(3007); // Constraint violation error code
  //     } else {
  //       console.error("Unexpected error:", error);
  //       throw error;
  //     }
  //   }
  // });

  // it("Succeeds with explicitly matching authority for both accounts", async () => {
  //   // Create an alternative authority to emphasize the matching requirement
  //   const matchingAuthority = anchor.web3.Keypair.generate();
    
  //   // Fund the matching authority
  //   const transferTx = new anchor.web3.Transaction().add(
  //     anchor.web3.SystemProgram.transfer({
  //       fromPubkey: fundingAccount.publicKey,
  //       toPubkey: matchingAuthority.publicKey,
  //       lamports: 1 * LAMPORTS_PER_SOL,
  //     })
  //   );
    
  //   // Send and confirm the transfer transaction
  //   const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
  //   await provider.connection.confirmTransaction(transferSignature);
    
  //   // Verify the matching authority has received funds
  //   const matchingBalance = await provider.connection.getBalance(matchingAuthority.publicKey);
  //   expect(matchingBalance).to.be.greaterThan(0);
    
  //   // Calculate the PDAs for matching authority
  //   const [matchingTreePDA, matchingTreeBump] = await PublicKey.findProgramAddressSync(
  //     [Buffer.from("merkle_tree"), matchingAuthority.publicKey.toBuffer()],
  //     program.programId
  //   );
    
  //   const [matchingFeePDA, matchingFeeBump] = await PublicKey.findProgramAddressSync(
  //     [Buffer.from("fee_recipient"), matchingAuthority.publicKey.toBuffer()],
  //     program.programId
  //   );
    
  //   const [matchingTreeTokenPDA, matchingTreeTokenBump] = await PublicKey.findProgramAddressSync(
  //     [Buffer.from("tree_token"), matchingAuthority.publicKey.toBuffer()],
  //     program.programId
  //   );
    
  //   // Initialize accounts with the matching authority
  //   await program.methods
  //     .initialize()
  //     .accounts({
  //       tree_account: matchingTreePDA,
  //       fee_recipient_account: matchingFeePDA,
  //       tree_token_account: matchingTreeTokenPDA,
  //       authority: matchingAuthority.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([matchingAuthority])
  //     .rpc();
      
  //   // Verify the initialization was successful
  //   const matchingTreeAccount = await program.account.merkleTreeAccount.fetch(matchingTreePDA);
  //   expect(matchingTreeAccount.authority.equals(matchingAuthority.publicKey)).to.be.true;
    
  //   const matchingFeeAccount = await program.account.feeRecipientAccount.fetch(matchingFeePDA);
  //   expect(matchingFeeAccount.authority.equals(matchingAuthority.publicKey)).to.be.true;
    
  //   // Generate a new random user specifically for this test to be clear
  //   const testRandomUser = anchor.web3.Keypair.generate();
    
  //   // Fund this test's random user
  //   const testRandomUserAirdropSignature = await provider.connection.requestAirdrop(testRandomUser.publicKey, 1 * LAMPORTS_PER_SOL);
  //   const randomUserLatestBlockHash = await provider.connection.getLatestBlockhash();
  //   await provider.connection.confirmTransaction({
  //     blockhash: randomUserLatestBlockHash.blockhash,
  //     lastValidBlockHeight: randomUserLatestBlockHash.lastValidBlockHeight,
  //     signature: testRandomUserAirdropSignature,
  //   });
    
  //   // Now execute transaction with explicitly matching authorities
  //   // Using original values to test real behavior
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(-100), // Original value
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(100), // Original value
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };
    
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(200)), // Original value
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);
    
  //   // Fund matching tree token account explicitly
  //   const matchingTreeTokenBalance = await provider.connection.getBalance(matchingTreeTokenPDA);
  //   if (matchingTreeTokenBalance < 1 * LAMPORTS_PER_SOL) {
  //     const matchingTreeTokenAirdropSignature = await provider.connection.requestAirdrop(matchingTreeTokenPDA, 2 * LAMPORTS_PER_SOL);
  //     const latestBlockHash4 = await provider.connection.getLatestBlockhash();
  //     await provider.connection.confirmTransaction({
  //       blockhash: latestBlockHash4.blockhash,
  //       lastValidBlockHeight: latestBlockHash4.lastValidBlockHeight,
  //       signature: matchingTreeTokenAirdropSignature,
  //     });
  //   }
    
  //   // This transaction should succeed with the matching authority for both accounts
  //   const tx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: matchingTreePDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: matchingFeePDA,
  //       tree_token_account: matchingTreeTokenPDA,
  //       authority: matchingAuthority.publicKey, // Explicitly matching authority
  //       signer: testRandomUser.publicKey, // Random user as signer, not the authority
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([testRandomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(tx).to.be.a("string");
    
  //   // Additional assertion to emphasize that the transaction succeeded
  //   // Fetch the tree account to verify it was updated after the transaction
  //   const updatedTreeAccount = await program.account.merkleTreeAccount.fetch(matchingTreePDA);
  //   expect(updatedTreeAccount.nextIndex.toString()).to.equal("2"); // Should be 2 because we appended 2 output commitments
  // });

  // // Add new tests with original values
  // it("Can execute transact instruction with correct input and zero external amount", async () => {
  //   // Create a sample ExtData object with zero ext_amount but properly set public amount
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(0),  // Zero external amount - this is intentional for this test
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(0),  // Zero fee - this is intentional for this test
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the hash correctly using our utility
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create a Proof object with the correctly calculated hash
  //   const proof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],  // Use the initial zero root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);

  //   // Execute the transaction
  //   const tx = await program.methods
  //     .transact(proof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(tx).to.be.a('string');
  // });

  // it("Transact succeeds with the correct root using zero external amount", async () => {
  //   // Fetch the Merkle tree account to get the current root
  //   const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

  //   // This should pass because we're using a fresh tree account with the initial root
  //   expect(treeAccountData.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    
  //   // Test with zero external amount which is explicitly testing this case
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(0),  // Zero fee - intentional for this test
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create a Proof with the current valid root (initial root)
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: Array.from(treeAccountData.root), // Use the current valid root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   const transactTx = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(transactTx).to.be.a('string');
  // });

  // it("Multiple transactions succeed with zero external amount", async () => {
  //   // First transaction with zero amount - explicit test case
  //   const firstExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(0),  // Zero fee - intentional for this test
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const firstExtDataHash = getExtDataHash(firstExtData);
    
  //   const firstProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT], // Initial root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
  //     extDataHash: Array.from(firstExtDataHash)
  //   };

  //   // Find nullifier PDAs for the first transaction
  //   const { nullifier0PDA: firstNullifier0PDA, nullifier1PDA: firstNullifier1PDA } = findNullifierPDAs(program, firstProof);

  //   // First transaction should succeed with the initial root
  //   await program.methods
  //     .transact(firstProof, firstExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: firstNullifier0PDA,
  //       nullifier1: firstNullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   // Fetch the updated root
  //   const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    
  //   // Second transaction with zero amount and updated root - explicit test case
  //   const secondExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(0),  // Zero fee - intentional for this test
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedSecondExtDataHash = getExtDataHash(secondExtData);

  //   const secondValidProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: Array.from(treeAccountData.root), // Use the updated root
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(7), // Different commitments
  //       Array(32).fill(8)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
  //     extDataHash: Array.from(calculatedSecondExtDataHash)
  //   };

  //   // Find nullifier PDAs for the second transaction
  //   const { nullifier0PDA: secondNullifier0PDA, nullifier1PDA: secondNullifier1PDA } = findNullifierPDAs(program, secondValidProof);
    
  //   const secondTransactTx = await program.methods
  //     .transact(secondValidProof, secondExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: secondNullifier0PDA,
  //       nullifier1: secondNullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey, // Use random user as signer
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser]) // Random user signs the transaction
  //     .rpc();
    
  //   expect(secondTransactTx).to.be.a('string');
  // });

  // it("Verifies SOL transfers are correct for deposit (positive ext_amount)", async () => {
  //   // Setup test parameters
  //   const extAmount = new anchor.BN(1000000); // 0.001 SOL (positive for deposit)
  //   const fee = new anchor.BN(200000);       // 0.0002 SOL fee
  //   const publicAmount = new anchor.BN(800000); // 0.0008 SOL (extAmount - fee)
    
  //   // First we need to fund the recipient to have enough SOL for the deposit
  //   const transferTx = new anchor.web3.Transaction().add(
  //     anchor.web3.SystemProgram.transfer({
  //       fromPubkey: fundingAccount.publicKey,
  //       toPubkey: recipient.publicKey,
  //       lamports: extAmount.toNumber() * 5, // Plenty for the test, increased amount
  //     })
  //   );
    
  //   const transferSig = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
  //   await provider.connection.confirmTransaction(transferSig);
    
  //   // Get balances before transaction
  //   const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // console.log(`Before transaction:`);
  //   // console.log(`Tree token account balance: ${treeTokenAccountBalanceBefore}`);
  //   // console.log(`Fee recipient balance: ${feeRecipientBalanceBefore}`);
  //   // console.log(`Recipient balance: ${recipientBalanceBefore}`);
  //   // console.log(`Random user balance: ${randomUserBalanceBefore}`);
    
  //   // Create the external data
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create the proof
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Find nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Execute the deposit transaction and store the transaction signature
  //   const txSignature = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   // Get balances after transaction
  //   const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // console.log(`After transaction:`);
  //   // console.log(`Tree token account balance: ${treeTokenAccountBalanceAfter}`);
  //   // console.log(`Fee recipient balance: ${feeRecipientBalanceAfter}`);
  //   // console.log(`Recipient balance: ${recipientBalanceAfter}`);
  //   // console.log(`Random user balance: ${randomUserBalanceAfter}`);
    
  //   // Calculate differences
  //   const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
  //   const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
  //   const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
  //   const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;
    
  //   // Log values for debugging
  //   // console.log(`Tree token account diff: ${treeTokenAccountDiff}`);
  //   // console.log(`Fee recipient diff: ${feeRecipientDiff}`);
  //   // console.log(`Recipient diff: ${recipientDiff}`);
  //   // console.log(`Random user diff: ${randomUserDiff}`);
    
  //   // For deposits in zkcash:
  //   // 1. Tree token account should increase by publicAmount = extAmount - fee
  //   // 2. Fee recipient should increase by fee
  //   // 3. Recipient gets nothing
  //   // 4. Random user pays for extAmount (which includes the fee)
    
  //   expect(treeTokenAccountDiff).to.be.equals(publicAmount.toNumber());
  //   expect(feeRecipientDiff).to.be.equals(fee.toNumber());
  //   expect(recipientDiff).to.be.equals(0);
  //   // accounts for the transaction fee
  //   expect(randomUserDiff).to.be.lessThan(-extAmount.toNumber());
  // });

  // it("Verifies SOL transfers are correct for withdrawal (negative ext_amount)", async () => {
  //   // Setup test parameters
  //   const extAmount = new anchor.BN(-1000000); // -0.001 SOL (negative for withdrawal)
  //   const fee = new anchor.BN(200000);        // 0.0002 SOL fee
  //   const publicAmount = new anchor.BN(1200000); // 0.0012 SOL (|extAmount| + fee)
    
  //   // Get balances before transaction
  //   const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // Create the external data
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create the proof
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(7), // Different commitments
  //       Array(32).fill(8)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Derive nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Execute the withdrawal transaction and store the transaction signature
  //   const txSignature = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   // Get balances after transaction
  //   const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // Calculate differences
  //   const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
  //   const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
  //   const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
  //   const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;
    
  //   // Log values for debugging
  //   // console.log(`Tree token account diff: ${treeTokenAccountDiff}`);
  //   // console.log(`Fee recipient diff: ${feeRecipientDiff}`);
  //   // console.log(`Recipient diff: ${recipientDiff}`);
  //   // console.log(`Random user diff: ${randomUserDiff}`);
    
  //   // Verify the correct SOL transfers took place
  //   expect(treeTokenAccountDiff).to.be.equals(extAmount.toNumber() - fee.toNumber());
  //   expect(feeRecipientDiff).to.be.equals(fee.toNumber());
  //   expect(recipientDiff).to.be.equals(-extAmount.toNumber());
    
  //   // Only verify that the random user paid some transaction fee (negative balance change)
  //   // without hardcoding the specific amount
  //   expect(randomUserDiff).to.be.lessThan(0);
  // });

  // it("Verifies SOL transfers are correct with zero fee", async () => {
  //   // Setup test parameters - withdrawal with zero fee
  //   const extAmount = new anchor.BN(-1000000); // -0.001 SOL (negative for withdrawal)
  //   const fee = new anchor.BN(0);             // Zero fee
  //   const publicAmount = new anchor.BN(1000000); // 0.001 SOL (|extAmount| when fee is 0)
    
  //   // Get balances before transaction
  //   const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // Create the external data
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: extAmount,
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: fee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Create the proof
  //   const validProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(7), // Use different nullifier values to avoid collisions
  //       Array(32).fill(8)
  //     ],
  //     publicAmount: bnToBytes(publicAmount),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };

  //   // Derive nullifier PDAs
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);

  //   // Execute the withdrawal transaction with zero fee and store the transaction signature
  //   const txSignature = await program.methods
  //     .transact(validProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
      
  //   // Get balances after transaction
  //   const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
  //   const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
  //   const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // Calculate differences
  //   const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
  //   const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
  //   const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
  //   const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;
    
  //   // For withdrawals with zero fee:
  //   // 1. Tree token account should decrease by |extAmount|
  //   // 2. Fee recipient should not change
  //   // 3. Recipient should increase by |extAmount|
  //   // 4. Random user (signer) should decrease by transaction fee

  //   expect(-extAmount.toNumber()).to.be.equals(publicAmount.toNumber());
  //   expect(treeTokenAccountDiff).to.be.equals(extAmount.toNumber());
  //   expect(feeRecipientDiff).to.be.equals(0);
  //   expect(recipientDiff).to.be.equals(-extAmount.toNumber());
    
  //   // Only verify that the random user paid some transaction fee (negative balance change)
  //   // without hardcoding the specific amount
  //   expect(randomUserDiff).to.be.lessThan(0);
  // });

  // it("Verifies SOL balance is correct after a deposit and withdrawal all initials", async () => {
  //   // Setup test parameters for deposit
  //   const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL
  //   const depositFee = new anchor.BN(100_000_000);     // 0.1 SOL
  //   const depositPublicAmount = new anchor.BN(900_000_000); // 0.9 SOL (depositAmount - depositFee)

  //   // First we need to fund the random user to have enough SOL for the deposit
  //   const transferTx = new anchor.web3.Transaction().add(
  //     anchor.web3.SystemProgram.transfer({
  //       fromPubkey: fundingAccount.publicKey,
  //       toPubkey: randomUser.publicKey,
  //       lamports: depositAmount.toNumber() * 2, // Double the deposit amount to ensure enough funds
  //     })
  //   );
    
  //   const transferSig = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
  //   await provider.connection.confirmTransaction(transferSig);
    
  //   // Get initial balance of tree token account before any transactions
  //   const initialTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
  //   const initialRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);

  //   // 1. DEPOSIT TRANSACTION
  //   // Create the external data for deposit
  //   const depositExtData = {
  //     recipient: recipient.publicKey,
  //     extAmount: depositAmount,  // Positive for deposit
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: depositFee,
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const depositExtDataHash = getExtDataHash(depositExtData);
    
  //   // Create the proof for deposit
  //   const depositProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(33),
  //       Array(32).fill(34)
  //     ],
  //     publicAmount: bnToBytes(depositPublicAmount),
  //     extDataHash: Array.from(depositExtDataHash)
  //   };

  //   // Derive nullifier PDAs for deposit
  //   const { nullifier0PDA: depositNullifier0PDA, nullifier1PDA: depositNullifier1PDA } = findNullifierPDAs(program, depositProof);

  //   // Execute the deposit transaction
  //   const depositTxSignature = await program.methods
  //     .transact(depositProof, depositExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: depositNullifier0PDA,
  //       nullifier1: depositNullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   // Get balances after deposit
  //   const treeTokenBalanceAfterDeposit = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const feeRecipientBalanceAfterDeposit = await provider.connection.getBalance(feeRecipientPDA);
  //   const randomUserBalanceAfterDeposit = await provider.connection.getBalance(randomUser.publicKey);
    
  //   // Verify deposit worked correctly
  //   const treeTokenDepositDiff = treeTokenBalanceAfterDeposit - initialTreeTokenBalance;
  //   const feeRecipientDepositDiff = feeRecipientBalanceAfterDeposit - initialFeeRecipientBalance;
  //   const randomUserDepositDiff = randomUserBalanceAfterDeposit - initialRandomUserBalance;
    
  //   // Verify our deposit logic (not the exact account balances)
  //   expect(treeTokenDepositDiff).to.be.equals(depositPublicAmount.toNumber());
  //   expect(feeRecipientDepositDiff).to.be.equals(depositFee.toNumber());
  //   expect(randomUserDepositDiff).to.be.lessThan(-depositAmount.toNumber()); // Account for tx fee
    
  //   // Get the updated tree account to get the current root for withdrawal
  //   const treeAccountDataAfterDeposit = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    
  //   // 2. WITHDRAWAL TRANSACTION
  //   // Create the external data for withdrawal
  //   const withdrawAmount = new anchor.BN(-900_000_000); // -0.9 SOL (negative for withdrawal)
  //   const withdrawFee = new anchor.BN(0);              // 0 fee for simplicity
  //   const withdrawPublicAmount = new anchor.BN(900_000_000); // 0.9 SOL (|withdrawAmount| when fee is 0)
    
  //   const withdrawExtData = {
  //     recipient: randomUser.publicKey, // Withdraw back to the same user
  //     extAmount: withdrawAmount,       // Negative for withdrawal
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: withdrawFee,                // No fee on withdrawal
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   const withdrawExtDataHash = getExtDataHash(withdrawExtData);
    
  //   // Create the proof for withdrawal using the updated root
  //   const withdrawProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: Array.from(treeAccountDataAfterDeposit.root),
  //     inputNullifiers: [
  //       Array.from(generateRandomNullifier()),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(43),
  //       Array(32).fill(44)
  //     ],
  //     publicAmount: bnToBytes(withdrawPublicAmount),
  //     extDataHash: Array.from(withdrawExtDataHash)
  //   };

  //   // Derive nullifier PDAs for withdrawal
  //   const { nullifier0PDA: withdrawNullifier0PDA, nullifier1PDA: withdrawNullifier1PDA } = findNullifierPDAs(program, withdrawProof);

  //   // Execute the withdrawal transaction
  //   const withdrawTxSignature = await program.methods
  //     .transact(withdrawProof, withdrawExtData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: withdrawNullifier0PDA,
  //       nullifier1: withdrawNullifier1PDA,
  //       recipient: randomUser.publicKey, // Withdraw to random user
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
    
  //   // Get final balances after both transactions
  //   const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
  //   const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
  //   const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey)
    
  //   // Calculate the withdrawal diffs specifically
  //   const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenBalanceAfterDeposit;
  //   const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfterDeposit;
  //   const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfterDeposit;
    
  //   // Verify withdrawal logic worked correctly
  //   expect(treeTokenWithdrawDiff).to.be.equals(withdrawAmount.toNumber()); // Tree decreases by withdraw amount
  //   expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
  //   expect(randomUserWithdrawDiff).to.be.lessThan(-withdrawAmount.toNumber()); // User gets withdraw amount minus tx fee
    
  //   // Calculate overall diffs for the full cycle
  //   const treeTokenTotalDiff = finalTreeTokenBalance - initialTreeTokenBalance;
  //   const feeRecipientTotalDiff = finalFeeRecipientBalance - initialFeeRecipientBalance;
  //   const randomUserTotalDiff = finalRandomUserBalance - initialRandomUserBalance;
    
  //   // console.log("Verifying final balances...");
  //   // console.log(`Initial tree token balance: ${initialTreeTokenBalance}`);
  //   // console.log(`Tree token balance after deposit: ${treeTokenBalanceAfterDeposit}`);
  //   // console.log(`Final tree token balance: ${finalTreeTokenBalance}`);
  //   // console.log(`Tree token total difference: ${treeTokenTotalDiff}`);
    
  //   // Verify final balances
  //   // 1. Tree token account should be back to original amount (excluding the fee)
  //   expect(treeTokenTotalDiff).to.be.equals(0);
    
  //   // 2. Fee recipient keeps the fees
  //   expect(feeRecipientTotalDiff).to.be.equals(depositFee.toNumber() + withdrawFee.toNumber());
    
  //   // 3. Random user should have lost at least the fee amount plus some tx fees
  //   expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());
  // });

  // it("Should fail when trying to reuse the one existing nullifier", async () => {
  //   // Create a sample ExtData object for deposits
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(1000000), // 0.001 SOL
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(200000), // 0.0002 SOL
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the hash for the ext data
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Generate fixed nullifiers that we'll reuse
  //   const fixedNullifier0 = generateRandomNullifier();
    
  //   // Create a Proof object for the first transaction
  //   const firstProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(fixedNullifier0),
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(800000)), // extAmount - fee
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Find nullifier PDAs for the first transaction
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, firstProof);
    
  //   // First transaction should succeed
  //   await program.methods
  //     .transact(firstProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
      
  //   // Create a second proof with different commitment values but same nullifiers
  //   const secondProof = {
  //     proofA: Array(64).fill(1), // 64-byte array for proofA
  //     proofB: Array(128).fill(2), // 128-byte array for proofB  
  //     proofC: Array(64).fill(3), // 64-byte array for proofC
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(fixedNullifier0), // Same nullifiers as first transaction
  //       Array.from(generateRandomNullifier())
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(5), // Different commitments
  //       Array(32).fill(6)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(800000)),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Try to execute the second transaction with the same nullifiers
  //   try {
  //     await program.methods
  //       .transact(secondProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey,
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser])
  //       .rpc();
        
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to nullifier reuse but succeeded");
  //   } catch (error) {
  //     // We expect a system program error about account already existing
  //     expect(error.toString()).to.include("already in use");
  //   }
  // });

  // it("Should fail when trying to reuse the two existing nullifiers", async () => {
  //   // Create a sample ExtData object for deposits
  //   const extData = {
  //     recipient: recipient.publicKey,
  //     extAmount: new anchor.BN(1000000), // 0.001 SOL
  //     encryptedOutput1: Buffer.from("encryptedOutput1Data"),
  //     encryptedOutput2: Buffer.from("encryptedOutput2Data"),
  //     fee: new anchor.BN(200000), // 0.0002 SOL
  //     tokenMint: new PublicKey("11111111111111111111111111111111")
  //   };

  //   // Calculate the hash for the ext data
  //   const calculatedExtDataHash = getExtDataHash(extData);
    
  //   // Generate fixed nullifiers that we'll reuse
  //   const fixedNullifier1 = generateRandomNullifier();
  //   const fixedNullifier2 = generateRandomNullifier();
    
  //   // Create a Proof object for the first transaction
  //   const firstProof = {
  //     proof_a: Array(64).fill(1), // 64-byte array for proof_a
  //     proof_b: Array(128).fill(2), // 128-byte array for proof_b  
  //     proof_c: Array(64).fill(3), // 64-byte array for proof_c
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(fixedNullifier1),
  //       Array.from(fixedNullifier2)
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(3),
  //       Array(32).fill(4)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(800000)), // extAmount - fee
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Find nullifier PDAs for the first transaction
  //   const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, firstProof);
    
  //   // First transaction should succeed
  //   await program.methods
  //     .transact(firstProof, extData)
  //     .accounts({
  //       tree_account: treeAccountPDA,
  //       nullifier0: nullifier0PDA,
  //       nullifier1: nullifier1PDA,
  //       recipient: recipient.publicKey,
  //       fee_recipient_account: feeRecipientPDA,
  //       tree_token_account: treeTokenAccountPDA,
  //       authority: authority.publicKey,
  //       signer: randomUser.publicKey,
  //       system_program: anchor.web3.SystemProgram.programId
  //     })
  //     .signers([randomUser])
  //     .rpc();
      
  //   // Create a second proof with different commitment values but same nullifiers
  //   const secondProof = {
  //     proof_a: Array(64).fill(1), // 64-byte array for proof_a
  //     proof_b: Array(128).fill(2), // 128-byte array for proof_b  
  //     proof_c: Array(64).fill(3), // 64-byte array for proof_c
  //     root: ZERO_BYTES[DEFAULT_HEIGHT],
  //     inputNullifiers: [
  //       Array.from(fixedNullifier1), // Same nullifiers as first transaction
  //       Array.from(fixedNullifier2)
  //     ],
  //     outputCommitments: [
  //       Array(32).fill(5), // Different commitments
  //       Array(32).fill(6)
  //     ],
  //     publicAmount: bnToBytes(new anchor.BN(800000)),
  //     extDataHash: Array.from(calculatedExtDataHash)
  //   };
    
  //   // Try to execute the second transaction with the same nullifiers
  //   try {
  //     await program.methods
  //       .transact(secondProof, extData)
  //       .accounts({
  //         tree_account: treeAccountPDA,
  //         nullifier0: nullifier0PDA,
  //         nullifier1: nullifier1PDA,
  //         recipient: recipient.publicKey,
  //         fee_recipient_account: feeRecipientPDA,
  //         tree_token_account: treeTokenAccountPDA,
  //         authority: authority.publicKey,
  //         signer: randomUser.publicKey,
  //         system_program: anchor.web3.SystemProgram.programId
  //       })
  //       .signers([randomUser])
  //       .rpc();
        
  //     // If we reach here, the test should fail because the transaction should have thrown an error
  //     expect.fail("Transaction should have failed due to nullifier reuse but succeeded");
  //   } catch (error) {
  //     // We expect a system program error about account already existing
  //     expect(error.toString()).to.include("already in use");
  //   }
  // });
});

