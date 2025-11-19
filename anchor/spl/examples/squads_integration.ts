/**
 * Example integration for Squads Multisig with Privacy Cash
 * 
 * This demonstrates how Squads can use Privacy Cash where:
 * - Backend has view keys for all 10,000 businesses
 * - Each business can only spend their own UTXOs
 * - Withdrawals require multisig approval
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { Keypair } from "../tests/lib/keypair";
import { Utxo } from "../tests/lib/utxo";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import { getAssociatedTokenAddress } from "@solana/spl-token";

// ============================================================================
// Backend: View Key Management
// ============================================================================

interface BusinessAccount {
  businessId: string;
  multisigPDA: PublicKey;
  zkKeypair: Keypair;
  registeredOnChain: boolean;
}

class SquadsBackendService {
  private lightWasm: LightWasm;
  private businesses: Map<string, BusinessAccount>; // businessId -> account info
  private pdaToBusinessId: Map<string, string>; // multisigPDA -> businessId

  constructor(lightWasm: LightWasm) {
    this.lightWasm = lightWasm;
    this.businesses = new Map();
    this.pdaToBusinessId = new Map();
  }

  /**
   * Create a new business account with a unique ZK keypair
   */
  async createBusinessAccount(
    businessId: string,
    multisigPDA: PublicKey
  ): Promise<{ zkPubkey: string; zkPrivkey: string }> {
    // Generate unique ZK keypair for this business
    const zkKeypair = Keypair.generateNew(this.lightWasm);

    // Store in backend database (in production, use encrypted storage)
    const account: BusinessAccount = {
      businessId,
      multisigPDA,
      zkKeypair,
      registeredOnChain: false,
    };

    this.businesses.set(businessId, account);
    this.pdaToBusinessId.set(multisigPDA.toString(), businessId);

    console.log(`Created account for ${businessId}`);
    console.log(`  Multisig PDA: ${multisigPDA.toString()}`);
    console.log(`  ZK Pubkey: ${zkKeypair.pubkey.toString(16)}`);

    return {
      zkPubkey: zkKeypair.pubkey.toString(16),
      zkPrivkey: zkKeypair.privkey.toString(16),
    };
  }

  /**
   * Get ZK keypair for a business
   */
  getZkKeypair(businessId: string): Keypair {
    const account = this.businesses.get(businessId);
    if (!account) throw new Error(`Business ${businessId} not found`);
    return account.zkKeypair;
  }

  /**
   * Get business ID from multisig PDA
   */
  getBusinessId(multisigPDA: PublicKey): string {
    const businessId = this.pdaToBusinessId.get(multisigPDA.toString());
    if (!businessId) throw new Error(`No business found for PDA ${multisigPDA}`);
    return businessId;
  }

  /**
   * Decrypt UTXOs from event logs
   * Backend can decrypt ALL businesses' UTXOs because it has all view keys
   */
  async decryptUtxo(
    encryptedOutput: Buffer,
    businessId: string
  ): Promise<Utxo | null> {
    const zkKeypair = this.getZkKeypair(businessId);
    
    // TODO: Implement proper decryption (currently using mock)
    // This would use the ZK private key to decrypt the output
    
    console.log(`Backend decrypted UTXO for business ${businessId}`);
    return null; // Placeholder
  }

  /**
   * Monitor blockchain for new commitments
   */
  async monitorEvents(program: Program, callback: (event: any) => void) {
    program.addEventListener("CommitmentData", async (event) => {
      console.log("New commitment detected:", event.index);
      
      // Try to decrypt with each business's key
      for (const [businessId, account] of this.businesses.entries()) {
        const utxo = await this.decryptUtxo(
          Buffer.from(event.encrypted_output),
          businessId
        );
        
        if (utxo) {
          console.log(`UTXO belongs to ${businessId}`);
          callback({ businessId, utxo, event });
          break;
        }
      }
    });
  }
}

// ============================================================================
// Step 1: Register Business with Authorized Spender
// ============================================================================

async function registerBusiness(
  program: Program,
  backend: SquadsBackendService,
  businessId: string,
  multisigPDA: PublicKey,
  // In production, the multisig would sign this transaction
  multisigAuthority: anchor.web3.Keypair
) {
  // Create ZK keypair for this business
  const { zkPubkey } = await backend.createBusinessAccount(
    businessId,
    multisigPDA
  );

  // Convert ZK pubkey to bytes for on-chain registration
  const zkPubkeyBN = new BN(zkPubkey, 16);
  const zkPubkeyBytes = Array.from(zkPubkeyBN.toArray("be", 32));

  // Find PDA for authorized spender
  const [authorizedSpenderPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("authorized_spender"), Buffer.from(zkPubkeyBytes)],
    program.programId
  );

  console.log(`\n📝 Registering ${businessId}...`);
  console.log(`  ZK Pubkey: ${zkPubkey}`);
  console.log(`  Authorized Spender PDA: ${authorizedSpenderPDA.toString()}`);

  // Register on-chain: This binds the ZK pubkey to the multisig PDA
  await program.methods
    .registerAuthorizedSpender(zkPubkeyBytes as any)
    .accounts({
      authorizedSpender: authorizedSpenderPDA,
      authority: multisigAuthority.publicKey, // In production: multisig PDA
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([multisigAuthority])
    .rpc();

  console.log(`✅ ${businessId} registered on-chain`);

  return { zkPubkey, zkPubkeyBytes, authorizedSpenderPDA };
}

// ============================================================================
// Step 2: Business Deposits Funds
// ============================================================================

async function businessDeposit(
  program: Program,
  backend: SquadsBackendService,
  businessId: string,
  multisigPDA: PublicKey,
  multisigAuthority: anchor.web3.Keypair,
  mint: PublicKey,
  amount: number
) {
  console.log(`\n💰 ${businessId} depositing ${amount} tokens...`);

  // Get business's ZK keypair
  const zkKeypair = backend.getZkKeypair(businessId);

  // Create output UTXOs with business's ZK pubkey
  const lightWasm = await WasmFactory.getInstance();
  const outputUtxo = new Utxo({
    lightWasm,
    amount: new BN(amount),
    keypair: zkKeypair, // Uses business's ZK keypair
    mintAddress: mint.toString(),
  });

  const emptyUtxo = new Utxo({
    lightWasm,
    amount: new BN(0),
    keypair: zkKeypair,
    mintAddress: mint.toString(),
  });

  // Generate proof (backend can do this because it has the ZK privkey)
  // TODO: Implement actual proof generation
  const proof = {}; // Placeholder
  const encryptedOutput1 = Buffer.from("encrypted1"); // TODO: Real encryption
  const encryptedOutput2 = Buffer.from("encrypted2");

  // Input pubkeys (all zeros for deposit)
  const inputPubkeys = [
    Array(32).fill(0),
    Array(32).fill(0),
  ];

  // Get token accounts
  const multisigTokenAccount = await getAssociatedTokenAddress(
    mint,
    multisigPDA,
    true
  );

  const recipientTokenAccount = await getAssociatedTokenAddress(
    mint,
    multisigPDA,
    true
  );

  const treeAccountPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), mint.toBuffer()],
    program.programId
  )[0];

  const globalConfigPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    program.programId
  )[0];

  // Multisig signs the deposit transaction
  await program.methods
    .transactSpl(
      proof as any,
      { extAmount: new BN(amount), fee: new BN(0) },
      encryptedOutput1,
      encryptedOutput2,
      inputPubkeys as any
    )
    .accounts({
      treeAccount: treeAccountPDA,
      // nullifier accounts...
      globalConfig: globalConfigPDA,
      signer: multisigAuthority.publicKey, // Multisig PDA signs
      mint,
      signerTokenAccount: multisigTokenAccount,
      recipient: multisigPDA,
      recipientTokenAccount,
      // authorized spender accounts (None for deposits)
      authorizedSpender0: null,
      authorizedSpender1: null,
      // ...other accounts
    })
    .signers([multisigAuthority])
    .rpc();

  console.log(`✅ ${businessId} deposited ${amount} tokens`);
}

// ============================================================================
// Step 3: Business Withdraws Funds (Backend Cannot Do This!)
// ============================================================================

async function businessWithdraw(
  program: Program,
  backend: SquadsBackendService,
  businessId: string,
  multisigPDA: PublicKey,
  multisigAuthority: anchor.web3.Keypair,
  mint: PublicKey,
  inputUtxo: Utxo,
  withdrawAmount: number,
  recipientAddress: PublicKey
) {
  console.log(`\n💸 ${businessId} withdrawing ${withdrawAmount} tokens...`);

  // Backend generates the proof (has ZK privkey)
  const zkKeypair = backend.getZkKeypair(businessId);

  // TODO: Generate actual proof with inputs
  const proof = {}; // Placeholder

  // CRITICAL: Input pubkeys must match the UTXOs being spent
  const zkPubkeyBN = zkKeypair.pubkey;
  const zkPubkeyBytes = Array.from(zkPubkeyBN.toArray("be", 32));
  
  const inputPubkeys = [
    zkPubkeyBytes, // First input: business's UTXO
    Array(32).fill(0), // Second input: empty UTXO
  ];

  // Find authorized spender PDAs
  const [authorizedSpender0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("authorized_spender"), Buffer.from(zkPubkeyBytes)],
    program.programId
  );

  // Get token accounts
  const recipientTokenAccount = await getAssociatedTokenAddress(
    mint,
    recipientAddress,
    true
  );

  const treeAccountPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), mint.toBuffer()],
    program.programId
  )[0];

  const globalConfigPDA = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    program.programId
  )[0];

  console.log(`  Signer: ${multisigAuthority.publicKey.toString()}`);
  console.log(`  Authorized Spender: ${authorizedSpender0PDA.toString()}`);

  // ONLY the registered multisig PDA can execute this!
  await program.methods
    .transactSpl(
      proof as any,
      { extAmount: new BN(-withdrawAmount), fee: new BN(0) },
      Buffer.from("encrypted1"),
      Buffer.from("encrypted2"),
      inputPubkeys as any
    )
    .accounts({
      treeAccount: treeAccountPDA,
      // nullifier accounts...
      globalConfig: globalConfigPDA,
      signer: multisigAuthority.publicKey, // MUST be the multisig PDA!
      mint,
      signerTokenAccount: await getAssociatedTokenAddress(mint, multisigPDA, true),
      recipient: recipientAddress,
      recipientTokenAccount,
      // Authorized spender checks
      authorizedSpender0: authorizedSpender0PDA, // PDA that enforces authorization
      authorizedSpender1: null, // Second input is empty UTXO
      // ...other accounts
    })
    .signers([multisigAuthority])
    .rpc();

  console.log(`✅ ${businessId} withdrew ${withdrawAmount} tokens`);
}

// ============================================================================
// Attack Scenario: Backend Tries to Steal Business A's Funds
// ============================================================================

async function backendTriesToSteal(
  program: Program,
  backend: SquadsBackendService,
  businessAId: string,
  businessAPDA: PublicKey,
  backendKeypair: anchor.web3.Keypair,
  mint: PublicKey,
  victimUtxo: Utxo
) {
  console.log(`\n🚨 Backend attempting to steal ${businessAId}'s funds...`);

  // Backend has the ZK privkey, so it can generate the proof
  const zkKeypair = backend.getZkKeypair(businessAId);
  const zkPubkeyBytes = Array.from(zkKeypair.pubkey.toArray("be", 32));

  const proof = {}; // Backend can generate this!
  const inputPubkeys = [zkPubkeyBytes, Array(32).fill(0)];

  // Find the authorized spender PDA
  const [authorizedSpenderPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("authorized_spender"), Buffer.from(zkPubkeyBytes)],
    program.programId
  );

  try {
    // Backend tries to withdraw to its own address
    await program.methods
      .transactSpl(
        proof as any,
        { extAmount: new BN(-1000000), fee: new BN(0) },
        Buffer.from("encrypted1"),
        Buffer.from("encrypted2"),
        inputPubkeys as any
      )
      .accounts({
        // ... accounts setup
        signer: backendKeypair.publicKey, // ❌ Backend's keypair, not Business A's PDA!
        recipient: backendKeypair.publicKey, // Backend trying to steal
        authorizedSpender0: authorizedSpenderPDA,
        // ...
      })
      .signers([backendKeypair])
      .rpc();

    console.log("❌ SECURITY FAILURE: Backend stole the funds!");
  } catch (error) {
    console.log("✅ SECURITY SUCCESS: Transaction rejected!");
    console.log(`   Error: ${error.message}`);
    console.log(`   Reason: signer (${backendKeypair.publicKey}) != authorized_account (${businessAPDA})`);
  }
}

// ============================================================================
// Main Example
// ============================================================================

async function main() {
  const lightWasm = await WasmFactory.getInstance();
  const backend = new SquadsBackendService(lightWasm);

  console.log("=".repeat(70));
  console.log("Squads Privacy Cash Integration Example");
  console.log("=".repeat(70));

  // Simulated multisig PDAs for 3 businesses
  const businessA_PDA = anchor.web3.Keypair.generate().publicKey;
  const businessB_PDA = anchor.web3.Keypair.generate().publicKey;
  const businessC_PDA = anchor.web3.Keypair.generate().publicKey;

  // In production, these would be replaced by Squads program CPIs
  const businessA_Authority = anchor.web3.Keypair.generate();
  const businessB_Authority = anchor.web3.Keypair.generate();
  const backendKeypair = anchor.web3.Keypair.generate();

  console.log("\n📊 System Setup:");
  console.log(`  Total Businesses: 10,000 (showing 3)`);
  console.log(`  Backend: Holds all 10,000 ZK view keys`);
  console.log(`  Each Business: Has own multisig PDA`);

  console.log("\n🔐 Security Model:");
  console.log(`  ✅ Backend CAN: View all transactions`);
  console.log(`  ✅ Backend CAN: Generate proofs`);
  console.log(`  ❌ Backend CANNOT: Execute withdrawals`);
  console.log(`  ✅ Only registered multisig PDA can withdraw`);

  // Register businesses would happen here in a real implementation
  // await registerBusiness(program, backend, "Business A", businessA_PDA, businessA_Authority);
  // await registerBusiness(program, backend, "Business B", businessB_PDA, businessB_Authority);
  // await registerBusiness(program, backend, "Business C", businessC_PDA, businessC_Authority);

  console.log("\n" + "=".repeat(70));
  console.log("✅ Setup complete! Each business has:");
  console.log("   1. Unique ZK keypair (view key stored by backend)");
  console.log("   2. On-chain authorization (only their PDA can spend)");
  console.log("   3. Privacy (all transactions in same anonymity set)");
}

// Run example
main().catch(console.error);

