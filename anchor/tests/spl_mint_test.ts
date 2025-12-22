import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, createInitializeMintInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";

describe("zkcash - SPL Mint Validation (localnet-mint-checked feature)", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;

  // Generate keypairs for the accounts needed in the test
  let authority: anchor.web3.Keypair;
  let fundingAccount: anchor.web3.Keypair;
  let globalConfigPDA: PublicKey;

  before(async () => {
    authority = anchor.web3.Keypair.generate();
    fundingAccount = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the funding account
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      1000 * LAMPORTS_PER_SOL
    );

    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    // Transfer SOL from funding account to authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: authority.publicKey,
        lamports: 100 * LAMPORTS_PER_SOL,
      })
    );
    
    await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Calculate the PDA for the global config
    const [globalConfigPda] = await PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );
    globalConfigPDA = globalConfigPda;
    
    // Check if global config is already initialized
    const globalConfigInfo = await provider.connection.getAccountInfo(globalConfigPDA);
    if (!globalConfigInfo) {
      // Only initialize if it doesn't exist yet
      await program.methods
        .initialize()
        .accounts({
          globalConfig: globalConfigPDA,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
    }
  });

  it("SPL Fails to initialize tree for non-whitelisted mint address", async () => {
    // Create a random SPL token mint (not whitelisted)
    const randomMint = anchor.web3.Keypair.generate();
    
    const mintTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: randomMint.publicKey,
        space: 82,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(82),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        randomMint.publicKey,
        6,
        authority.publicKey,
        authority.publicKey
      )
    );
    await provider.sendAndConfirm(mintTx, [authority, randomMint]);

    // Try to initialize tree for this random mint - should fail with InvalidMintAddress
    const randomTreeAta = await getAssociatedTokenAddress(randomMint.publicKey, globalConfigPDA, true);
    
    try {
      await program.methods
        .initializeTreeAccountForSplToken(new anchor.BN(1000000000))
        .accounts({
          globalConfig: globalConfigPDA,
          authority: authority.publicKey,
          mint: randomMint.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      expect.fail("Tree initialization should have failed with invalid mint address error");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1782") || 
        errorString.includes("6018") ||
        errorString.includes("Invalid mint address: mint address is not allowed") ||
        errorString.includes("InvalidMintAddress")
      ).to.be.true;
    }
  });
});
