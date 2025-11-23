import { 
  Connection, 
  Keypair, 
  PublicKey, 
  SystemProgram,
  AddressLookupTableProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Load user keypair from script_keypair.json
const anchorDirPath = path.join(__dirname, '..', 'anchor');
const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
const user = Keypair.fromSecretKey(Uint8Array.from(keypairJson));

// Program ID for the zkcash program on devnet
const PROGRAM_ID = new PublicKey('ATZj4jZ4FFzkvAcvk27DW9GRkgSbFnHo49fKKPQXU7VS');
// Fee recipient for devnet
const FEE_RECIPIENT_ACCOUNT = new PublicKey('AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM');
const authority = new PublicKey('97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf');

// USDC mint address on devnet
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
// Relayer address
const RELAYER = new PublicKey('AF8VuwCncKd5ZBnLYYnMjqh4vLch8mjqE75sFe5ZjRFW');

// Configure connection to Solana mainnet-beta
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

/**
 * Create a new address lookup table
 */
async function createALT(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  try {
    console.log('Creating new Address Lookup Table...');
    
    // Create the lookup table with a recent slot
    const recentSlot = await connection.getSlot('confirmed');
    console.log(`Using recent slot: ${recentSlot}`);
    
    let [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: recentSlot,
    });

    console.log(`New ALT address: ${lookupTableAddress.toString()}`);

    // Create transaction to create the lookup table
    const createALTTx = new Transaction().add(lookupTableInst);
    
    try {
      await sendAndConfirmTransaction(connection, createALTTx, [payer]);
      console.log('ALT created successfully');
    } catch (error: any) {
      // Check for slot too old error in transaction logs
      const isSlotTooOld = error.transactionLogs?.some((log: string) => 
        log.includes('is not a recent slot')
      ) || error.message?.includes('not a recent slot');
      
      if (isSlotTooOld) {
        console.log('Slot too old, retrying with newer slot...');
        
        // Try multiple times with increasingly recent slots
        for (let retryAttempt = 1; retryAttempt <= 3; retryAttempt++) {
          try {
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Get the most recent slot possible
            const newerSlot = await connection.getSlot('processed');
            console.log(`Retry attempt ${retryAttempt} with slot: ${newerSlot}`);
            
            [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
              authority: payer.publicKey,
              payer: payer.publicKey,
              recentSlot: newerSlot,
            });
            
            console.log(`New ALT address on retry: ${lookupTableAddress.toString()}`);
            const retryCreateALTTx = new Transaction().add(lookupTableInst);
            await sendAndConfirmTransaction(connection, retryCreateALTTx, [payer]);
            console.log('ALT created successfully on retry');
            break; // Success, exit retry loop
          } catch (retryError: any) {
            const isStillSlotTooOld = retryError.transactionLogs?.some((log: string) => 
              log.includes('is not a recent slot')
            ) || retryError.message?.includes('not a recent slot');
            
            if (isStillSlotTooOld && retryAttempt < 3) {
              console.log(`Retry ${retryAttempt} failed with slot too old, trying again...`);
              continue;
            } else {
              throw retryError; // Re-throw if not slot error or max retries reached
            }
          }
        }
      } else {
        throw error;
      }
    }

    // Wait a moment for the ALT to be available
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Add addresses to the lookup table in batches (max 30 addresses per instruction)
    const batchSize = 30;
    
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      console.log(`Adding batch ${Math.floor(i / batchSize) + 1} with ${batch.length} addresses...`);
      
      const extendInstruction = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: batch,
      });

      const extendTx = new Transaction().add(extendInstruction);
      await sendAndConfirmTransaction(connection, extendTx, [payer]);
      
      // Small delay between batches
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`Successfully added ${addresses.length} addresses to ALT`);
    return lookupTableAddress;
  } catch (error) {
    console.error('Error creating ALT:', error);
    throw error;
  }
}

/**
 * Get all required addresses for the privacy cash protocol
 */
async function getProtocolAddresses(
  programId: PublicKey,
  authority: PublicKey,
  user: PublicKey,
  feeRecipientAccount: PublicKey,
  recipient?: PublicKey
): Promise<PublicKey[]> {
  // Derive common PDAs
  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree')],
    programId
  );

  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('tree_token')],
    programId
  );

  const [globalConfigAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    programId
  );

  // Derive USDC tree account (1 tree per token)
  const [usdcTreeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), USDC_MINT.toBuffer()],
    programId
  );

  // Calculate USDC token accounts
  const usdcTreeAta = await getAssociatedTokenAddress(
    USDC_MINT,
    globalConfigAccount,
    true // allowOwnerOffCurve for PDA
  );

  const usdcFeeRecipientAta = await getAssociatedTokenAddress(
    USDC_MINT,
    feeRecipientAccount,
    true // allowOwnerOffCurve for PDA
  );

  const usdcRelayerAta = await getAssociatedTokenAddress(
    USDC_MINT,
    RELAYER,
    false // relayer is a regular account, not a PDA
  );

  const addresses = [
    programId,
    treeAccount,        // SOL tree
    usdcTreeAccount,    // USDC tree
    treeTokenAccount,
    globalConfigAccount,
    user,
    feeRecipientAccount,
    authority,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    // SPL Token addresses
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    // USDC specific addresses
    USDC_MINT,
    usdcTreeAta,
    usdcFeeRecipientAta,
    // Relayer addresses
    RELAYER,
    usdcRelayerAta,
  ];

  // Add recipient if provided (for withdrawals)
  if (recipient) {
    addresses.push(recipient);
  }

  return addresses;
}

async function main() {
  try {
    console.log('🚀 Creating Address Lookup Table for Privacy Cash Protocol...\n');
    
    console.log(`(Authority): ${authority.toString()}`);
    console.log(`Payer: ${user.publicKey.toString()}`);
    
    // Check wallet balance
    const balance = await connection.getBalance(user.publicKey);
    console.log(`Wallet balance: ${balance / 1e9} SOL`);

    if (balance < 0.01 * 1e9) { // Need at least 0.01 SOL for ALT creation
      console.error('❌ Insufficient balance. Need at least 0.01 SOL for ALT creation.');
      return;
    }
    
    // Derive common PDAs that will always be used
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree')],
      PROGRAM_ID
    );

    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token')],
      PROGRAM_ID
    );

    const [globalConfigAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID
    );

    // Derive USDC tree account (1 tree per token)
    const [usdcTreeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), USDC_MINT.toBuffer()],
      PROGRAM_ID
    );

    // Create dummy nullifier and commitment PDAs for ALT creation
    const dummyBytes = new Array(32).fill(0);
    
    const [nullifier0PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier0"), Buffer.from(dummyBytes)],
      PROGRAM_ID
    );
    
    const [nullifier1PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier1"), Buffer.from(dummyBytes)],
      PROGRAM_ID
    );
    
    const [commitment0PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment0"), Buffer.from(dummyBytes)],
      PROGRAM_ID
    );
    
    const [commitment1PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment1"), Buffer.from(dummyBytes)],
      PROGRAM_ID
    );

    console.log('\n📋 Protocol addresses to include in ALT:');
    console.log(`- Program ID: ${PROGRAM_ID.toString()}`);
    console.log(`- SOL Tree Account: ${treeAccount.toString()}`);
    console.log(`- USDC Tree Account: ${usdcTreeAccount.toString()}`);
    console.log(`- Tree Token Account: ${treeTokenAccount.toString()}`);
    console.log(`- Global Config Account: ${globalConfigAccount.toString()}`);
    console.log(`- Fee Recipient: ${FEE_RECIPIENT_ACCOUNT.toString()}`);
    console.log(`- (Authority): ${authority.toString()}`);
    console.log(`- Payer: ${user.publicKey.toString()}`);
    console.log(`- System Program: 11111111111111111111111111111111`);
    console.log(`- Compute Budget Program: ComputeBudget111111111111111111111111111111`);
    console.log(`- Example Nullifier PDAs: ${nullifier0PDA.toString()}, ${nullifier1PDA.toString()}`);
    console.log(`- Example Commitment PDAs: ${commitment0PDA.toString()}, ${commitment1PDA.toString()}`);

    // Calculate USDC addresses to display
    const usdcTreeAta = await getAssociatedTokenAddress(USDC_MINT, globalConfigAccount, true);
    const usdcFeeRecipientAta = await getAssociatedTokenAddress(USDC_MINT, FEE_RECIPIENT_ACCOUNT, true /* allowOwnerOffCurve */);
    const usdcRelayerAta = await getAssociatedTokenAddress(USDC_MINT, RELAYER, false);

    console.log(`\n💵 USDC Token Addresses:`);
    console.log(`- USDC Mint: ${USDC_MINT.toString()}`);
    console.log(`- USDC Tree ATA: ${usdcTreeAta.toString()}`);
    console.log(`- USDC Fee Recipient ATA: ${usdcFeeRecipientAta.toString()}`);
    console.log(`- Relayer: ${RELAYER.toString()}`);
    console.log(`- USDC Relayer ATA: ${usdcRelayerAta.toString()}`);

    // Create comprehensive address list for the protocol
    const protocolAddresses = await getProtocolAddresses(
      PROGRAM_ID,
      authority, // Squad vault as authority
      user.publicKey,
      FEE_RECIPIENT_ACCOUNT
    );

    console.log(`\n📦 Creating ALT with ${protocolAddresses.length} addresses...`);
    
    // Create the ALT
    const lookupTableAddress = await createALT(connection, user, protocolAddresses);
    
    console.log('\n✅ ALT Creation Complete!');
    console.log('='.repeat(80));
    console.log(`🎯 ALT Address: ${lookupTableAddress.toString()}`);
    console.log('='.repeat(80));
    
    console.log('\n📝 Next Steps:');
    console.log('1. Copy the ALT address above');
    console.log('2. Add it to your scripts as a constant:');
    console.log(`   const ALT_ADDRESS = new PublicKey('${lookupTableAddress.toString()}');`);
    console.log('3. Use this ALT in your deposit/withdraw scripts');
    console.log('');
    console.log('⚠️  IMPORTANT: This ALT was created with deploy keypair as payer/authority.');
    console.log('   For production use with Squad multisig, you may want to:');
    console.log('   - Transfer ALT authority to Squad vault if needed');
    console.log('   - Or create ALT through Squad multisig transaction');
    
    console.log('\n💡 Code snippet for your scripts:');
    console.log('```typescript');
    console.log(`// Hardcoded ALT address (created once)`);
    console.log(`const ALT_ADDRESS = new PublicKey('${lookupTableAddress.toString()}');`);
    console.log('');
    console.log('// Use existing ALT instead of creating new one');
    console.log('const lookupTableAccount = await connection.getAddressLookupTable(ALT_ADDRESS);');
    console.log('if (!lookupTableAccount.value) {');
    console.log('  throw new Error("ALT not found. Run create_alt.ts first");');
    console.log('}');
    console.log('```');
    
    // Verify the ALT works
    console.log('\n🔍 Verifying ALT...');
    const altAccount = await connection.getAddressLookupTable(lookupTableAddress);
    if (altAccount.value) {
      console.log(`✅ ALT verified with ${altAccount.value.state.addresses.length} addresses`);
      console.log('📊 ALT is ready to use!');
    } else {
      console.log('❌ ALT verification failed');
    }
    
  } catch (error: any) {
    console.error('❌ Error creating ALT:', error);
  }
}

console.log('Privacy Cash Protocol - ALT Creator (Squad Integration)');
console.log('====================================================\n');

// Run the ALT creation
main(); 