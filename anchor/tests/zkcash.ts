import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./constants";

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;

  // Generate keypairs for the accounts needed in the test
  const treeAccount = anchor.web3.Keypair.generate();
  const authority = anchor.web3.Keypair.generate();
  const recipient = anchor.web3.Keypair.generate();

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
      })
      .signers([treeAccount, authority])
      .rpc();
    
    console.log("Initialization transaction signature", tx);

    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);
    // console.log("Tree account data:", merkleTreeAccount);

    expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
    expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    expect(merkleTreeAccount.rootHistory[0]).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);

    for (let i = 0; i < DEFAULT_HEIGHT; i++) {
      expect(merkleTreeAccount.subtrees[i]).to.deep.equal(ZERO_BYTES[i]);
    }
  });

  it("Can execute transact instruction", async () => {
    console.log(`Testing transact instruction with recipient: ${recipient.publicKey.toBase58()}`);
    
    const proof: any = {
        proof: Buffer.from("mockProofData"),
        root: ZERO_BYTES[DEFAULT_HEIGHT],
        inputNullifiers: [
          Array(32).fill(1),
          Array(32).fill(2)
        ],
        outputCommitments: [
          Array(32).fill(3),
          Array(32).fill(4)
        ],
        publicAmount: new anchor.BN(100),
        extDataHash: Array(32).fill(5)
      };

      const extData: any = {
        recipient: recipient.publicKey,
        extAmount: new anchor.BN(-100),
        encryptedOutput1: Buffer.from("encryptedOutput1Data"),
        encryptedOutput2: Buffer.from("encryptedOutput2Data")
      };

      // Execute the transaction
      const tx = await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccount.publicKey,
          recipient: recipient.publicKey,
          signer: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      
      console.log("Transact transaction signature:", tx);
      expect(tx).to.be.a('string');
  });
});

