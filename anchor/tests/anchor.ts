import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Anchor } from "../target/types/anchor"; // This should be `zkcash` unless the program name is actually "anchor"
import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("anchor", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Make sure the program name matches what's generated
  const program = anchor.workspace.Anchor as Program<Anchor>;

  // Generate keypairs for the accounts needed in the test
  const treeAccount = anchor.web3.Keypair.generate();
  const authority = anchor.web3.Keypair.generate();

  // --- Funding the Authority Wallet ---
  before(async () => {
    // Airdrop SOL to the authority wallet.
    console.log(`Airdropping SOL to ${authority.publicKey.toBase58()}...`);
    const airdropSignature = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * LAMPORTS_PER_SOL // Airdrop 2 SOL
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
    const balance = await provider.connection.getBalance(authority.publicKey);
    console.log(`Authority balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    expect(balance).to.be.greaterThan(0);
  });

  it("Is initialized!", async () => {
    console.log(`Initializing with tree account: ${treeAccount.publicKey.toBase58()}`);
    console.log(`Using authority: ${authority.publicKey.toBase58()}`);
    
    const tx = await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccount.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([treeAccount, authority])
      .rpc();
    
    console.log("Initialization transaction signature", tx);

    // Since tree_account is an AccountLoader in the Rust program, we need to load it
    // Instead of:
    // const accountData = await program.account.treeAccount.fetch(treeAccountPDA.publicKey);
    
    // Try using the correct account name from your Rust program
    try {
      const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);
      console.log("Tree account data:", merkleTreeAccount);
      
      // Add assertions based on your initialize function's logic
      // expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    } catch (e) {
      console.log("Error fetching account:", e);
      
      // Debug - list available account types
      console.log("Available account types:", Object.keys(program.account));
    }
  });
});

