# Squads Multisig Integration Guide

This guide explains how to integrate Privacy Cash with Squads multisig wallets for multi-tenant systems.

## Architecture Overview

### Problem Statement
Squads has 10,000 business customers, each with their own multisig wallet. Requirements:
- ✅ Backend can VIEW all transactions (for compliance, reporting)
- ❌ Backend CANNOT SPEND any funds
- ✅ Each business can ONLY spend their own UTXOs
- ✅ Withdrawals require multisig approval

### Solution: Two-Key Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Squads Backend Service                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Stores 10,000 ZK View Keys (one per business)              │
│  • Can decrypt all encrypted outputs                         │
│  • Can generate ZK proofs                                    │
│  • Cannot execute transactions                               │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Business A     │  │   Business B     │  │   Business C     │
│   Multisig PDA   │  │   Multisig PDA   │  │   Multisig PDA   │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│ ZK Keypair A     │  │ ZK Keypair B     │  │ ZK Keypair C     │
│ (view key only)  │  │ (view key only)  │  │ (view key only)  │
│                  │  │                  │  │                  │
│ Can only spend   │  │ Can only spend   │  │ Can only spend   │
│ UTXOs created    │  │ UTXOs created    │  │ UTXOs created    │
│ with Keypair A   │  │ with Keypair B   │  │ with Keypair C   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## Security Model

### Two-Layer Protection

**Layer 1: ZK Privacy Layer**
- Each business has a unique ZK keypair (view key)
- Proves knowledge of UTXO secrets
- Provides privacy through encryption

**Layer 2: On-Chain Authorization**
- Each ZK public key is bound to a Solana account (multisig PDA)
- Only the registered PDA can execute withdrawals
- Enforced by smart contract constraints

### Attack Scenarios

#### ❌ Scenario 1: Backend Tries to Steal
```typescript
// Backend has ZK private key
const zkKeypair = getViewKey(businessA);

// Backend generates valid proof ✅
const proof = generateProof(zkKeypair, utxo);

// Backend tries to withdraw
await transactSpl(proof, {
  signer: backendKeypair, // ❌ Wrong! Not the registered PDA
  recipient: backendAddress,
});

// Result: Transaction REJECTED
// Error: UnauthorizedSpender
// Reason: backendKeypair != registeredPDA for this ZK pubkey
```

#### ❌ Scenario 2: Business A Tries to Spend Business B's UTXO
```typescript
// Business A tries to steal Business B's UTXO
await transactSpl(proof, {
  signer: businessA_PDA, // Business A's multisig
  inputPubkeys: [
    businessB_ZkPubkey, // ❌ Business B's ZK pubkey
    emptyUtxoPubkey,
  ],
});

// Result: Transaction REJECTED
// Error: UnauthorizedSpender
// Reason: businessA_PDA != businessB_PDA (registered for Business B)
```

#### ❌ Scenario 3: Mixing UTXOs from Different Businesses
```typescript
// Someone tries to spend UTXOs from both Business A and B in same tx
await transactSpl(proof, {
  inputPubkeys: [
    businessA_ZkPubkey, // Business A's UTXO
    businessB_ZkPubkey, // Business B's UTXO ❌
  ],
});

// Result: Transaction REJECTED
// Error: MixedAuthorizedAccounts
// Reason: Both inputs must belong to same business
```

## Implementation Steps

### Step 1: Generate ZK Keypairs for Each Business

```typescript
import { Keypair } from "./lib/keypair";
import { WasmFactory } from "@lightprotocol/hasher.rs";

async function onboardBusiness(businessId: string, multisigPDA: PublicKey) {
  const lightWasm = await WasmFactory.getInstance();
  
  // Generate unique ZK keypair for this business
  const zkKeypair = Keypair.generateNew(lightWasm);
  
  // Store securely in backend database (encrypted)
  await db.storeViewKey(businessId, {
    multisigPDA: multisigPDA.toString(),
    zkPrivkey: zkKeypair.privkey.toString(16),
    zkPubkey: zkKeypair.pubkey.toString(16),
  });
  
  return zkKeypair;
}
```

### Step 2: Register On-Chain Authorization

```typescript
async function registerBusinessAuthorization(
  program: Program,
  businessId: string,
  multisigPDA: PublicKey,
  zkKeypair: Keypair
) {
  // Convert ZK pubkey to bytes
  const zkPubkeyBytes = Array.from(
    zkKeypair.pubkey.toArray("be", 32)
  );
  
  // Find PDA for authorized spender
  const [authorizedSpenderPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("authorized_spender"), Buffer.from(zkPubkeyBytes)],
    program.programId
  );
  
  // Register: Binds zkPubkey -> multisigPDA
  // This transaction must be signed by the multisig (or via Squads vote)
  await program.methods
    .registerAuthorizedSpender(zkPubkeyBytes as any)
    .accounts({
      authorizedSpender: authorizedSpenderPDA,
      authority: multisigPDA, // The multisig PDA
      systemProgram: SystemProgram.programId,
    })
    .rpc(); // In production, create via Squads transaction
  
  console.log(`✅ ${businessId} authorized on-chain`);
}
```

### Step 3: Deposit Flow

```typescript
async function businessDeposit(
  program: Program,
  businessId: string,
  multisigPDA: PublicKey,
  mint: PublicKey,
  amount: number
) {
  // Get business's ZK keypair from backend
  const zkKeypair = await db.getViewKey(businessId);
  
  // Create output UTXOs with business's ZK pubkey
  const outputUtxo = new Utxo({
    lightWasm,
    amount: new BN(amount),
    keypair: zkKeypair, // Uses business's ZK keypair
    mintAddress: mint.toString(),
  });
  
  // Generate proof (backend can do this)
  const { proof, publicSignals } = await generateProof({
    inputs: [emptyUtxo, emptyUtxo], // No inputs for deposit
    outputs: [outputUtxo, emptyUtxo],
    extAmount: amount, // Positive = deposit
    // ...
  });
  
  // Encrypt outputs with business's ZK pubkey
  const encryptedOutput1 = encryptUtxo(outputUtxo, zkKeypair.pubkey);
  const encryptedOutput2 = encryptUtxo(emptyUtxo, zkKeypair.pubkey);
  
  // Input pubkeys (all zeros for deposit since no inputs)
  const inputPubkeys = [Array(32).fill(0), Array(32).fill(0)];
  
  // Create transaction instruction
  const ix = await program.methods
    .transactSpl(
      proof,
      { extAmount: new BN(amount), fee: new BN(0) },
      encryptedOutput1,
      encryptedOutput2,
      inputPubkeys as any
    )
    .accounts({
      treeAccount: getTreePDA(mint),
      nullifier0: getNullifierPDA(proof.inputNullifiers[0]),
      nullifier1: getNullifierPDA(proof.inputNullifiers[1]),
      globalConfig: getGlobalConfigPDA(),
      signer: multisigPDA, // Multisig signs via Squads
      mint,
      signerTokenAccount: getATA(mint, multisigPDA),
      recipient: multisigPDA,
      recipientTokenAccount: getATA(mint, multisigPDA),
      authorizedSpender0: null, // Not needed for deposits
      authorizedSpender1: null,
      // ...other accounts
    })
    .instruction();
  
  // Submit to Squads for multisig approval
  await squads.createTransaction([ix]);
}
```

### Step 4: Withdrawal Flow

```typescript
async function businessWithdraw(
  program: Program,
  businessId: string,
  multisigPDA: PublicKey,
  inputUtxo: Utxo,
  withdrawAmount: number,
  recipientAddress: PublicKey
) {
  // Backend generates proof (has ZK privkey)
  const zkKeypair = await db.getViewKey(businessId);
  
  const { proof } = await generateProof({
    inputs: [inputUtxo, emptyUtxo],
    outputs: [emptyUtxo, emptyUtxo], // Withdraw everything
    extAmount: -withdrawAmount, // Negative = withdrawal
    recipient: recipientAddress,
    // ...
  });
  
  // CRITICAL: Input pubkeys must match
  const zkPubkeyBytes = Array.from(zkKeypair.pubkey.toArray("be", 32));
  const inputPubkeys = [
    zkPubkeyBytes, // First input: business's UTXO
    Array(32).fill(0), // Second input: empty
  ];
  
  // Find authorized spender PDA
  const [authorizedSpender0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("authorized_spender"), Buffer.from(zkPubkeyBytes)],
    program.programId
  );
  
  // Create withdrawal instruction
  const ix = await program.methods
    .transactSpl(
      proof,
      { extAmount: new BN(-withdrawAmount), fee: new BN(0) },
      encryptedOutput1,
      encryptedOutput2,
      inputPubkeys as any
    )
    .accounts({
      treeAccount: getTreePDA(mint),
      nullifier0: getNullifierPDA(proof.inputNullifiers[0]),
      nullifier1: getNullifierPDA(proof.inputNullifiers[1]),
      globalConfig: getGlobalConfigPDA(),
      signer: multisigPDA, // MUST be the registered multisig PDA
      mint,
      signerTokenAccount: getATA(mint, multisigPDA),
      recipient: recipientAddress,
      recipientTokenAccount: getATA(mint, recipientAddress),
      authorizedSpender0: authorizedSpender0PDA, // Enforces authorization
      authorizedSpender1: null, // Second input is empty
      // ...other accounts
    })
    .instruction();
  
  // Submit to Squads for multisig approval
  // Only after vote passes will the withdrawal execute
  await squads.createTransaction([ix]);
}
```

### Step 5: Backend Event Monitoring

```typescript
async function monitorTransactions(program: Program) {
  // Listen for commitment events
  program.addEventListener("CommitmentData", async (event) => {
    console.log(`New commitment at index ${event.index}`);
    
    // Try to decrypt with each business's view key
    for (const [businessId, viewKey] of allViewKeys) {
      const utxo = await decryptUtxo(
        Buffer.from(event.encrypted_output),
        viewKey.zkPrivkey
      );
      
      if (utxo) {
        // Successfully decrypted - this UTXO belongs to this business
        await db.saveUtxo(businessId, {
          index: event.index,
          commitment: event.commitment,
          amount: utxo.amount.toString(),
          blinding: utxo.blinding.toString(),
          // ... other UTXO data
        });
        
        console.log(`New UTXO for ${businessId}: ${utxo.amount} tokens`);
        break;
      }
    }
  });
}
```

## Key Takeaways

### ✅ What Backend Can Do
- Generate ZK proofs (has view keys)
- Decrypt all encrypted outputs
- Monitor all transactions
- Track balances for all businesses
- Facilitate withdrawals by generating proofs

### ❌ What Backend Cannot Do
- Execute withdrawals (no PDA control)
- Steal funds (requires multisig signature)
- Spend UTXOs without multisig approval

### ✅ What Each Business Can Do
- Deposit funds (via multisig vote)
- Withdraw their own UTXOs (via multisig vote)
- View their own transactions (via backend API)

### ❌ What Each Business Cannot Do
- Spend other businesses' UTXOs
- Execute transactions without multisig vote
- Bypass backend monitoring (all txs visible to backend)

## Security Guarantees

1. **Separation of Concerns**: View key (privacy) and spending key (authorization) are separate
2. **Multi-tenant Isolation**: Each business's UTXOs are cryptographically bound to their PDA
3. **Compliance Ready**: Backend can view all transactions for reporting
4. **Trustless**: Backend cannot steal funds even with full view access
5. **Multisig Control**: All spending requires multisig approval via Squads

## Testing

See `examples/squads_integration.ts` for a complete working example demonstrating:
- Business onboarding and registration
- Deposits with multisig approval
- Withdrawals with authorization checks
- Attack scenarios (backend stealing, cross-business spending)

## Production Checklist

- [ ] Implement proper UTXO encryption (currently using mock)
- [ ] Set up secure view key storage (HSM, encrypted database)
- [ ] Integrate with Squads SDK for transaction creation
- [ ] Add monitoring for all commitment events
- [ ] Set up compliance reporting from decrypted transactions
- [ ] Test authorization with all 10,000 business accounts
- [ ] Audit smart contract for authorization logic
- [ ] Document recovery procedures for lost view keys

